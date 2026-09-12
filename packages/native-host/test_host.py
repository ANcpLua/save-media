#!/usr/bin/env python3
"""Protocol tests for host.py. Run: python3 test_host.py"""

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = os.path.join(HERE, "host.py")


def has_ytdlp() -> bool:
    if shutil.which("yt-dlp"):
        return True
    home = os.path.expanduser("~")
    import glob as _glob
    dirs = ["/opt/homebrew/bin", "/usr/local/bin", os.path.join(home, ".local", "bin")]
    dirs += _glob.glob(os.path.join(home, "Library", "Python", "*", "bin"))
    for d in dirs:
        if os.access(os.path.join(d, "yt-dlp"), os.X_OK):
            return True
    return False


class HostProcess:
    def __init__(self, home: str) -> None:
        env = dict(os.environ)
        env["HOME"] = home
        env.pop("XDG_STATE_HOME", None)
        self.proc = subprocess.Popen(
            [sys.executable, HOST],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )

    def send(self, message) -> None:
        data = json.dumps(message).encode("utf-8")
        self.proc.stdin.write(struct.pack("@I", len(data)) + data)
        self.proc.stdin.flush()

    def recv(self):
        header = self.proc.stdout.read(4)
        if len(header) < 4:
            raise AssertionError("host closed stdout; stderr=%r" % self.proc.stderr.read())
        (length,) = struct.unpack("@I", header)
        return json.loads(self.proc.stdout.read(length).decode("utf-8"))

    def close(self) -> None:
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
        finally:
            if self.proc.poll() is None:
                self.proc.kill()
            self.proc.stdout.close()


class HostProtocolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.home = tempfile.mkdtemp(prefix="savemedia-host-test-")
        os.makedirs(os.path.join(self.home, "Downloads"))
        self.host = HostProcess(self.home)

    def tearDown(self) -> None:
        self.host.close()
        stderr = self.host.proc.stderr.read()
        self.host.proc.stderr.close()
        shutil.rmtree(self.home, ignore_errors=True)
        self.assertEqual(stderr, b"", "host wrote to stderr: %r" % stderr)

    def test_ping_returns_pong_shape(self) -> None:
        self.host.send({"type": "ping"})
        reply = self.host.recv()
        self.assertEqual(reply["type"], "pong")
        self.assertEqual(reply["hostVersion"], "1.0.0")
        self.assertEqual(reply["protocolVersion"], 1)
        for tool in ("ytdlp", "ffmpeg"):
            info = reply[tool]
            self.assertIsInstance(info["found"], bool)
            self.assertIn("version", info)
            self.assertIn("path", info)
            if info["found"]:
                self.assertIsInstance(info["path"], str)
            else:
                self.assertIsNone(info["path"])
        self.assertEqual(reply["outputDir"], os.path.join(self.home, "Downloads"))

    def test_invalid_message_type(self) -> None:
        self.host.send({"type": "bogus", "id": "x1"})
        reply = self.host.recv()
        self.assertEqual(reply, {
            "type": "failed", "id": "x1", "code": "invalid_request",
            "message": reply["message"],
        })

    def test_non_object_message(self) -> None:
        data = b"[1,2,3]"
        self.host.proc.stdin.write(struct.pack("@I", len(data)) + data)
        self.host.proc.stdin.flush()
        reply = self.host.recv()
        self.assertEqual(reply["type"], "failed")
        self.assertEqual(reply["id"], "")
        self.assertEqual(reply["code"], "invalid_request")

    def test_download_rejects_file_url(self) -> None:
        self.host.send({"type": "download", "id": "d1", "pageUrl": "file:///etc/hosts", "quality": "best"})
        reply = self.host.recv()
        self.assertEqual(reply["type"], "failed")
        self.assertEqual(reply["id"], "d1")
        self.assertEqual(reply["code"], "invalid_request")

    def test_download_rejects_output_dir_outside_home(self) -> None:
        self.host.send({
            "type": "download", "id": "d2", "pageUrl": "https://example.invalid/x",
            "quality": "best", "outputDir": "/",
        })
        reply = self.host.recv()
        self.assertEqual(reply["code"], "invalid_request")

    def test_download_rejects_bad_quality(self) -> None:
        self.host.send({"type": "download", "id": "d3", "pageUrl": "https://example.invalid/x", "quality": "4k"})
        reply = self.host.recv()
        self.assertEqual(reply["code"], "invalid_request")

    def test_cancel_unknown_id(self) -> None:
        self.host.send({"type": "cancel", "id": "nope"})
        reply = self.host.recv()
        self.assertEqual(reply["code"], "invalid_request")
        self.assertEqual(reply["id"], "nope")

    @unittest.skipIf(has_ytdlp(), "yt-dlp is installed on this machine")
    def test_download_without_ytdlp_fails_fast(self) -> None:
        self.host.send({"type": "download", "id": "d4", "pageUrl": "https://example.invalid/x", "quality": "best"})
        reply = self.host.recv()
        self.assertEqual(reply["type"], "failed")
        self.assertEqual(reply["id"], "d4")
        self.assertEqual(reply["code"], "ytdlp_missing")

    def test_log_written_under_temp_home(self) -> None:
        self.host.send({"type": "ping"})
        self.host.recv()
        self.host.close()
        if sys.platform == "darwin":
            log = os.path.join(self.home, "Library", "Logs", "savemedia-host.log")
        else:
            log = os.path.join(self.home, ".local", "state", "savemedia", "host.log")
        self.assertTrue(os.path.isfile(log), log)


def load_host_module(case: unittest.TestCase):
    """Import host.py in-process with its log redirected to a temp dir that is
    removed, and the log handle closed, when the test case ends."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("savemedia_host", HOST)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    log_dir = tempfile.mkdtemp(prefix="savemedia-host-log-")
    module._log_path = lambda: os.path.join(log_dir, "host.log")

    def cleanup() -> None:
        if module._log_file is not None:
            module._log_file.close()
            module._log_file = None
        shutil.rmtree(log_dir, ignore_errors=True)

    case.addCleanup(cleanup)
    return module


class ClassifierTest(unittest.TestCase):
    def setUp(self) -> None:
        self.host = load_host_module(self)

    def test_drm_word_boundary_and_url_stripping(self) -> None:
        c = self.host.classify_stderr
        self.assertEqual(c("ERROR: This video is DRM protected"), "drm_protected")
        self.assertEqual(c("ERROR: Unsupported URL: https://x/drmfree/video", "https://x/drmfree/video"), "unsupported_url")
        self.assertEqual(c("ERROR: Unsupported URL: https://x/drm/video", "https://x/drm/video"), "unsupported_url")

    def test_geo_and_login_phrases(self) -> None:
        c = self.host.classify_stderr
        self.assertEqual(c("ERROR: The uploader has not made this video available in your country"), "geo_restricted")
        self.assertEqual(c("ERROR: This video is not available from your location due to geo restriction"), "geo_restricted")
        self.assertEqual(c("ERROR: Sign in to confirm your age"), "login_required")
        self.assertEqual(c("ERROR: [x] page: message"), "unknown")

    def test_page_url_validation(self) -> None:
        v = self.host.validate_page_url
        self.assertTrue(v("https://example.com/a?b=c"))
        self.assertFalse(v("https://example.com/a\n"))
        self.assertFalse(v("-o evil https://example.com/"))
        self.assertFalse(v("file:///etc/passwd"))

    def test_network_phrases_and_last_error_line(self) -> None:
        c = self.host.classify_stderr
        self.assertEqual(c("ERROR: Unable to download webpage: HTTP Error 503"), "network")
        self.assertEqual(c("ERROR: [x] y: Connection timed out"), "network")
        self.assertEqual(c("ERROR: HTTP Error 502: Bad Gateway"), "network")
        last = self.host.last_error_line
        self.assertEqual(last("WARNING: a\nERROR: first\nERROR: second\ntrailing"), "ERROR: second")
        self.assertEqual(last("just noise"), "just noise")
        self.assertEqual(last(""), "yt-dlp failed")


class FramingTest(unittest.TestCase):
    """read_frame / encode_frame against in-memory streams."""

    def setUp(self) -> None:
        self.host = load_host_module(self)

    def frame(self, payload: bytes) -> "io.BytesIO":
        import io
        return io.BytesIO(struct.pack("@I", len(payload)) + payload)

    def test_round_trip(self) -> None:
        stream = self.frame(b'{"type":"ping"}')
        self.assertEqual(self.host.read_frame(stream), {"type": "ping"})
        self.assertIsNone(self.host.read_frame(stream), "EOF must read as None")

    def test_short_header_and_truncated_body_are_eof(self) -> None:
        import io
        self.assertIsNone(self.host.read_frame(io.BytesIO(b"\x01\x00")))
        self.assertIsNone(self.host.read_frame(io.BytesIO(struct.pack("@I", 10) + b"{}")))

    def test_zero_length_frame_is_empty_object(self) -> None:
        import io
        self.assertEqual(self.host.read_frame(io.BytesIO(struct.pack("@I", 0))), {})

    def test_oversize_declaration_closes_instead_of_waiting(self) -> None:
        import io
        stream = io.BytesIO(struct.pack("@I", self.host.MAX_INBOUND_BYTES + 1) + b"{")
        self.assertIsNone(self.host.read_frame(stream))

    def test_malformed_json_and_non_object_are_flagged(self) -> None:
        self.assertEqual(self.host.read_frame(self.frame(b"{not json")), {"type": "__malformed__"})
        self.assertEqual(self.host.read_frame(self.frame(b"[1,2]")), {"type": "__malformed__"})
        self.assertEqual(self.host.read_frame(self.frame(b"\xff\xfe")), {"type": "__malformed__"})

    def test_encode_frame_keeps_outbound_under_the_browser_cap(self) -> None:
        small = self.host.encode_frame({"type": "failed", "id": "a", "code": "unknown", "message": "x"})
        self.assertEqual(json.loads(small)["message"], "x")
        huge = self.host.encode_frame({"type": "failed", "id": "a", "code": "unknown", "message": "y" * (2 * 1024 * 1024)})
        self.assertLessEqual(len(huge), self.host.MAX_OUTBOUND_BYTES)
        self.assertTrue(json.loads(huge)["message"].endswith("[truncated]"))


class ValidationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.host = load_host_module(self)
        self.home = tempfile.mkdtemp(prefix="savemedia-host-home-")
        self.old_home = os.environ.get("HOME")
        os.environ["HOME"] = self.home
        os.makedirs(os.path.join(self.home, "Downloads"))

    def tearDown(self) -> None:
        if self.old_home is not None:
            os.environ["HOME"] = self.old_home
        shutil.rmtree(self.home, ignore_errors=True)

    def test_output_dir_defaults_to_downloads_and_stays_inside_home(self) -> None:
        v = self.host.validate_output_dir
        real_home = os.path.realpath(self.home)
        self.assertEqual(v(None), os.path.join(real_home, "Downloads"))
        self.assertEqual(v(self.home), real_home)
        self.assertEqual(v("~/Downloads"), os.path.join(real_home, "Downloads"))
        self.assertIsNone(v("/"))
        self.assertIsNone(v(os.path.join(self.home, "missing")))
        self.assertIsNone(v(""))
        self.assertIsNone(v(42))
        self.assertIsNone(v(self.home + "/../"))
        open(os.path.join(self.home, "file"), "w").close()
        self.assertIsNone(v(os.path.join(self.home, "file")), "a file is not a directory")

    def test_output_dir_symlink_escaping_home_is_refused(self) -> None:
        outside = tempfile.mkdtemp(prefix="savemedia-outside-")
        try:
            link = os.path.join(self.home, "escape")
            os.symlink(outside, link)
            self.assertIsNone(self.host.validate_output_dir(link))
        finally:
            shutil.rmtree(outside, ignore_errors=True)

    def test_format_for_quality(self) -> None:
        f = self.host.format_for_quality
        self.assertTrue(f("best").startswith("bestvideo[ext=mp4]+bestaudio[ext=m4a]"))
        self.assertIn("[height<=720]", f("720"))
        self.assertIn("/best", f("480"))

    def test_find_tool_and_version_probe_use_only_existing_executables(self) -> None:
        bindir = os.path.join(self.home, "bin")
        os.makedirs(bindir)
        fake = os.path.join(bindir, "yt-dlp")
        with open(fake, "w") as fh:
            fh.write("#!/bin/sh\necho 2026.08.19\n")
        os.chmod(fake, 0o755)
        old_path = os.environ.get("PATH", "")
        os.environ["PATH"] = bindir
        try:
            self.assertEqual(self.host.find_tool("yt-dlp"), fake)
            self.assertIsNone(self.host.find_tool("definitely-not-installed"))
            self.assertEqual(self.host.tool_version(fake, ["--version"], r"(\d{4}\.\d{2}\.\d{2}\S*)"), "2026.08.19")
            self.assertIsNone(self.host.tool_version(None, ["--version"], r"(x)"))
            info = self.host.tool_info("yt-dlp")
            self.assertEqual(info, {"found": True, "version": "2026.08.19", "path": fake})
        finally:
            os.environ["PATH"] = old_path


class JobTest(unittest.TestCase):
    def setUp(self) -> None:
        self.host = load_host_module(self)
        self.sent = []
        self.host.send = lambda message: self.sent.append(message)
        self.work = tempfile.mkdtemp(prefix="savemedia-job-")

    def tearDown(self) -> None:
        shutil.rmtree(self.work, ignore_errors=True)

    def test_progress_line_parsing_reports_percent_and_falls_back_to_estimate(self) -> None:
        job = self.host.Job("j1", {})
        job._parse_progress("SMPROG 50 100 NA 1000 5", "downloading")
        self.assertEqual(self.sent[-1], {
            "type": "progress", "id": "j1", "phase": "downloading",
            "downloadedBytes": 50, "totalBytes": 100, "percent": 50.0,
            "speedBytesPerSec": 1000.0, "etaSeconds": 5,
        })
        job._last_progress_at = 0.0
        job._parse_progress("SMPROG 30 NA 200 NA NA", "downloading")
        self.assertEqual(self.sent[-1]["totalBytes"], 200)
        self.assertEqual(self.sent[-1]["percent"], 15.0)
        self.assertIsNone(self.sent[-1]["speedBytesPerSec"])
        job._last_progress_at = 0.0
        job._parse_progress("SMPROG 1 2", "downloading")
        self.assertEqual(len(self.sent), 2, "short lines are ignored")

    def test_progress_is_throttled_unless_forced(self) -> None:
        job = self.host.Job("j2", {})
        job._progress("downloading", force=True)
        job._progress("downloading")
        self.assertEqual(len(self.sent), 1)
        job._progress("merging", force=True)
        self.assertEqual(self.sent[-1]["phase"], "merging")

    def test_remove_partials_only_touches_yt_dlp_leftovers(self) -> None:
        final = os.path.join(self.work, "clip [id].mp4")
        leftovers = [final + ".part", final + ".part-Frag3", final + ".ytdl", os.path.join(self.work, "clip [id].f137.mp4")]
        for path in [final] + leftovers:
            open(path, "w").close()
        self.host.Job._remove_partials(["clip [id].mp4", "clip [id].f137.mp4"], self.work)
        for path in leftovers:
            self.assertFalse(os.path.exists(path), path)
        self.assertTrue(os.path.exists(final), "the finished file is never deleted")

    def test_cancel_terminates_the_process_group(self) -> None:
        job = self.host.Job("j3", {})
        proc = subprocess.Popen(["sleep", "30"], stdin=subprocess.DEVNULL, start_new_session=True)
        job.process = proc
        job.cancel()
        self.assertTrue(job.cancelled.is_set())
        self.assertIsNotNone(proc.wait(timeout=self.host.KILL_GRACE_SECONDS + 2))

    def test_timeout_kills_the_process_and_marks_the_job(self) -> None:
        job = self.host.Job("j4", {})
        proc = subprocess.Popen(["sleep", "30"], stdin=subprocess.DEVNULL, start_new_session=True)
        job.process = proc
        job._timeout()
        self.assertTrue(job.timed_out)
        self.assertIsNotNone(proc.wait(timeout=5))

    def test_duplicate_download_ids_are_refused_without_starting_a_job(self) -> None:
        self.host._jobs["dup"] = object()
        try:
            self.host.handle_download({"type": "download", "id": "dup"})
        finally:
            self.host._jobs.pop("dup", None)
        self.assertEqual(self.sent[-1]["code"], "invalid_request")
        self.assertIn("already running", self.sent[-1]["message"])
        self.host.handle_download({"type": "download"})
        self.assertEqual(self.sent[-1], {"type": "failed", "id": "", "code": "invalid_request", "message": "download requires a string id"})


class LogRotationTest(unittest.TestCase):
    def test_rotation_keeps_a_bounded_number_of_files(self) -> None:
        host = load_host_module(self)
        work = tempfile.mkdtemp(prefix="savemedia-log-")
        try:
            path = os.path.join(work, "host.log")
            host._rotate_log(path)  # missing file: no error
            for round_no in range(1, host.LOG_BACKUPS + 3):
                with open(path, "w") as fh:
                    fh.write("x" * host.LOG_MAX_BYTES)
                host._rotate_log(path)
                self.assertFalse(os.path.exists(path), "rotated away on round %d" % round_no)
                self.assertTrue(os.path.exists(path + ".1"))
            backups = sorted(f for f in os.listdir(work) if f.startswith("host.log."))
            self.assertEqual(backups, ["host.log.%d" % i for i in range(1, host.LOG_BACKUPS + 1)])
            with open(path, "w") as fh:
                fh.write("small")
            host._rotate_log(path)
            self.assertTrue(os.path.exists(path), "a small log is left alone")
        finally:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
