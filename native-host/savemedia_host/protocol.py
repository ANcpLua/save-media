"""Chrome native messaging protocol — length-prefixed JSON framing.

Each message is a UTF-8 JSON document prefixed by a little-endian 32-bit
unsigned length. Browser → host messages are capped at 4 GB by the spec;
host → browser messages must be ≤ 1 MB. We enforce both directions.
"""
from __future__ import annotations

import json
import struct
import sys
from typing import IO, Any

BROWSER_TO_HOST_MAX = 256 * 1024 * 1024  # 256 MB — defensive cap; spec is 4 GB
HOST_TO_BROWSER_MAX = 1024 * 1024  # 1 MB (spec)


class ProtocolError(Exception):
    """Raised on framing failures or oversize messages."""


def read_message(stream: IO[bytes]) -> dict[str, Any] | None:
    """Read one framed message from the stream. Returns None on EOF.

    Raises ProtocolError on truncated frames, malformed JSON, or oversize
    declarations.
    """
    header = _read_exact(stream, 4)
    if header is None:
        return None
    (length,) = struct.unpack("<I", header)
    if length > BROWSER_TO_HOST_MAX:
        raise ProtocolError(f"message length {length} exceeds defensive cap of {BROWSER_TO_HOST_MAX} bytes")
    body = _read_exact(stream, length)
    if body is None:
        raise ProtocolError("truncated body")
    try:
        decoded = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"invalid JSON: {exc}") from exc
    if not isinstance(decoded, dict):
        raise ProtocolError("top-level message must be a JSON object")
    return decoded


def write_message(stream: IO[bytes], message: dict[str, Any]) -> None:
    """Frame and emit one message to the stream.

    Raises ProtocolError if the encoded message exceeds the 1 MB host → browser
    cap mandated by the Chrome native messaging spec.
    """
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > HOST_TO_BROWSER_MAX:
        raise ProtocolError(f"response {len(payload)} bytes exceeds 1 MB host→browser cap")
    stream.write(struct.pack("<I", len(payload)))
    stream.write(payload)
    stream.flush()


def _read_exact(stream: IO[bytes], n: int) -> bytes | None:
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None if not buf else None
        buf.extend(chunk)
    return bytes(buf)


def stdio_streams() -> tuple[IO[bytes], IO[bytes]]:
    """Return raw binary stdin / stdout. Native messaging is byte-oriented."""
    return sys.stdin.buffer, sys.stdout.buffer
