import io
import json
import struct

import pytest

from savemedia_host.protocol import (
    BROWSER_TO_HOST_MAX,
    HOST_TO_BROWSER_MAX,
    ProtocolError,
    read_message,
    write_message,
)


def frame(payload: bytes) -> bytes:
    return struct.pack("<I", len(payload)) + payload


def test_read_message_round_trip():
    body = json.dumps({"type": "ping", "nonce": "n", "version": "1"}).encode("utf-8")
    stream = io.BytesIO(frame(body))
    assert read_message(stream) == {"type": "ping", "nonce": "n", "version": "1"}


def test_read_eof_returns_none():
    assert read_message(io.BytesIO(b"")) is None


def test_truncated_body_raises():
    body = b'{"a":1}'
    truncated = struct.pack("<I", len(body) + 4) + body  # claim 4 extra bytes
    with pytest.raises(ProtocolError, match="truncated"):
        read_message(io.BytesIO(truncated))


def test_invalid_json_raises():
    bad = b"not-json"
    with pytest.raises(ProtocolError, match="invalid JSON"):
        read_message(io.BytesIO(frame(bad)))


def test_top_level_must_be_object():
    body = json.dumps([1, 2, 3]).encode("utf-8")
    with pytest.raises(ProtocolError, match="object"):
        read_message(io.BytesIO(frame(body)))


def test_oversize_declaration_rejected():
    """A length-prefix above the defensive cap must be rejected before body read."""
    header = struct.pack("<I", BROWSER_TO_HOST_MAX + 1)
    with pytest.raises(ProtocolError, match="defensive cap"):
        read_message(io.BytesIO(header))


def test_write_message_round_trip():
    sink = io.BytesIO()
    write_message(sink, {"type": "pong", "nonce": "n"})
    sink.seek(0)
    assert read_message(sink) == {"type": "pong", "nonce": "n"}


def test_write_message_rejects_oversize_response():
    huge = {"type": "x", "payload": "a" * (HOST_TO_BROWSER_MAX + 1)}
    sink = io.BytesIO()
    with pytest.raises(ProtocolError, match="1 MB"):
        write_message(sink, huge)
