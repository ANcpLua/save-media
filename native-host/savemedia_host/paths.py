"""Cross-platform downloads directory resolution + filename sanitisation."""
from __future__ import annotations

import os
import platform
import re
from pathlib import Path

ILLEGAL = re.compile(r'[\x00\\/:*?"<>|]+')
RESERVED_WINDOWS = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def downloads_dir() -> Path:
    """Return the platform-conventional downloads directory."""
    home = Path.home()
    system = platform.system()
    if system == "Windows":
        return Path(os.environ.get("USERPROFILE", str(home))) / "Downloads"
    if system == "Darwin":
        return home / "Downloads"
    xdg = os.environ.get("XDG_DOWNLOAD_DIR")
    return Path(xdg) if xdg else home / "Downloads"


def sanitize_filename(name: str, max_length: int = 200) -> str:
    """Strip path separators, control characters, and Windows-reserved names."""
    cleaned = ILLEGAL.sub("_", name)
    # Trim trailing whitespace/dots first so "name..." becomes "name" rather
    # than "name_" (the dot-run replacement below only fires on interior dots).
    cleaned = cleaned.strip()
    cleaned = cleaned.rstrip(".")
    # Any remaining run of 2+ dots is path-traversal bait → collapse to "_".
    cleaned = re.sub(r"\.{2,}", "_", cleaned)
    stem = cleaned.split(".")[0].upper()
    if stem in RESERVED_WINDOWS:
        cleaned = f"_{cleaned}"
    if len(cleaned) > max_length:
        ext_idx = cleaned.rfind(".")
        if ext_idx > 0 and ext_idx > len(cleaned) - 16:
            ext = cleaned[ext_idx:]
            cleaned = cleaned[: max_length - len(ext)] + ext
        else:
            cleaned = cleaned[:max_length]
    if not cleaned or set(cleaned) <= {"_"}:
        return "file"
    return cleaned


def sink_root() -> Path:
    """Return the directory the streaming sink writes into. Created on demand."""
    base = downloads_dir() / "save-media"
    base.mkdir(parents=True, exist_ok=True)
    return base
