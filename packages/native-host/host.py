#!/usr/bin/env python3
"""savemedia native messaging host.

Runs the user's own locally installed yt-dlp and ffmpeg on request from the
browser extension. This host never bundles, downloads, or installs those
tools; it only locates binaries that the user has already installed.
Content that yt-dlp reports as DRM protected is refused with the failure
code ``drm_protected``.

Protocol: 4-byte native-endian uint32 length prefix followed by UTF-8 JSON,
in both directions, over stdin and stdout. Only protocol frames are ever
written to stdout.
"""

import glob
import json
import os
import re
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time
from typing import Any, Dict, List, Optional

HOST_VERSION = "1.0.0"
PROTOCOL_VERSION = 1
DOWNLOAD_TIMEOUT_SECONDS = 30 * 60
KILL_GRACE_SECONDS = 3.0
PROGRESS_MIN_INTERVAL = 0.25

ALLOWED_QUALITIES = ("best", "1080", "720", "480")
ALLOWED_COOKIE_BROWSERS = ("chrome", "chromium", "edge", "firefox", "brave")

FAILURE_CODES = (
    "ytdlp_missing",
    "ffmpeg_missing",
    "drm_protected",
    "unsupported_url",
    "login_required",
    "geo_restricted",
    "network",
    "timeout",
    "cancelled",
    "invalid_request",
    "unknown",
)

# ---------------------------------------------------------------------------
# Logging (never to stdout, never cookies)
# ---------------------------------------------------------------------------


def _log_path() -> str:
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        return os.path.join(home, "Library", "Logs", "savemedia-host.log")
    state = os.environ.get("XDG_STATE_HOME") or os.path.join(home, ".local", "state")
    return os.path.join(state, "savemedia", "host.log")


_log_lock = threading.Lock()
_log_file = None


def log(message: str) -> None:
    global _log_file
    with _log_lock:
        try:
            if _log_file is None:
                path = _log_path()
                os.makedirs(os.path.dirname(path), exist_ok=True)
                _log_file = open(path, "a", encoding="utf-8")
            stamp = time.strftime("%Y-%m-%d %H:%M:%S")
            _log_file.write("%s %s\n" % (stamp, message))
            _log_file.flush()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Framing
# ---------------------------------------------------------------------------

_stdout_lock = threading.Lock()
_stdout = sys.stdout.buffer
_stdin = sys.stdin.buffer


def send(message: Dict[str, Any]) -> None:
    data = json.dumps(message, ensure_ascii=False).encode("utf-8")
    with _stdout_lock:
        _stdout.write(struct.pack("@I", len(data)))
        _stdout.write(data)
        _stdout.flush()


def read_message() -> Optional[Dict[str, Any]]:
    header = _stdin.read(4)
    if not header or len(header) < 4:
        return None
    (length,) = struct.unpack("@I", header)
    if length == 0:
        return {}
    body = b""
    while len(body) < length:
        chunk = _stdin.read(length - len(body))
        if not chunk:
            return None
        body += chunk
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return {"type": "__malformed__"}
    if not isinstance(parsed, dict):
        return {"type": "__malformed__"}
    return parsed


def send_failed(msg_id: str, code: str, message: str) -> None:
    if code not in FAILURE_CODES:
        code = "unknown"
    send({"type": "failed", "id": msg_id, "code": code, "message": message})


# ---------------------------------------------------------------------------
# Tool discovery (locate only, never install)
# ---------------------------------------------------------------------------


def _candidate_dirs() -> List[str]:
    home = os.path.expanduser("~")
    dirs = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        os.path.join(home, ".local", "bin"),
    ]
    dirs.extend(sorted(glob.glob(os.path.join(home, "Library", "Python", "*", "bin"))))
    return dirs


def find_tool(name: str) -> Optional[str]:
    found = shutil.which(name)
    if found:
        return found
    for directory in _candidate_dirs():
        candidate = os.path.join(directory, name)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def tool_version(path: Optional[str], args: List[str], pattern: str) -> Optional[str]:
    if not path:
        return None
    try:
        out = subprocess.run(
            [path] + args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=15,
            check=False,
        ).stdout.decode("utf-8", "replace")
    except Exception as exc:
        log("version probe failed for %s: %s" % (path, exc))
        return None
    match = re.search(pattern, out)
    return match.group(1) if match else (out.strip().splitlines()[0] if out.strip() else None)


def tool_info(name: str) -> Dict[str, Any]:
    path = find_tool(name)
    if name == "yt-dlp":
        version = tool_version(path, ["--version"], r"(\d{4}\.\d{2}\.\d{2}\S*)")
    else:
        version = tool_version(path, ["-version"], r"ffmpeg version (\S+)")
    return {"found": path is not None, "version": version, "path": path}


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def default_output_dir() -> str:
    return os.path.join(os.path.expanduser("~"), "Downloads")


def validate_output_dir(value: Any) -> Optional[str]:
    """Return a real path if value is an existing directory under HOME."""
    if value is None:
        value = default_output_dir()
    if not isinstance(value, str) or not value:
        return None
    home = os.path.realpath(os.path.expanduser("~"))
    real = os.path.realpath(os.path.expanduser(value))
    if not os.path.isdir(real):
        return None
    if real != home and not real.startswith(home + os.sep):
        return None
    return real


def _signal_group(proc: "subprocess.Popen[bytes]", sig: int) -> bool:
    """Signal the whole process group of a job (yt-dlp plus its ffmpeg child)."""
    try:
        os.killpg(proc.pid, sig)
        return True
    except ProcessLookupError:
        return False
    except Exception:
        try:
            proc.send_signal(sig)
            return True
        except Exception:
            return False


def validate_page_url(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    return re.fullmatch(r"https?://\S+", value, re.IGNORECASE) is not None


def format_for_quality(quality: str) -> str:
    if quality == "best":
        return "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
    return (
        "bestvideo[height<=%s][ext=mp4]+bestaudio[ext=m4a]/best[height<=%s]/best"
        % (quality, quality)
    )


# ---------------------------------------------------------------------------
# Error classification from yt-dlp stderr
# ---------------------------------------------------------------------------


def classify_stderr(text: str, page_url: str = "") -> str:
    # yt-dlp echoes the page URL in most ERROR lines; strip it so words in
    # the URL (or the title) cannot steer classification.
    if page_url:
        text = text.replace(page_url, "")
    lower = text.lower()
    if re.search(r"\bdrm\b", lower):
        return "drm_protected"
    if "unsupported url" in lower:
        return "unsupported_url"
    if re.search(r"\b(login|log in|sign in|private|age)\b", lower):
        return "login_required"
    if (
        "available in your country" in lower
        or "from your location" in lower
        or re.search(r"\bgeo", lower)
    ):
        return "geo_restricted"
    if re.search(r"\b(connection|timed out|timeout|network|unable to download)\b", lower):
        return "network"
    if re.search(r"http error 5\d\d", lower):
        return "network"
    return "unknown"


def last_error_line(text: str) -> str:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    for line in reversed(lines):
        if line.lower().startswith("error"):
            return line[:500]
    return (lines[-1] if lines else "yt-dlp failed")[:500]


# ---------------------------------------------------------------------------
# Download jobs
# ---------------------------------------------------------------------------


def _to_int(value: str) -> Optional[int]:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _to_float(value: str) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


class Job:
    def __init__(self, msg_id: str, request: Dict[str, Any]) -> None:
        self.id = msg_id
        self.request = request
        self.process = None  # type: Optional[subprocess.Popen]
        self.cancelled = threading.Event()
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self.run, name="job-" + msg_id, daemon=True)

    def start(self) -> None:
        self.thread.start()

    def cancel(self) -> None:
        self.cancelled.set()
        with self.lock:
            proc = self.process
        if proc is None or proc.poll() is not None:
            return
        if not _signal_group(proc, signal.SIGTERM):
            return
        deadline = time.time() + KILL_GRACE_SECONDS
        while time.time() < deadline:
            if proc.poll() is not None:
                return
            time.sleep(0.05)
        _signal_group(proc, signal.SIGKILL)

    def run(self) -> None:
        try:
            self._run()
        except Exception as exc:
            log("job %s crashed: %r" % (self.id, exc))
            send_failed(self.id, "unknown", "internal host error: %s" % exc)
        finally:
            _jobs_remove(self.id)

    def _run(self) -> None:
        req = self.request
        page_url = req.get("pageUrl")
        if not validate_page_url(page_url):
            send_failed(self.id, "invalid_request", "pageUrl must use http or https")
            return
        quality = req.get("quality", "best")
        if quality not in ALLOWED_QUALITIES:
            send_failed(self.id, "invalid_request", "quality must be one of %s" % ", ".join(ALLOWED_QUALITIES))
            return
        cookies = req.get("cookiesFromBrowser")
        if cookies is not None and cookies not in ALLOWED_COOKIE_BROWSERS:
            send_failed(self.id, "invalid_request", "cookiesFromBrowser is not a supported browser name")
            return
        output_dir = validate_output_dir(req.get("outputDir"))
        if output_dir is None:
            send_failed(self.id, "invalid_request", "outputDir must be an existing directory inside the home directory")
            return

        ytdlp = find_tool("yt-dlp")
        if not ytdlp:
            send_failed(self.id, "ytdlp_missing", "yt-dlp was not found on this machine; install it yourself, this host never installs tools")
            return
        ffmpeg = find_tool("ffmpeg")
        if not ffmpeg:
            send_failed(self.id, "ffmpeg_missing", "ffmpeg was not found on this machine; install it yourself, this host never installs tools")
            return
        if self.cancelled.is_set():
            send_failed(self.id, "cancelled", "cancelled before start")
            return

        cmd = [
            ytdlp,
            "--no-playlist",
            "--newline",
            "--no-continue",
            # --print implies quiet mode, which would also suppress the
            # progress template and the [Merger] lines this host parses.
            "--no-quiet",
            "--progress",
            "--ffmpeg-location", os.path.dirname(ffmpeg),
            "-f", format_for_quality(quality),
            "-o", "%(title).80s [%(id)s].%(ext)s",
            "-P", output_dir,
            "--print", "after_move:filepath",
            "--progress-template",
            "download:SMPROG %(progress.downloaded_bytes)s %(progress.total_bytes)s "
            "%(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s",
        ]
        if cookies:
            cmd += ["--cookies-from-browser", cookies]
        cmd.append(page_url)

        log("job %s start quality=%s cookies=%s outputDir=%s" % (self.id, quality, "yes" if cookies else "no", output_dir))
        self._progress(phase="probing")

        try:
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=output_dir,
                # Own process group so cancel/timeout also reach the ffmpeg
                # child yt-dlp spawns for merging.
                start_new_session=True,
            )
        except Exception as exc:
            send_failed(self.id, "unknown", "could not start yt-dlp: %s" % exc)
            return
        with self.lock:
            self.process = proc
        if self.cancelled.is_set():
            self.cancel()

        stderr_chunks = []  # type: List[bytes]

        def drain_stderr() -> None:
            try:
                for raw in proc.stderr:
                    stderr_chunks.append(raw)
            except Exception:
                pass

        stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
        stderr_thread.start()

        timer = threading.Timer(DOWNLOAD_TIMEOUT_SECONDS, self._timeout)
        timer.daemon = True
        timer.start()
        self.timed_out = False

        phase = "downloading"
        last_path = None  # type: Optional[str]
        destinations = []  # type: List[str]
        try:
            for raw in proc.stdout:
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                if not line:
                    continue
                if line.startswith("SMPROG "):
                    self._parse_progress(line, phase)
                    continue
                if line.startswith("[Merger]") or line.startswith("[ExtractAudio]") or line.startswith("[FixupM"):
                    phase = "merging"
                    self._progress(phase=phase, force=True)
                    continue
                if line.startswith("[download] Destination: "):
                    destinations.append(line[len("[download] Destination: "):])
                    continue
                if line.startswith("["):
                    continue
                last_path = line
        finally:
            timer.cancel()
        proc.wait()
        stderr_thread.join(timeout=5)
        stderr_text = b"".join(stderr_chunks).decode("utf-8", "replace")

        if self.cancelled.is_set() or self.timed_out:
            self._remove_partials(destinations, output_dir)
        if self.cancelled.is_set():
            send_failed(self.id, "cancelled", "download cancelled")
            return
        if self.timed_out:
            send_failed(self.id, "timeout", "download exceeded %d minutes" % (DOWNLOAD_TIMEOUT_SECONDS // 60))
            return
        if proc.returncode != 0 or not last_path:
            code = classify_stderr(stderr_text, page_url)
            message = last_error_line(stderr_text)
            if code == "drm_protected":
                message = "this content is DRM protected and is refused"
            log("job %s failed code=%s rc=%s" % (self.id, code, proc.returncode))
            send_failed(self.id, code, message)
            return
        if not os.path.isabs(last_path):
            last_path = os.path.join(output_dir, last_path)
        size = None
        try:
            size = os.path.getsize(last_path)
        except OSError:
            pass
        log("job %s complete bytes=%s" % (self.id, size))
        send({
            "type": "complete",
            "id": self.id,
            "filename": os.path.basename(last_path),
            "path": last_path,
            "bytes": size,
        })

    @staticmethod
    def _remove_partials(destinations: List[str], output_dir: str) -> None:
        for dest in destinations:
            if not os.path.isabs(dest):
                dest = os.path.join(output_dir, dest)
            candidates = glob.glob(glob.escape(dest) + ".part*") + [dest + ".ytdl"]
            # Intermediate per-format files (name.f137.mp4) of an interrupted merge.
            if re.search(r"\.f\d+\.\w+$", dest):
                candidates.append(dest)
            for candidate in candidates:
                try:
                    if os.path.isfile(candidate):
                        os.remove(candidate)
                except OSError:
                    pass

    def _timeout(self) -> None:
        self.timed_out = True
        with self.lock:
            proc = self.process
        if proc is not None and proc.poll() is None:
            _signal_group(proc, signal.SIGTERM)
            time.sleep(KILL_GRACE_SECONDS)
            if proc.poll() is None:
                _signal_group(proc, signal.SIGKILL)

    _last_progress_at = 0.0

    def _progress(self, phase: str, downloaded=None, total=None, percent=None, speed=None, eta=None, force=False) -> None:
        now = time.monotonic()
        if not force and now - self._last_progress_at < PROGRESS_MIN_INTERVAL:
            return
        self._last_progress_at = now
        send({
            "type": "progress",
            "id": self.id,
            "phase": phase,
            "downloadedBytes": downloaded,
            "totalBytes": total,
            "percent": percent,
            "speedBytesPerSec": speed,
            "etaSeconds": eta,
        })

    def _parse_progress(self, line: str, phase: str) -> None:
        parts = line.split()
        # SMPROG downloaded total total_estimate speed eta
        if len(parts) < 6:
            return
        downloaded = _to_int(parts[1])
        total = _to_int(parts[2])
        if total is None:
            total = _to_int(parts[3])
        speed = _to_float(parts[4])
        eta = _to_int(parts[5])
        percent = None
        if downloaded is not None and total:
            percent = round(min(100.0, downloaded * 100.0 / total), 2)
        self._progress(phase, downloaded, total, percent, speed, eta)


_jobs = {}  # type: Dict[str, Job]
_jobs_lock = threading.Lock()


def _jobs_remove(msg_id: str) -> None:
    with _jobs_lock:
        _jobs.pop(msg_id, None)


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------


_tool_cache = {}  # type: Dict[str, Dict[str, Any]]
_tool_cache_lock = threading.Lock()


def cached_tool_info(name: str) -> Dict[str, Any]:
    with _tool_cache_lock:
        info = _tool_cache.get(name)
    if info is None:
        info = tool_info(name)
        with _tool_cache_lock:
            _tool_cache[name] = info
    return info


def handle_ping() -> None:
    # Version probes spawn processes; keep them off the dispatch thread so a
    # cancel arriving meanwhile is handled promptly.
    def run() -> None:
        send({
            "type": "pong",
            "hostVersion": HOST_VERSION,
            "protocolVersion": PROTOCOL_VERSION,
            "ytdlp": cached_tool_info("yt-dlp"),
            "ffmpeg": cached_tool_info("ffmpeg"),
            "outputDir": default_output_dir(),
        })
    threading.Thread(target=run, name="ping", daemon=True).start()


def handle_download(message: Dict[str, Any]) -> None:
    msg_id = message.get("id")
    if not isinstance(msg_id, str) or not msg_id:
        send_failed("", "invalid_request", "download requires a string id")
        return
    with _jobs_lock:
        if msg_id in _jobs:
            send_failed(msg_id, "invalid_request", "a download with this id is already running")
            return
        job = Job(msg_id, message)
        _jobs[msg_id] = job
    job.start()


def handle_cancel(message: Dict[str, Any]) -> None:
    msg_id = message.get("id")
    if not isinstance(msg_id, str) or not msg_id:
        send_failed("", "invalid_request", "cancel requires a string id")
        return
    with _jobs_lock:
        job = _jobs.get(msg_id)
    if job is None:
        send_failed(msg_id, "invalid_request", "no running download with this id")
        return
    threading.Thread(target=job.cancel, daemon=True).start()


def dispatch(message: Dict[str, Any]) -> None:
    kind = message.get("type")
    raw_id = message.get("id")
    msg_id = raw_id if isinstance(raw_id, str) else ""
    if kind == "ping":
        handle_ping()
    elif kind == "download":
        handle_download(message)
    elif kind == "cancel":
        handle_cancel(message)
    elif kind == "__malformed__":
        send_failed("", "invalid_request", "message is not a JSON object")
    else:
        send_failed(msg_id, "invalid_request", "unknown message type: %r" % (kind,))


def main() -> int:
    log("host started pid=%d version=%s" % (os.getpid(), HOST_VERSION))
    while True:
        try:
            message = read_message()
        except Exception as exc:
            log("read error: %r" % exc)
            break
        if message is None:
            break
        try:
            dispatch(message)
        except Exception as exc:
            log("dispatch error: %r" % exc)
            raw_id = message.get("id")
            send_failed(raw_id if isinstance(raw_id, str) else "", "unknown", "internal host error")
    with _jobs_lock:
        jobs = list(_jobs.values())
    for job in jobs:
        job.cancel()
    log("host exiting")
    return 0


if __name__ == "__main__":
    sys.exit(main())
