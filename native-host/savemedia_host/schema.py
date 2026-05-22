"""Request / response shape validation for the native messaging protocol.

We do not use a runtime schema library to keep the PyInstaller binary small.
Instead each request type has a hand-rolled validator that returns the
parsed dict or raises SchemaError with a human-readable detail.
"""
from __future__ import annotations

from typing import Any


class SchemaError(ValueError):
    """Raised when an incoming message fails shape validation."""


REQUEST_TYPES = {
    "ping",
    "download.ytdlp",
    "sink.open",
    "sink.chunk",
    "sink.close",
    "sink.abort",
    "probe",
}


def validate_request(msg: Any) -> dict[str, Any]:
    if not isinstance(msg, dict):
        raise SchemaError("request must be an object")
    rtype = msg.get("type")
    if rtype not in REQUEST_TYPES:
        raise SchemaError(f"unknown request type: {rtype!r}")
    nonce = msg.get("nonce")
    if not isinstance(nonce, str) or not nonce:
        raise SchemaError("nonce must be a non-empty string")

    if rtype == "ping":
        _require(msg, "version", str)
    elif rtype == "download.ytdlp":
        _require(msg, "url", str)
        _require(msg, "quality", str)
        _require(msg, "outputDir", str)
    elif rtype == "sink.open":
        _require(msg, "filename", str)
        if "expectedSize" in msg and msg["expectedSize"] is not None and not isinstance(msg["expectedSize"], int):
            raise SchemaError("expectedSize must be an int or null")
    elif rtype == "sink.chunk":
        _require(msg, "sinkId", str)
        _require(msg, "dataB64", str)
        _require(msg, "offset", int)
    elif rtype == "sink.close":
        _require(msg, "sinkId", str)
        _require(msg, "finalChecksum", str)
    elif rtype == "sink.abort":
        _require(msg, "sinkId", str)
    elif rtype == "probe":
        _require(msg, "url", str)
    return msg


def _require(msg: dict[str, Any], key: str, kind: type) -> None:
    if key not in msg:
        raise SchemaError(f"missing required field: {key}")
    if not isinstance(msg[key], kind):
        raise SchemaError(f"{key} must be {kind.__name__}")
