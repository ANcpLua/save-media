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
import tempfile
import threading
import time
from contextlib import contextmanager
from typing import Any, Dict, Iterator, List, Optional, Tuple

HOST_VERSION = "1.3.0"
# What the extension checks before it uses this helper (NATIVE_PROTOCOL_VERSION in the extension's
# types/native.ts). 2: a download may carry allowWithoutCookies, a failure may carry httpStatus, and
# failures are classified from yt-dlp's format data and exit status. Raise both numbers together when a
# request or an answer changes its meaning.
PROTOCOL_VERSION = 2
# A run is ended when yt-dlp goes quiet, never because of how long it has
# taken: a large file on a slow connection is progress, not a fault. Every
# byte yt-dlp writes to stdout or stderr counts as a sign of life. ffmpeg
# prints nothing while it joins the tracks, so that step gets a longer window.
STALL_TIMEOUT_SECONDS = 5 * 60
MERGE_STALL_TIMEOUT_SECONDS = 60 * 60
KILL_GRACE_SECONDS = 3.0
PROGRESS_MIN_INTERVAL = 0.25
# Native messaging caps: the browser accepts at most 1 MB from a host; a host
# accepts up to 4 GB by spec. Nothing this host receives is ever more than a
# few hundred bytes, so a smaller inbound cap protects against a corrupt
# frame header making read_message wait for gigabytes that never arrive.
MAX_INBOUND_BYTES = 1024 * 1024
MAX_OUTBOUND_BYTES = 1024 * 1024
LOG_MAX_BYTES = 2 * 1024 * 1024
LOG_BACKUPS = 3

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
    "already_saved",
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


def _rotate_log(path: str) -> None:
    """Keep the log bounded: host.log -> host.log.1 -> ... -> host.log.N."""
    try:
        if os.path.getsize(path) < LOG_MAX_BYTES:
            return
    except OSError:
        return
    for index in range(LOG_BACKUPS, 0, -1):
        older = "%s.%d" % (path, index)
        newer = path if index == 1 else "%s.%d" % (path, index - 1)
        if os.path.exists(older):
            os.remove(older)
        if os.path.exists(newer):
            os.rename(newer, older)


def log(message: str) -> None:
    global _log_file
    with _log_lock:
        try:
            if _log_file is None:
                path = _log_path()
                os.makedirs(os.path.dirname(path), exist_ok=True)
                _rotate_log(path)
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


def encode_frame(message: Dict[str, Any]) -> bytes:
    data = json.dumps(message, ensure_ascii=False).encode("utf-8")
    if len(data) > MAX_OUTBOUND_BYTES:
        # The browser would drop the connection on an oversize frame. Only a
        # runaway error message could get here; keep the shape, cut the text.
        trimmed = dict(message)
        trimmed["message"] = str(message.get("message", ""))[:1000] + " [truncated]"
        data = json.dumps(trimmed, ensure_ascii=False).encode("utf-8")
    return data


def send(message: Dict[str, Any]) -> None:
    data = encode_frame(message)
    with _stdout_lock:
        _stdout.write(struct.pack("@I", len(data)))
        _stdout.write(data)
        _stdout.flush()


def read_message() -> Optional[Dict[str, Any]]:
    return read_frame(_stdin)


def read_frame(stream: Any) -> Optional[Dict[str, Any]]:
    """One length-prefixed JSON object; None on EOF or a frame that cannot be trusted."""
    header = stream.read(4)
    if not header or len(header) < 4:
        return None
    (length,) = struct.unpack("@I", header)
    if length == 0:
        return {}
    if length > MAX_INBOUND_BYTES:
        log("inbound frame of %d bytes exceeds the %d byte cap; closing" % (length, MAX_INBOUND_BYTES))
        return None
    body = b""
    while len(body) < length:
        chunk = stream.read(length - len(body))
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


def failure_frame(msg_id: str, code: str, message: str, http_status: Optional[int] = None) -> Dict[str, Any]:
    if code not in FAILURE_CODES:
        code = "unknown"
    frame = {"type": "failed", "id": msg_id, "code": code, "message": message}  # type: Dict[str, Any]
    if http_status is not None:
        frame["httpStatus"] = http_status
    return frame


def send_failed(msg_id: str, code: str, message: str) -> None:
    send(failure_frame(msg_id, code, message))


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


DAY_PARTS = ("1 Night", "2 Morning", "3 Afternoon", "4 Evening")


def timestamped_output_template(now: Optional[time.struct_time] = None) -> str:
    """Same layout as the extension's timestampedPath: a part-of-day folder
    and a file named after the start time. No dashes in the time, because
    Finder search reads "07-11-38" as a date and finds nothing."""
    t = now or time.localtime()
    day = time.strftime("%Y-%m-%d", t)
    return "%s %s/%s_%s.%%(ext)s" % (day, DAY_PARTS[t.tm_hour // 6], day, time.strftime("%H%M%S", t))


@contextmanager
def reserve_output_template(output_dir: str) -> Iterator[str]:
    """Give concurrent helper processes distinct output names for the same second."""
    original, extension = os.path.splitext(timestamped_output_template())
    suffix = 0
    while True:
        stem = original if suffix == 0 else "%s (%d)" % (original, suffix)
        suffix += 1
        marker = os.path.join(output_dir, ".savemedia-reserve-" + os.path.basename(stem))
        try:
            os.mkdir(marker, 0o700)
        except FileExistsError:
            continue
        try:
            pattern = glob.escape(os.path.join(output_dir, stem)) + ".*"
            if next(glob.iglob(pattern), None) is None:
                yield stem + extension
                return
        finally:
            os.rmdir(marker)


def download_archive_path() -> str:
    """yt-dlp records every finished video (site + video id) here and skips
    it from then on, so the local downloader never saves a video twice."""
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        base = os.path.join(home, "Library", "Application Support", "savemedia")
    else:
        base = os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.join(home, ".local", "state"), "savemedia")
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, "download-archive.txt")


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
# Failure classes from yt-dlp's own structured answers
# ---------------------------------------------------------------------------

# yt-dlp exits 101 when it stops a run on purpose. With this host's flags only
# an archive hit does that (--break-on-existing).
EXIT_EXISTING = 101


def last_error_line(text: str) -> str:
    """The last line yt-dlp wrote at its ERROR level, or its last line at all."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    for line in reversed(lines):
        if line.startswith("ERROR"):
            return line[:500]
    return (lines[-1] if lines else "yt-dlp failed")[:500]


def http_status(final_line: str) -> Optional[int]:
    """The status number in yt-dlp's HTTPError token ("HTTP Error 403: ..."), read from the final ERROR line only."""
    match = re.search(r"\bHTTP Error (\d{3})\b", final_line)
    if not match:
        return None
    status = int(match.group(1))
    return status if 100 <= status <= 599 else None


def drm_verdict(info: Optional[Dict[str, Any]]) -> bool:
    """True only when yt-dlp's own format data says DRM and no playable video format is left.

    Words in a title, a warning or an error line never decide this.
    """
    if not isinstance(info, dict) or info.get("_type", "video") != "video":
        return False
    if info.get("_has_drm") is not True:  # some format has has_drm True, not "maybe"
        return False
    formats = info.get("formats") or []
    playable = [f for f in formats
                if isinstance(f, dict) and f.get("has_drm") is not True and f.get("vcodec") != "none"]
    return not playable


def classify_failure(stderr_text: str, info: Optional[Dict[str, Any]]) -> Tuple[str, str, Optional[int]]:
    """(code, message, httpStatus) for a failed run.

    DRM comes from yt-dlp's format data; everything else is "unknown" with
    yt-dlp's final error line as technical detail and the HTTP status that
    line names, if any.
    """
    final = last_error_line(stderr_text)
    if drm_verdict(info):
        return "drm_protected", "yt-dlp reports DRM on every video format of this page", None
    return "unknown", final, http_status(final)


# ---------------------------------------------------------------------------
# Browser cookie stores
# ---------------------------------------------------------------------------


def cookie_store_roots(browser: str, home: Optional[str] = None, env: Optional[Dict[str, str]] = None,
                       platform: Optional[str] = None) -> Optional[List[str]]:
    """The directories under which this browser keeps its profiles, or None on a platform this host does not know."""
    home = home or os.path.expanduser("~")
    env = os.environ if env is None else env  # type: ignore[assignment]
    platform = platform or sys.platform
    chromium_names = {
        "chrome": ("Google/Chrome", "google-chrome", "Google\\Chrome\\User Data"),
        "chromium": ("Chromium", "chromium", "Chromium\\User Data"),
        "edge": ("Microsoft Edge", "microsoft-edge", "Microsoft\\Edge\\User Data"),
        "brave": ("BraveSoftware/Brave-Browser", "BraveSoftware/Brave-Browser", "BraveSoftware\\Brave-Browser\\User Data"),
    }
    if platform == "darwin":
        support = os.path.join(home, "Library", "Application Support")
        if browser == "firefox":
            return [os.path.join(support, "Firefox", "Profiles")]
        return [os.path.join(support, chromium_names[browser][0])] if browser in chromium_names else None
    if platform.startswith("linux"):
        config = env.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
        if browser == "firefox":
            return [
                os.path.join(home, ".mozilla", "firefox"),
                os.path.join(config, "mozilla", "firefox"),
                os.path.join(home, "snap", "firefox", "common", ".mozilla", "firefox"),
                os.path.join(home, ".var", "app", "org.mozilla.firefox", ".mozilla", "firefox"),
                os.path.join(home, ".var", "app", "org.mozilla.firefox", "config", "mozilla", "firefox"),
            ]
        return [os.path.join(config, chromium_names[browser][1])] if browser in chromium_names else None
    if platform in ("win32", "cygwin"):
        local = env.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
        roaming = env.get("APPDATA") or os.path.join(home, "AppData", "Roaming")
        if browser == "firefox":
            return [
                os.path.join(roaming, "Mozilla", "Firefox", "Profiles"),
                os.path.join(local, "Packages", "Mozilla.Firefox_n80bbvh6b1yt2", "LocalCache", "Roaming", "Mozilla", "Firefox", "Profiles"),
            ]
        return [os.path.join(local, chromium_names[browser][2])] if browser in chromium_names else None
    return None


def cookie_store_exists(browser: str, home: Optional[str] = None, env: Optional[Dict[str, str]] = None,
                        platform: Optional[str] = None) -> bool:
    """Whether the browser has a cookie database on this machine: a look at the file system.

    False only when every place the browser keeps its profiles was looked at
    and none holds a cookie database. On a platform this host does not know
    the answer is True, and yt-dlp finds out itself.
    """
    roots = cookie_store_roots(browser, home, env, platform)
    if roots is None:
        return True
    name = "cookies.sqlite" if browser == "firefox" else "Cookies"
    for root in roots:
        if not os.path.isdir(root):
            continue
        base_depth = root.rstrip(os.sep).count(os.sep)
        for current, dirs, files in os.walk(root):
            if name in files:
                return True
            # <root>/<profile>/Network/Cookies is the deepest a profile keeps it.
            if current.count(os.sep) - base_depth >= 3:
                dirs[:] = []
    return False


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
        # The extension's "Auto" cookie setting names the running browser and allows a run without cookies.
        # When that browser has no cookie database here, yt-dlp is not asked to read one.
        if cookies and req.get("allowWithoutCookies") is True and not cookie_store_exists(cookies):
            log("job %s cookie store of the selected browser not found; running without cookies" % self.id)
            cookies = None
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

        # A native port owns one job. Keep its fragments and unfinished merges
        # in a job-specific directory on the same filesystem as the result.
        with tempfile.TemporaryDirectory(prefix=".savemedia-", dir=output_dir) as staging:
            with reserve_output_template(output_dir) as template:
                result = self._download(page_url, quality, cookies, output_dir, staging, ytdlp, ffmpeg, template)
        send(result)

    def _download(self, page_url: str, quality: str, cookies: Optional[str], output_dir: str,
                  staging: str, ytdlp: str, ffmpeg: str, template: str) -> Dict[str, Any]:
        cmd = [
            ytdlp,
            "--no-playlist",
            "--newline",
            "--no-continue",
            "--abort-on-unavailable-fragments",
            # yt-dlp would otherwise send a made-up X-Forwarded-For address for
            # sites it knows to be limited to some countries. The helper asks
            # as the user's own connection does and takes the server's answer.
            "--no-geo-bypass",
            "--no-cookies",
            # --print implies quiet mode, which would also suppress the
            # progress template and the [Merger] lines this host parses.
            "--no-quiet",
            "--progress",
            "--ffmpeg-location", os.path.dirname(ffmpeg),
            "-f", format_for_quality(quality),
            # yt-dlp reads a "Home" yt-dlp.conf from its home path, so the home
            # path is the job's fresh, private staging directory and never the
            # Downloads folder, where any web page can drop a file. The output
            # template is absolute, so the result still lands in output_dir.
            # The user's own yt-dlp configuration keeps working.
            "-o", os.path.join(output_dir, template),
            "--download-archive", download_archive_path(),
            # An archive hit ends the run with exit status 101 instead of a line of text.
            "--break-on-existing",
            "-P", staging,
            "-P", "temp:" + staging,
            "--print", "after_move:filepath",
            "--progress-template",
            "download:SMPROG %(progress.downloaded_bytes)s %(progress.total_bytes)s "
            "%(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s",
        ]
        cookie_flags = ["--cookies-from-browser", cookies] if cookies else ["--no-cookies-from-browser"]
        cmd += cookie_flags
        cmd.extend(["--", page_url])

        log("job %s start quality=%s cookies=%s outputDir=%s" % (self.id, quality, "yes" if cookies else "no", output_dir))
        self._progress(phase="probing")

        try:
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=staging,
                # Own process group so cancel/timeout also reach the ffmpeg
                # child yt-dlp spawns for merging.
                start_new_session=True,
            )
        except Exception as exc:
            return failure_frame(self.id, "unknown", "could not start yt-dlp: %s" % exc)
        with self.lock:
            self.process = proc
        if self.cancelled.is_set():
            self.cancel()

        stderr_chunks = []  # type: List[bytes]

        self.timed_out = False
        self._stall_window = STALL_TIMEOUT_SECONDS
        self._alive()

        def drain_stderr() -> None:
            # Read as the bytes arrive, not line by line: ffmpeg rewrites its
            # progress line without ever ending it.
            try:
                with proc.stderr as stream:
                    while True:
                        chunk = os.read(stream.fileno(), 65536)
                        if not chunk:
                            break
                        self._alive()
                        stderr_chunks.append(chunk)
            except Exception:
                pass

        stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
        stderr_thread.start()

        watching = threading.Event()
        watcher = threading.Thread(target=self._watch, args=(watching,), daemon=True)
        watcher.start()

        phase = "downloading"
        last_path = None  # type: Optional[str]
        try:
            for raw in proc.stdout:
                self._alive()
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                if not line:
                    continue
                if line.startswith("SMPROG "):
                    self._parse_progress(line, phase)
                    continue
                if line.startswith("[Merger]") or line.startswith("[ExtractAudio]") or line.startswith("[FixupM"):
                    phase = "merging"
                    self._stall_window = MERGE_STALL_TIMEOUT_SECONDS
                    self._progress(phase=phase, force=True)
                    continue
                if line.startswith("["):
                    continue
                last_path = line
            proc.wait()
        finally:
            watching.set()
            proc.stdout.close()
        stderr_thread.join(timeout=5)
        stderr_text = b"".join(stderr_chunks).decode("utf-8", "replace")

        if self.cancelled.is_set():
            return failure_frame(self.id, "cancelled", "download cancelled")
        timeout_frame = failure_frame(self.id, "timeout", "yt-dlp printed nothing for %d seconds" % self._stall_window)
        if self.timed_out:
            return timeout_frame
        # A file yt-dlp reports and that is there counts as saved, whatever the exit status:
        # a user's own yt-dlp configuration (such as --max-downloads) must not mislabel it.
        saved = None  # type: Optional[str]
        if last_path and proc.returncode in (0, EXIT_EXISTING):
            candidate = last_path if os.path.isabs(last_path) else os.path.join(output_dir, last_path)
            candidate = os.path.realpath(candidate)
            if os.path.commonpath([candidate, output_dir]) == output_dir and os.path.isfile(candidate):
                saved = candidate
        if saved is None and proc.returncode == EXIT_EXISTING:
            return failure_frame(self.id, "already_saved", "this video is already saved")
        if saved is None and proc.returncode == 0:
            return failure_frame(self.id, "unknown", "yt-dlp finished without a file in the downloads directory")
        if saved is None:
            # Only a failed run is examined further: what yt-dlp itself knows about the page's formats.
            info = self._probe_formats(ytdlp, page_url, cookie_flags, staging, STALL_TIMEOUT_SECONDS)
            if self.cancelled.is_set():
                return failure_frame(self.id, "cancelled", "download cancelled")
            if self.timed_out:
                return timeout_frame
            code, message, status = classify_failure(stderr_text, info)
            log("job %s failed code=%s rc=%s httpStatus=%s" % (self.id, code, proc.returncode, status))
            return failure_frame(self.id, code, message, status)
        last_path = saved
        size = os.path.getsize(last_path)
        if size == 0:
            return failure_frame(self.id, "unknown", "yt-dlp produced an empty file")
        log("job %s complete bytes=%s" % (self.id, size))
        return {
            "type": "complete",
            "id": self.id,
            "filename": os.path.basename(last_path),
            "path": last_path,
            "bytes": size,
        }

    def _probe_formats(self, ytdlp: str, page_url: str, cookie_flags: List[str], staging: str,
                       budget: float) -> Optional[Dict[str, Any]]:
        """yt-dlp's own description of the page, asked for after a failed run.

        The answer can contain cookies and signed addresses. It stays in
        memory and is never logged or written to disk.
        """
        if self.cancelled.is_set() or budget <= 0:
            return None
        cmd = [
            ytdlp, "-J", "--no-playlist", "--ignore-no-formats-error", "--no-geo-bypass", "--no-cookies",
            # The same private home path and working directory as the download run.
            "-P", staging, "-P", "temp:" + staging,
        ] + cookie_flags + ["--", page_url]
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    cwd=staging, start_new_session=True)
        except Exception:
            return None
        with self.lock:
            self.process = proc
        if self.cancelled.is_set():
            self.cancel()
        timer = threading.Timer(max(1.0, budget), self._timeout)
        timer.daemon = True
        timer.start()
        try:
            out, _ = proc.communicate()
        finally:
            timer.cancel()
        info = None  # type: Optional[Dict[str, Any]]
        if proc.returncode == 0:
            try:
                parsed = json.loads(out.decode("utf-8", "replace"))
                info = parsed if isinstance(parsed, dict) else None
            except ValueError:
                info = None
        formats = info.get("formats") if info else None
        log("job %s drm probe rc=%s has_drm=%s formats=%s" % (
            self.id, proc.returncode, bool(info and info.get("_has_drm") is True), len(formats) if isinstance(formats, list) else 0))
        return info

    _last_alive = 0.0
    _stall_window = float(STALL_TIMEOUT_SECONDS)

    def _alive(self) -> None:
        """yt-dlp just wrote something."""
        self._last_alive = time.monotonic()

    def _watch(self, done: threading.Event) -> None:
        """Ends the run once yt-dlp has written nothing for the window of its current step."""
        while not done.wait(min(1.0, self._stall_window / 4.0)):
            if time.monotonic() - self._last_alive > self._stall_window:
                self._timeout()
                return

    def _timeout(self) -> None:
        with self.lock:
            proc = self.process
        # A run that ended by itself in the same moment was not stopped: its result stands.
        if proc is None or proc.poll() is not None:
            return
        self.timed_out = True
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
    for job in jobs:
        job.thread.join(timeout=KILL_GRACE_SECONDS + 1)
    log("host exiting")
    return 0


if __name__ == "__main__":
    sys.exit(main())
