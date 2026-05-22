"""Local-only rotating-file logger with URL-hash redaction."""
from __future__ import annotations

import hashlib
import logging
import os
import re
from logging.handlers import RotatingFileHandler
from pathlib import Path

from .paths import sink_root

URL_RE = re.compile(r"https?://[^\s'\"]+")


class UrlRedactingFilter(logging.Filter):
    """Replaces every URL in a log record's message with a stable sha256 hash.

    Disable by setting `SAVEMEDIA_DEBUG_URLS=1` in the environment — used for
    local debugging only; never enabled in shipped binaries.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if os.environ.get("SAVEMEDIA_DEBUG_URLS") == "1":
            return True
        record.msg = URL_RE.sub(_redact_url, str(record.msg))
        return True


def _redact_url(match: re.Match[str]) -> str:
    digest = hashlib.sha256(match.group(0).encode("utf-8")).hexdigest()[:12]
    return f"url:{digest}"


def setup_logger(name: str = "savemedia.host", log_path: Path | None = None) -> logging.Logger:
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger
    logger.setLevel(logging.INFO)
    target = log_path or (sink_root() / "host.log")
    handler = RotatingFileHandler(target, maxBytes=2 * 1024 * 1024, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    handler.addFilter(UrlRedactingFilter())
    logger.addHandler(handler)
    logger.propagate = False
    return logger
