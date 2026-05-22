"""ffprobe wrapper — returns muxer + codec metadata as a dict."""
from __future__ import annotations

import json
import shutil
import subprocess
from typing import Any


def is_available(binary: str = "ffprobe") -> bool:
    return shutil.which(binary) is not None


def probe(url: str, timeout_seconds: float = 30.0, binary: str = "ffprobe") -> dict[str, Any]:
    """Run ffprobe against a URL and parse the resulting JSON document."""
    argv = [
        binary,
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        "-i", url,
    ]
    proc = subprocess.run(
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout_seconds,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe exited {proc.returncode}: {proc.stderr.strip()[:512]}")
    return json.loads(proc.stdout or "{}")
