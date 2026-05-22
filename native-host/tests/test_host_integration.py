"""End-to-end test: spawn host.py as a subprocess and exchange messages.

This exercises the actual protocol framing, schema validation, and dispatch
loop without mocking. Skips on Windows because subprocess stdin/stdout
buffering quirks make framed I/O brittle in CI; the per-module tests cover
the same code paths.
"""
from __future__ import annotations

import json
import struct
import subprocess
import sys
from pathlib import Path

import pytest

HOST = Path(__file__).resolve().parent.parent / "host.py"


def frame(payload: dict) -> bytes:
    body = json.dumps(payload).encode("utf-8")
    return struct.pack("<I", len(body)) + body


def parse(stream_bytes: bytes) -> dict:
    length = struct.unpack("<I", stream_bytes[:4])[0]
    return json.loads(stream_bytes[4:4 + length].decode("utf-8"))


@pytest.mark.skipif(sys.platform == "win32", reason="windows stdio framing is brittle")
def test_ping_pong_round_trip():
    proc = subprocess.Popen(
        [sys.executable, str(HOST)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        assert proc.stdin is not None
        assert proc.stdout is not None
        proc.stdin.write(frame({"type": "ping", "nonce": "n1", "version": "0.0.1"}))
        proc.stdin.close()
        out = proc.stdout.read()
        response = parse(out)
        assert response["type"] == "pong"
        assert response["nonce"] == "n1"
        assert response["host"] == "savemedia-host"
        assert "version" in response
        assert isinstance(response["capabilities"], list)
        assert "sink" in response["capabilities"]
    finally:
        proc.wait(timeout=5)


@pytest.mark.skipif(sys.platform == "win32", reason="windows stdio framing is brittle")
def test_unknown_request_yields_protocol_error():
    proc = subprocess.Popen(
        [sys.executable, str(HOST)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        assert proc.stdin is not None
        assert proc.stdout is not None
        proc.stdin.write(frame({"type": "nope", "nonce": "n2"}))
        proc.stdin.close()
        out = proc.stdout.read()
        response = parse(out)
        assert response["type"] == "error"
        assert response["nonce"] == "n2"
        assert response["code"] == "native_host_protocol"
    finally:
        proc.wait(timeout=5)
