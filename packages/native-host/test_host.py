#!/usr/bin/env python3
"""Protocol tests for host.py. Run: python3 test_host.py"""

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
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
        self.assertEqual(reply["hostVersion"], "1.3.0")
        self.assertEqual(reply["protocolVersion"], 2)
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
        self.assertEqual(set(reply), {"type", "hostVersion", "protocolVersion", "ytdlp", "ffmpeg", "outputDir"})

    def test_invalid_message_type(self) -> None:
        self.host.send({"type": "bogus", "id": "x1"})
        reply = self.host.recv()
        self.assertEqual(reply, {
            "type": "failed", "id": "x1", "code": "invalid_request",
            "message": reply["message"],
        })

    def test_removed_file_transport_requests_are_unknown(self) -> None:
        for kind in ("file-connection-status", "read-file", "read-partial"):
            self.host.send({"type": kind, "id": "x-" + kind, "url": "https://files.example/clip.mp4"})
            reply = self.host.recv()
            self.assertEqual((reply["type"], reply["id"], reply["code"]), ("failed", "x-" + kind, "invalid_request"))
        self.host.send({"type": "ping"})
        self.assertEqual(self.host.recv()["type"], "pong")

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

    def test_failure_class_comes_from_structure_never_from_words(self) -> None:
        classify = self.host.classify_failure
        # A title and earlier warnings that mention DRM decide nothing: the final ERROR line's status does.
        text = ("WARNING: [generic] DRM Free Movie: Falling back on generic information extractor\n"
                "WARNING: This video is DRM protected, maybe\n"
                "ERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden (caused by <HTTPError 403: Forbidden>)")
        self.assertEqual(classify(text, None), ("unknown", text.splitlines()[-1], 403))
        self.assertEqual(classify("ERROR: [generic] Unable to download webpage: HTTP Error 522: <none>", None)[2], 522)
        self.assertEqual(classify("ERROR: Sign in to confirm your age", None), ("unknown", "ERROR: Sign in to confirm your age", None))
        # yt-dlp's own words about DRM, without its format data, are only technical detail.
        self.assertEqual(classify("ERROR: This video is DRM protected", None)[0], "unknown")
        self.assertEqual(classify("ERROR: could not find chrome cookies database in \"/private/example\"", None)[:1], ("unknown",))
        # An earlier line's status is not the failure's.
        self.assertIsNone(classify("WARNING: HTTP Error 429: retrying\nERROR: [x] page: message", None)[2])

    def test_drm_verdict_reads_only_yt_dlps_format_data(self) -> None:
        verdict = self.host.drm_verdict
        self.assertTrue(verdict({"_has_drm": True, "formats": []}))
        self.assertTrue(verdict({"_type": "video", "_has_drm": True, "formats": [{"vcodec": "none", "acodec": "mp4a"}]}))
        self.assertTrue(verdict({"_has_drm": True, "formats": [{"vcodec": "avc1", "has_drm": True}]}))
        self.assertFalse(verdict({"_has_drm": True, "formats": [{"vcodec": "avc1"}]}))
        self.assertFalse(verdict({"_has_drm": "maybe", "formats": []}))
        self.assertFalse(verdict({"formats": []}))
        self.assertFalse(verdict({"_type": "playlist", "_has_drm": True, "formats": []}))
        self.assertFalse(verdict(None))
        self.assertEqual(self.host.classify_failure("ERROR: x", {"_has_drm": True, "formats": []})[0], "drm_protected")

    def test_http_status_is_read_from_the_error_token_only(self) -> None:
        status = self.host.http_status
        self.assertEqual(status("ERROR: [generic] Unable to download webpage: HTTP Error 404: Not Found"), 404)
        self.assertIsNone(status("ERROR: [x] page 403 forbidden"))
        self.assertIsNone(status("ERROR: HTTP Error 999: nonsense"))
        # A failure carries its code, the helper's line and the status, and nothing else.
        self.assertEqual(self.host.failure_frame("a", "unknown", "m", 403),
                         {"type": "failed", "id": "a", "code": "unknown", "message": "m", "httpStatus": 403})
        self.assertNotIn("httpStatus", self.host.failure_frame("a", "unknown", "m"))

    def test_cookie_store_is_found_by_looking_at_the_file_system(self) -> None:
        home = tempfile.mkdtemp(prefix="savemedia-cookies-")
        self.addCleanup(shutil.rmtree, home, True)
        exists = self.host.cookie_store_exists
        self.assertFalse(exists("chrome", home, {}, "darwin"))
        self.assertFalse(exists("firefox", home, {}, "linux"))
        profile = os.path.join(home, "Library", "Application Support", "Google", "Chrome", "Profile 1", "Network")
        os.makedirs(profile)
        self.assertFalse(exists("chrome", home, {}, "darwin"))
        open(os.path.join(profile, "Cookies"), "w").close()
        self.assertTrue(exists("chrome", home, {}, "darwin"))
        self.assertFalse(exists("edge", home, {}, "darwin"))
        firefox = os.path.join(home, ".mozilla", "firefox", "abc.default")
        os.makedirs(firefox)
        open(os.path.join(firefox, "cookies.sqlite"), "w").close()
        self.assertTrue(exists("firefox", home, {}, "linux"))
        config = os.path.join(home, "xdg")
        os.makedirs(os.path.join(config, "chromium", "Default"))
        open(os.path.join(config, "chromium", "Default", "Cookies"), "w").close()
        self.assertTrue(exists("chromium", home, {"XDG_CONFIG_HOME": config}, "linux"))
        self.assertFalse(exists("chromium", home, {}, "linux"))
        # A platform this host does not know: yt-dlp finds out itself.
        self.assertTrue(exists("chrome", home, {}, "sunos5"))

    def test_page_url_validation(self) -> None:
        v = self.host.validate_page_url
        self.assertTrue(v("https://example.com/a?b=c"))
        self.assertFalse(v("https://example.com/a\n"))
        self.assertFalse(v("-o evil https://example.com/"))
        self.assertFalse(v("file:///etc/passwd"))

    def test_last_error_line(self) -> None:
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
        # A run that has ended by itself is not marked as stopped.
        done = self.host.Job("j5", {})
        done.process = subprocess.Popen(["true"], stdin=subprocess.DEVNULL, start_new_session=True)
        done.process.wait(timeout=5)
        done._timeout()
        self.assertFalse(getattr(done, "timed_out", False))

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


class YtDlpConfigIsolationTest(unittest.TestCase):
    """A yt-dlp.conf that a web page drops into Downloads must never be read."""

    def setUp(self) -> None:
        self.host = load_host_module(self)
        self.host.send = lambda message: None
        self.output = tempfile.mkdtemp(prefix="savemedia-host-output-")
        self.staging = tempfile.mkdtemp(prefix="savemedia-host-staging-")
        with open(os.path.join(self.output, "yt-dlp.conf"), "w") as planted:
            planted.write('--exec "touch should-never-run"\n')

    def tearDown(self) -> None:
        shutil.rmtree(self.output, ignore_errors=True)
        shutil.rmtree(self.staging, ignore_errors=True)

    def test_home_path_and_working_directory_are_the_private_staging_directory(self) -> None:
        seen = {}

        class Stop(Exception):
            pass

        def fake_popen(cmd, **kwargs):
            seen["cmd"], seen["cwd"] = cmd, kwargs.get("cwd")
            raise Stop()

        original = self.host.subprocess.Popen
        self.host.subprocess.Popen = fake_popen
        try:
            job = self.host.Job("cfg", {})
            try:
                job._download("https://example.com/watch", "best", None, self.output, self.staging,
                              "/usr/bin/false", "/usr/bin/false", "clip.%(ext)s")
            except Stop:
                pass
        finally:
            self.host.subprocess.Popen = original
        cmd = seen["cmd"]
        homes = [cmd[i + 1] for i, arg in enumerate(cmd) if arg == "-P" and ":" not in cmd[i + 1]]
        self.assertEqual(homes, [self.staging])
        self.assertEqual(seen["cwd"], self.staging)
        output = cmd[cmd.index("-o") + 1]
        self.assertTrue(os.path.isabs(output))
        self.assertEqual(os.path.dirname(output), self.output)
        self.assertNotIn(self.output, [arg for arg in cmd if arg != output and arg != "--"])


class SavedNamingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.host = load_host_module(self)
        self.sent = []
        self.host.send = lambda message: self.sent.append(message)
        self.home = tempfile.mkdtemp(prefix="savemedia-host-home-")
        self.old_home = os.environ.get("HOME")
        os.environ["HOME"] = self.home
        os.makedirs(os.path.join(self.home, "Downloads"))

    def tearDown(self) -> None:
        if self.old_home is not None:
            os.environ["HOME"] = self.old_home
        shutil.rmtree(self.home, ignore_errors=True)

    def test_output_template_uses_the_extension_layout(self) -> None:
        def template(h: int, m: int = 0, s: int = 0) -> str:
            return self.host.timestamped_output_template(time.struct_time((2026, 1, 5, h, m, s, 0, 5, -1)))
        self.assertEqual(template(3, 4, 5), "2026-01-05 1 Night/2026-01-05_030405.%(ext)s")
        self.assertTrue(template(5, 59, 59).startswith("2026-01-05 1 Night/"))
        self.assertTrue(template(6).startswith("2026-01-05 2 Morning/"))
        self.assertTrue(template(12).startswith("2026-01-05 3 Afternoon/"))
        self.assertTrue(template(18).startswith("2026-01-05 4 Evening/"))

    def test_same_second_downloads_get_distinct_names_and_preserve_a_previous_save(self) -> None:
        directory = os.path.join(self.home, "Downloads")
        fixed = "2026-01-05 1 Night/2026-01-05_030405.%(ext)s"
        self.host.timestamped_output_template = lambda: fixed
        with self.host.reserve_output_template(directory) as first:
            with self.host.reserve_output_template(directory) as second:
                self.assertEqual(first, fixed)
                self.assertEqual(second, fixed.replace(".%(ext)s", " (1).%(ext)s"))
            saved = os.path.join(directory, first % {"ext": "mp4"})
            os.makedirs(os.path.dirname(saved))
            with open(saved, "wb") as file:
                file.write(b"previous save")
        with self.host.reserve_output_template(directory) as third:
            self.assertEqual(third, second)
        self.assertEqual(os.listdir(directory), ["2026-01-05 1 Night"])

    def test_archive_lives_under_home_in_an_existing_directory(self) -> None:
        path = self.host.download_archive_path()
        self.assertTrue(path.startswith(self.home))
        self.assertEqual(os.path.basename(path), "download-archive.txt")
        self.assertTrue(os.path.isdir(os.path.dirname(path)))

    def test_failed_fragment_attempt_cleans_only_its_own_staging_directory(self) -> None:
        downloads = os.path.join(self.home, "Downloads")
        existing = os.path.join(downloads, "unrelated.part")
        with open(existing, "wb") as file:
            file.write(b"keep")
        self.host.find_tool = lambda name: sys.executable
        job = self.host.Job("retry", {"pageUrl": "https://example.test/video"})
        def interrupted(_url, _quality, _cookies, _output, staging, _yt, _ffmpeg, _template):
            with open(os.path.join(staging, "clip.mp4.part-Frag2"), "wb") as file:
                file.write(b"partial")
            raise OSError("fixture transfer interrupted")
        job._download = interrupted
        job.run()
        self.assertEqual(os.listdir(downloads), ["unrelated.part"])
        self.assertEqual(self.sent[-1]["type"], "failed")

    def test_a_video_in_the_archive_fails_as_already_saved(self) -> None:
        bindir = os.path.join(self.home, "bin")
        os.makedirs(bindir)
        argv_log = os.path.join(self.home, "argv.json")
        ytdlp = os.path.join(bindir, "yt-dlp")
        with open(ytdlp, "w") as fh:
            fh.write("#!/usr/bin/env python3\nimport json, sys\n")
            fh.write("json.dump(sys.argv[1:], open(%r, 'w'))\n" % argv_log)
            fh.write("sys.exit(101)\n")
        ffmpeg = os.path.join(bindir, "ffmpeg")
        with open(ffmpeg, "w") as fh:
            fh.write("#!/bin/sh\n")
        os.chmod(ytdlp, 0o755)
        os.chmod(ffmpeg, 0o755)
        self.host.find_tool = lambda name: {"yt-dlp": ytdlp, "ffmpeg": ffmpeg}.get(name)

        self.host.Job("j1", {"pageUrl": "https://example.com/watch/1"}).run()

        self.assertEqual(self.sent[-1], {"type": "failed", "id": "j1", "code": "already_saved", "message": "this video is already saved"})
        with open(argv_log) as fh:
            argv = json.load(fh)
        self.assertEqual(argv[argv.index("--download-archive") + 1], self.host.download_archive_path())
        self.assertIn("--break-on-existing", argv)
        self.assertIn("--no-cookies", argv)
        self.assertIn("--no-cookies-from-browser", argv)
        self.assertIn("--abort-on-unavailable-fragments", argv)
        self.assertTrue(any(arg.startswith("temp:" + os.path.join(os.path.realpath(self.home), "Downloads", ".savemedia-")) for arg in argv))
        downloads = os.path.join(os.path.realpath(self.home), "Downloads")
        output = argv[argv.index("-o") + 1]
        self.assertTrue(output.startswith(downloads + os.sep), output)
        self.assertRegex(os.path.relpath(output, downloads), r"^\d{4}-\d{2}-\d{2} \d [A-Za-z]+/\d{4}-\d{2}-\d{2}_\d{6}\.%\(ext\)s$")
        # The home path (and with it yt-dlp's Home config lookup) is the private staging directory.
        homes = [argv[i + 1] for i, arg in enumerate(argv) if arg == "-P" and ":" not in argv[i + 1]]
        self.assertEqual(len(homes), 1)
        self.assertTrue(homes[0].startswith(os.path.join(downloads, ".savemedia-")), homes)


class FakeYtDlpTest(unittest.TestCase):
    """The end of a run, with a scripted yt-dlp in place of the real one."""

    MARKER = "probe-json-marker-7f3a"

    def setUp(self) -> None:
        self.host = load_host_module(self)
        self.sent = []
        self.host.send = lambda message: self.sent.append(message)
        self.home = os.path.realpath(tempfile.mkdtemp(prefix="savemedia-host-home-"))
        self.old_home = os.environ.get("HOME")
        os.environ["HOME"] = self.home
        os.makedirs(os.path.join(self.home, "Downloads"))
        self.bindir = os.path.join(self.home, "bin")
        os.makedirs(self.bindir)
        self.calls = os.path.join(self.home, "calls.jsonl")

    def tearDown(self) -> None:
        if self.old_home is not None:
            os.environ["HOME"] = self.old_home
        shutil.rmtree(self.home, ignore_errors=True)

    def install(self, download: str, probe: str = "sys.exit(1)") -> None:
        """`download` and `probe` are Python bodies for the download run and for the -J run."""
        ytdlp = os.path.join(self.bindir, "yt-dlp")
        with open(ytdlp, "w") as fh:
            fh.write("#!/usr/bin/env python3\nimport json, os, sys\n")
            fh.write("argv = sys.argv[1:]\n")
            fh.write("open(%r, 'a').write(json.dumps(argv) + '\\n')\n" % self.calls)
            fh.write("if '-J' in argv:\n")
            fh.write("".join("    %s\n" % line for line in probe.splitlines()))
            fh.write("else:\n")
            fh.write("".join("    %s\n" % line for line in download.splitlines()))
        ffmpeg = os.path.join(self.bindir, "ffmpeg")
        with open(ffmpeg, "w") as fh:
            fh.write("#!/bin/sh\n")
        os.chmod(ytdlp, 0o755)
        os.chmod(ffmpeg, 0o755)
        self.host.find_tool = lambda name: {"yt-dlp": ytdlp, "ffmpeg": ffmpeg}.get(name)

    def argvs(self):
        with open(self.calls) as fh:
            return [json.loads(line) for line in fh if line.strip()]

    def run_job(self, request=None):
        self.host.Job("j1", dict({"pageUrl": "https://example.com/watch/1"}, **(request or {}))).run()
        return self.sent[-1]

    def test_drm_is_reported_from_the_format_data_of_a_failed_run(self) -> None:
        self.install("sys.stderr.write('ERROR: x\\n'); sys.exit(1)",
                     "print(json.dumps({'_type': 'video', '_has_drm': True, 'formats': [], 'note': %r}))" % self.MARKER)
        frame = self.run_job({"cookiesFromBrowser": "firefox"})
        self.assertEqual((frame["type"], frame["code"]), ("failed", "drm_protected"))
        download, probe = self.argvs()
        for flag in ("-J", "--no-playlist", "--ignore-no-formats-error"):
            self.assertIn(flag, probe)
        # The probe asks with the same cookies as the run it explains.
        self.assertEqual(probe[probe.index("--cookies-from-browser") + 1], "firefox")
        self.assertEqual(download[download.index("--cookies-from-browser") + 1], "firefox")
        # And with the same private home path.
        self.assertEqual([probe[i + 1] for i, arg in enumerate(probe) if arg == "-P"],
                         [download[i + 1] for i, arg in enumerate(download) if arg == "-P"])
        # yt-dlp's description of the page can hold cookies: nothing of it reaches the log.
        with open(self.host._log_path()) as fh:
            log = fh.read()
        self.assertNotIn(self.MARKER, log)
        self.assertIn("drm probe rc=0 has_drm=True formats=0", log)

    def test_a_failed_probe_leaves_the_runs_own_final_line(self) -> None:
        self.install("sys.stderr.write('WARNING: drm\\nERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden\\n'); sys.exit(1)")
        frame = self.run_job()
        self.assertEqual(frame, {"type": "failed", "id": "j1", "code": "unknown",
                                 "message": "ERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden", "httpStatus": 403})
        self.assertEqual(len(self.argvs()), 2)

    def test_exit_101_without_a_file_is_already_saved_and_with_a_file_is_saved(self) -> None:
        self.install("sys.exit(101)")
        self.assertEqual(self.run_job()["code"], "already_saved")
        self.assertEqual(len(self.argvs()), 1, "no probe after an archive hit")
        os.remove(self.calls)
        self.sent.clear()
        target = os.path.join(self.home, "Downloads", "clip.mp4")
        self.install("open(%r, 'wb').write(b'x' * 10); print(%r); sys.exit(101)" % (target, target))
        frame = self.run_job()
        self.assertEqual((frame["type"], frame["filename"], frame["bytes"]), ("complete", "clip.mp4", 10))

    def test_no_probe_after_a_saved_file_or_a_cancel(self) -> None:
        target = os.path.join(self.home, "Downloads", "clip.mp4")
        self.install("open(%r, 'wb').write(b'x'); print(%r)" % (target, target))
        self.assertEqual(self.run_job()["type"], "complete")
        self.assertEqual(len(self.argvs()), 1)
        os.remove(self.calls)
        self.install("sys.stderr.write('ERROR: x\\n'); sys.exit(1)")
        job = self.host.Job("j2", {"pageUrl": "https://example.com/watch/2"})
        job.cancelled.set()
        job.run()
        self.assertEqual(self.sent[-1]["code"], "cancelled")
        self.assertFalse(os.path.exists(self.calls), "a cancelled job starts nothing")

    def test_no_probe_after_a_timeout(self) -> None:
        self.install("import time; time.sleep(30)")
        self.host.STALL_TIMEOUT_SECONDS = 1
        self.host.KILL_GRACE_SECONDS = 0.2
        frame = self.run_job()
        self.assertEqual(frame["code"], "timeout")
        self.assertEqual(len(self.argvs()), 1)

    def test_a_run_that_keeps_reporting_progress_is_never_ended_for_its_length(self) -> None:
        target = os.path.join(self.home, "Downloads", "clip.mp4")
        # Four times the quiet window, with a progress line every 0.2 s.
        self.install("import time\n"
                     "for i in range(20):\n"
                     "    print('SMPROG %%d 100 NA 5.0 1' %% (i * 5), flush=True)\n"
                     "    time.sleep(0.2)\n"
                     "open(%r, 'wb').write(b'x' * 10); print(%r)" % (target, target))
        self.host.STALL_TIMEOUT_SECONDS = 1
        self.host.KILL_GRACE_SECONDS = 0.2
        frame = self.run_job()
        self.assertEqual((frame["type"], frame.get("filename")), ("complete", "clip.mp4"))

    def test_lines_on_the_error_stream_count_as_a_sign_of_life(self) -> None:
        target = os.path.join(self.home, "Downloads", "clip.mp4")
        # ffmpeg as a downloader rewrites one line on the error stream and never ends it.
        self.install("import time\n"
                     "for i in range(20):\n"
                     "    sys.stderr.write('frame=%%d\\r' %% i); sys.stderr.flush()\n"
                     "    time.sleep(0.2)\n"
                     "open(%r, 'wb').write(b'x' * 10); print(%r)" % (target, target))
        self.host.STALL_TIMEOUT_SECONDS = 1
        self.host.KILL_GRACE_SECONDS = 0.2
        self.assertEqual(self.run_job()["type"], "complete")

    def test_joining_the_tracks_may_stay_quiet_longer_than_a_download(self) -> None:
        target = os.path.join(self.home, "Downloads", "clip.mp4")
        self.install("import time\n"
                     "print('[Merger] Merging formats into \"clip.mp4\"', flush=True)\n"
                     "time.sleep(3)\n"
                     "open(%r, 'wb').write(b'x' * 10); print(%r)" % (target, target))
        self.host.STALL_TIMEOUT_SECONDS = 1
        self.host.KILL_GRACE_SECONDS = 0.2
        frame = self.run_job()
        self.assertEqual(frame["type"], "complete")
        self.assertIn("merging", [message.get("phase") for message in self.sent])
        # A join that never ends is still ended.
        self.sent.clear()
        self.install("import time\n"
                     "print('[Merger] Merging formats into \"clip.mp4\"', flush=True)\n"
                     "time.sleep(30)")
        self.host.MERGE_STALL_TIMEOUT_SECONDS = 1
        self.assertEqual(self.run_job()["code"], "timeout")

    def test_neither_run_lets_yt_dlp_fake_where_the_user_is(self) -> None:
        self.install("sys.stderr.write('ERROR: x\\n'); sys.exit(1)", "print(json.dumps({'formats': []}))")
        self.run_job()
        download, probe = self.argvs()
        for argv in (download, probe):
            self.assertIn("--no-geo-bypass", argv)
            for flag in ("--xff", "--geo-bypass", "--geo-bypass-country", "--geo-bypass-ip-block", "--geo-verification-proxy", "--proxy"):
                self.assertNotIn(flag, argv)

    def test_auto_cookies_run_without_cookies_when_the_browser_has_no_store(self) -> None:
        self.install("sys.exit(101)")
        self.host.cookie_store_exists = lambda browser: False
        self.run_job({"cookiesFromBrowser": "chrome", "allowWithoutCookies": True})
        self.assertIn("--no-cookies-from-browser", self.argvs()[0])
        os.remove(self.calls)
        # A browser the user chose is always asked for its cookies; yt-dlp reports what it finds.
        self.run_job({"cookiesFromBrowser": "chrome"})
        argv = self.argvs()[0]
        self.assertEqual(argv[argv.index("--cookies-from-browser") + 1], "chrome")
        os.remove(self.calls)
        self.host.cookie_store_exists = lambda browser: True
        self.run_job({"cookiesFromBrowser": "chrome", "allowWithoutCookies": True})
        argv = self.argvs()[0]
        self.assertEqual(argv[argv.index("--cookies-from-browser") + 1], "chrome")


def has_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None or any(os.access(os.path.join(d, "ffmpeg"), os.X_OK) for d in ("/opt/homebrew/bin", "/usr/local/bin"))


# CI sets SAVEMEDIA_REQUIRE_YTDLP=1 in the job that installs the pinned yt-dlp: there a missing tool
# fails these tests instead of skipping them, so a new pin is always checked against what the host reads.
REQUIRE_YTDLP = os.environ.get("SAVEMEDIA_REQUIRE_YTDLP") == "1"


@unittest.skipUnless(REQUIRE_YTDLP or (has_ytdlp() and has_ffmpeg()), "needs yt-dlp and ffmpeg on this machine")
class RealYtDlpTest(unittest.TestCase):
    """The yt-dlp facts the host relies on, against the installed yt-dlp and a loopback server."""

    SEGMENT = os.path.join(HERE, "..", "extension", "tests", "e2e", "media-fixtures", "hls", "seg000.ts")

    @classmethod
    def setUpClass(cls) -> None:
        missing = [name for name, found in (("yt-dlp", has_ytdlp()), ("ffmpeg", has_ffmpeg())) if not found]
        if missing:
            raise AssertionError("SAVEMEDIA_REQUIRE_YTDLP=1 but not installed: %s" % ", ".join(missing))

    def setUp(self) -> None:
        import http.server
        import threading
        self.host = load_host_module(self)
        self.sent = []
        self.host.send = lambda message: self.sent.append(message)
        self.home = os.path.realpath(tempfile.mkdtemp(prefix="savemedia-host-home-"))
        self.old_home = os.environ.get("HOME")
        os.environ["HOME"] = self.home
        os.makedirs(os.path.join(self.home, "Downloads"))
        with open(self.SEGMENT, "rb") as fh:
            segment = fh.read()
        playlist = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n%s#EXTINF:4.0,\nseg.ts\n#EXT-X-ENDLIST\n"
        key = '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://fixture",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"\n'
        bodies = {
            "/drm.m3u8": ((playlist % key).encode(), "application/vnd.apple.mpegurl"),
            "/clear.m3u8": ((playlist % "").encode(), "application/vnd.apple.mpegurl"),
            "/seg.ts": (segment, "video/mp2t"),
        }

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                body = bodies.get(self.path.split("?")[0])
                if body is None:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", body[1])
                self.send_header("Content-Length", str(len(body[0])))
                self.end_headers()
                self.wfile.write(body[0])

            do_HEAD = do_GET  # noqa: N815

            def log_message(self, *args) -> None:
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        if self.old_home is not None:
            os.environ["HOME"] = self.old_home
        shutil.rmtree(self.home, ignore_errors=True)

    def run_job(self, path: str):
        self.host.Job("j1", {"pageUrl": self.base + path}).run()
        return self.sent[-1]

    def test_a_fairplay_playlist_is_reported_as_drm_from_yt_dlps_format_data(self) -> None:
        frame = self.run_job("/drm.m3u8")
        self.assertEqual((frame["type"], frame.get("code")), ("failed", "drm_protected"), frame)

    def test_a_clear_playlist_is_saved_and_a_second_run_is_an_archive_hit(self) -> None:
        frame = self.run_job("/clear.m3u8")
        self.assertEqual(frame["type"], "complete", frame)
        self.assertGreater(frame["bytes"], 0)
        self.sent.clear()
        self.assertEqual(self.run_job("/clear.m3u8").get("code"), "already_saved")

    def test_a_missing_page_reports_its_http_status(self) -> None:
        frame = self.run_job("/missing.m3u8")
        self.assertEqual((frame["type"], frame.get("code"), frame.get("httpStatus")), ("failed", "unknown", 404), frame)


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
