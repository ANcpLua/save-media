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


class ClassifierTest(unittest.TestCase):
    def setUp(self) -> None:
        import importlib.util
        spec = importlib.util.spec_from_file_location("savemedia_host", os.path.join(os.path.dirname(os.path.abspath(__file__)), "host.py"))
        self.host = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.host)

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
