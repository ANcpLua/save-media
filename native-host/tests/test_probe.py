import json
import shutil
import subprocess
from unittest.mock import patch

import pytest

from savemedia_host import probe


def test_is_available_reflects_path():
    assert probe.is_available("definitely-not-a-real-binary") is False


def test_probe_parses_ffprobe_json(monkeypatch):
    fake = subprocess.CompletedProcess(
        args=[],
        returncode=0,
        stdout=json.dumps({"format": {"duration": "10.0"}, "streams": []}),
        stderr="",
    )
    with patch.object(probe.subprocess, "run", return_value=fake):
        result = probe.probe("https://x/clip.mp4")
    assert result["format"]["duration"] == "10.0"


def test_probe_raises_on_nonzero_exit():
    fake = subprocess.CompletedProcess(
        args=[],
        returncode=1,
        stdout="",
        stderr="ffprobe error: not a media file",
    )
    with patch.object(probe.subprocess, "run", return_value=fake):
        with pytest.raises(RuntimeError, match="not a media file"):
            probe.probe("https://x/clip.html")


def test_probe_timeout_propagates():
    def boom(*_args, **_kwargs):
        raise subprocess.TimeoutExpired("ffprobe", 30)

    with patch.object(probe.subprocess, "run", side_effect=boom):
        with pytest.raises(subprocess.TimeoutExpired):
            probe.probe("https://x/", timeout_seconds=30)
