"""yt-dlp argv builder + runner. No shell=True; explicit argv only."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Iterable

from .paths import sanitize_filename

# Quality hints accepted from the extension.
QUALITY_TO_FORMAT = {
    "best": "bestvideo[height<=2160]+bestaudio/best",
    "2160p": "bestvideo[height<=2160]+bestaudio/best[height<=2160]",
    "1440p": "bestvideo[height<=1440]+bestaudio/best[height<=1440]",
    "1080p": "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
    "720p": "bestvideo[height<=720]+bestaudio/best[height<=720]",
}


def build_argv(
    url: str,
    quality: str,
    output_dir: Path,
    *,
    binary: str = "yt-dlp",
    template: str = "%(title).200B [%(id)s].%(ext)s",
) -> list[str]:
    """Build the explicit argv list for a yt-dlp invocation.

    No shell=True ever. We do not pass user-controlled strings outside the
    `--output` template, which yt-dlp itself sanitises against its own
    rules.
    """
    fmt = QUALITY_TO_FORMAT.get(quality, QUALITY_TO_FORMAT["best"])
    safe_output_dir = Path(output_dir).resolve()
    safe_output_dir.mkdir(parents=True, exist_ok=True)
    return [
        binary,
        "--no-call-home",
        "--no-progress",
        "--newline",
        "--restrict-filenames",
        "--no-warnings",
        "--format", fmt,
        "--merge-output-format", "mp4",
        "--output", str(safe_output_dir / template),
        url,
    ]


def is_available(binary: str = "yt-dlp") -> bool:
    return shutil.which(binary) is not None


def run(
    argv: list[str],
    timeout_seconds: float,
    on_line: callable[[str], None] | None = None,
) -> tuple[int, list[str]]:
    """Run yt-dlp, streaming stdout to `on_line` (if any), returning rc + tail."""
    tail: list[str] = []
    proc = subprocess.Popen(
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    try:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.rstrip("\n")
            if on_line is not None:
                on_line(line)
            tail.append(line)
            if len(tail) > 500:
                tail = tail[-500:]
        rc = proc.wait(timeout=timeout_seconds)
        return rc, tail
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise
    finally:
        if proc.stdout is not None:
            proc.stdout.close()


def safe_output_name(title: str) -> str:
    return sanitize_filename(title)
