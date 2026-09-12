#!/usr/bin/env python3
"""Tests for install.sh and setup.sh against a temporary HOME.

Both scripts only ever touch files under HOME, so a throwaway HOME with fake
browser profile directories exercises the real code paths on the platform the
tests run on (macOS and Linux lay the directories out differently).
Run: python3 -m unittest discover -s packages/native-host
"""

import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HOST_NAME = "com.savemedia.host"


def profile_layout(home: str):
    """(chromium parents, firefox parent, firefox subdir) for this platform."""
    if platform.system() == "Darwin":
        app = os.path.join(home, "Library", "Application Support")
        return (
            [os.path.join(app, "Google", "Chrome"), os.path.join(app, "Microsoft Edge")],
            os.path.join(app, "Mozilla"),
            "NativeMessagingHosts",
        )
    return (
        [os.path.join(home, ".config", "google-chrome"), os.path.join(home, ".config", "microsoft-edge")],
        os.path.join(home, ".mozilla"),
        "native-messaging-hosts",
    )


@unittest.skipIf(platform.system() not in ("Darwin", "Linux"), "install.sh supports macOS and Linux")
class InstallScriptTest(unittest.TestCase):
    def setUp(self) -> None:
        self.home = tempfile.mkdtemp(prefix="savemedia-install-home-")
        self.pkg = os.path.join(self.home, "native-host")
        os.makedirs(self.pkg)
        for name in ("install.sh", "host.py"):
            shutil.copy(os.path.join(HERE, name), os.path.join(self.pkg, name))
        os.chmod(os.path.join(self.pkg, "host.py"), 0o644)
        self.chromium_parents, self.firefox_parent, self.firefox_subdir = profile_layout(self.home)
        # Only the first Chromium browser and Firefox "exist" on this machine.
        os.makedirs(self.chromium_parents[0])
        os.makedirs(self.firefox_parent)

    def tearDown(self) -> None:
        shutil.rmtree(self.home, ignore_errors=True)

    def run_install(self, *args, expect=0):
        env = dict(os.environ, HOME=self.home)
        proc = subprocess.run(
            ["bash", os.path.join(self.pkg, "install.sh"), *args],
            env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False,
        )
        self.assertEqual(proc.returncode, expect, proc.stdout + proc.stderr)
        return proc.stdout, proc.stderr

    def chromium_manifest(self, index=0) -> str:
        return os.path.join(self.chromium_parents[index], "NativeMessagingHosts", HOST_NAME + ".json")

    def firefox_manifest(self) -> str:
        return os.path.join(self.firefox_parent, self.firefox_subdir, HOST_NAME + ".json")

    def test_dry_run_reports_but_writes_nothing(self) -> None:
        out, _ = self.run_install("--dry-run")
        self.assertIn("write  " + self.chromium_manifest(0), out)
        self.assertIn("skip   " + self.chromium_manifest(1), out)
        self.assertIn("write  " + self.firefox_manifest(), out)
        self.assertFalse(os.path.exists(self.chromium_manifest(0)))
        self.assertFalse(os.path.exists(self.firefox_manifest()))
        self.assertFalse(os.stat(os.path.join(self.pkg, "host.py")).st_mode & stat.S_IXUSR, "dry run must not chmod")

    def test_install_writes_valid_manifests_for_present_browsers_only(self) -> None:
        out, _ = self.run_install("--extension-id", "abcdefghijklmnopabcdefghijklmnop", "--extension-id", "negbodmpgjhkacmdkbfdpocjanaklifn")
        self.assertIn("Tool check", out)
        with open(self.chromium_manifest(0)) as fh:
            chromium = json.load(fh)
        self.assertEqual(chromium["name"], HOST_NAME)
        self.assertEqual(chromium["type"], "stdio")
        self.assertEqual(chromium["path"], os.path.join(self.pkg, "host.py"))
        self.assertEqual(chromium["allowed_origins"], [
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
            "chrome-extension://negbodmpgjhkacmdkbfdpocjanaklifn/",
        ])
        self.assertNotIn("allowed_extensions", chromium)
        with open(self.firefox_manifest()) as fh:
            firefox = json.load(fh)
        self.assertEqual(firefox["allowed_extensions"], ["savemedia@ancplua.dev"])
        self.assertEqual(firefox["path"], chromium["path"])
        self.assertNotIn("allowed_origins", firefox)
        self.assertFalse(os.path.exists(self.chromium_manifest(1)), "no manifest for a browser that is not installed")
        self.assertTrue(os.stat(os.path.join(self.pkg, "host.py")).st_mode & stat.S_IXUSR, "host.py made executable")

    def test_defaults_point_at_the_store_ids(self) -> None:
        self.run_install()
        with open(self.chromium_manifest(0)) as fh:
            self.assertEqual(json.load(fh)["allowed_origins"], ["chrome-extension://negbodmpgjhkacmdkbfdpocjanaklifn/"])
        self.run_install("--firefox-id", "other@example.org")
        with open(self.firefox_manifest()) as fh:
            self.assertEqual(json.load(fh)["allowed_extensions"], ["other@example.org"])

    def test_manifest_path_survives_quotes_and_backslashes(self) -> None:
        odd = os.path.join(self.home, 'we"ird\\dir')
        os.makedirs(odd)
        for name in ("install.sh", "host.py"):
            shutil.copy(os.path.join(HERE, name), os.path.join(odd, name))
        env = dict(os.environ, HOME=self.home)
        proc = subprocess.run(["bash", os.path.join(odd, "install.sh")], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with open(self.chromium_manifest(0)) as fh:
            self.assertEqual(json.load(fh)["path"], os.path.join(odd, "host.py"))

    def test_uninstall_removes_manifests_and_is_idempotent(self) -> None:
        self.run_install()
        out, _ = self.run_install("--uninstall")
        self.assertIn("remove " + self.chromium_manifest(0), out)
        self.assertFalse(os.path.exists(self.chromium_manifest(0)))
        self.assertFalse(os.path.exists(self.firefox_manifest()))
        out, _ = self.run_install("--uninstall")
        self.assertIn("absent " + self.firefox_manifest(), out)
        out, _ = self.run_install("--uninstall", "--dry-run")
        self.assertIn("absent", out)

    def test_invalid_ids_and_options_are_rejected(self) -> None:
        _, err = self.run_install("--extension-id", "not-an-id", expect=2)
        self.assertIn("invalid Chromium extension id", err)
        _, err = self.run_install("--firefox-id", "bad id;rm -rf", expect=2)
        self.assertIn("invalid Firefox extension id", err)
        _, err = self.run_install("--bogus", expect=2)
        self.assertIn("unknown option", err)
        self.assertFalse(os.path.exists(self.chromium_manifest(0)))

    def test_missing_host_py_aborts_before_writing(self) -> None:
        os.remove(os.path.join(self.pkg, "host.py"))
        _, err = self.run_install(expect=1)
        self.assertIn("host.py not found", err)
        self.assertFalse(os.path.exists(self.chromium_manifest(0)))


@unittest.skipIf(platform.system() not in ("Darwin", "Linux") or shutil.which("curl") is None, "setup.sh needs curl on macOS or Linux")
class SetupScriptTest(unittest.TestCase):
    def setUp(self) -> None:
        self.home = tempfile.mkdtemp(prefix="savemedia-setup-home-")
        self.chromium_parents, self.firefox_parent, _ = profile_layout(self.home)
        os.makedirs(self.chromium_parents[0])

    def tearDown(self) -> None:
        shutil.rmtree(self.home, ignore_errors=True)

    def test_setup_fetches_the_helper_files_and_runs_the_installer(self) -> None:
        env = dict(os.environ, HOME=self.home, XDG_DATA_HOME=os.path.join(self.home, ".local", "share"),
                   SAVEMEDIA_HOST_BASE_URL="file://" + HERE)
        proc = subprocess.run(
            ["bash", os.path.join(HERE, "setup.sh"), "--extension-id", "negbodmpgjhkacmdkbfdpocjanaklifn", "--dry-run"],
            env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        if platform.system() == "Darwin":
            target = os.path.join(self.home, "Library", "Application Support", "savemedia", "native-host")
        else:
            target = os.path.join(self.home, ".local", "share", "savemedia", "native-host")
        for name in ("host.py", "install.sh"):
            path = os.path.join(target, name)
            self.assertTrue(os.path.isfile(path), path)
            self.assertTrue(os.stat(path).st_mode & stat.S_IXUSR, name + " executable")
            with open(path, "rb") as got, open(os.path.join(HERE, name), "rb") as want:
                self.assertEqual(got.read(), want.read(), name + " copied verbatim")
        self.assertIn("Helper files in: " + target, proc.stdout)
        self.assertIn("write  " + os.path.join(self.chromium_parents[0], "NativeMessagingHosts", HOST_NAME + ".json"), proc.stdout)
        self.assertNotIn("host.py.tmp", os.listdir(target))


if __name__ == "__main__":
    unittest.main(verbosity=2)
