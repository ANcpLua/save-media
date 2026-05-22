"""Streaming sink for >2GB downloads.

The browser opens a sink with sink.open, streams data via sink.chunk
(base64-encoded 1MB max each per the spec), then commits with sink.close
(passes a final sha256 the browser computed alongside the bytes). We
fsync every 64 MB and rename on commit.
"""
from __future__ import annotations

import base64
import hashlib
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

from .paths import sanitize_filename, sink_root

FSYNC_EVERY_BYTES = 64 * 1024 * 1024


class SinkError(Exception):
    """Raised on sink protocol violations or I/O errors."""


@dataclass
class Sink:
    sink_id: str
    tmp_path: Path
    final_path: Path
    expected_size: int | None
    bytes_written: int = 0
    bytes_since_fsync: int = 0
    sha: "hashlib._Hash | None" = None
    closed: bool = False

    def write(self, offset: int, data: bytes) -> int:
        if self.closed:
            raise SinkError("sink already closed")
        if offset != self.bytes_written:
            raise SinkError(f"out-of-order chunk: expected offset {self.bytes_written}, got {offset}")
        with self.tmp_path.open("ab") as fh:
            fh.write(data)
            self.bytes_written += len(data)
            self.bytes_since_fsync += len(data)
            if self.bytes_since_fsync >= FSYNC_EVERY_BYTES:
                fh.flush()
                os.fsync(fh.fileno())
                self.bytes_since_fsync = 0
        if self.sha is not None:
            self.sha.update(data)
        return self.bytes_written

    def commit(self, expected_checksum: str) -> tuple[Path, str]:
        if self.closed:
            raise SinkError("sink already closed")
        actual = self.sha.hexdigest() if self.sha is not None else ""
        if expected_checksum and actual and expected_checksum.lower() != actual.lower():
            self.abort()
            raise SinkError(f"checksum mismatch: expected {expected_checksum}, got {actual}")
        if self.expected_size is not None and self.bytes_written != self.expected_size:
            self.abort()
            raise SinkError(f"size mismatch: expected {self.expected_size}, wrote {self.bytes_written}")
        with self.tmp_path.open("ab") as fh:
            fh.flush()
            os.fsync(fh.fileno())
        target = _uniquify(self.final_path)
        self.tmp_path.replace(target)
        self.closed = True
        return target, actual

    def abort(self) -> int:
        discarded = self.bytes_written
        if not self.closed and self.tmp_path.exists():
            self.tmp_path.unlink(missing_ok=True)
        self.closed = True
        return discarded


def _uniquify(target: Path) -> Path:
    """If `target` exists, append ` (1)`, ` (2)`, … before the extension."""
    if not target.exists():
        return target
    stem, ext = target.stem, target.suffix
    parent = target.parent
    i = 1
    while True:
        candidate = parent / f"{stem} ({i}){ext}"
        if not candidate.exists():
            return candidate
        i += 1


class SinkRegistry:
    def __init__(self, root: Path | None = None) -> None:
        self._root = root or sink_root()
        self._sinks: dict[str, Sink] = {}

    def open(self, filename: str, expected_size: int | None) -> Sink:
        safe = sanitize_filename(filename)
        final = self._root / safe
        tmp = final.with_suffix(final.suffix + ".tmp")
        if tmp.exists():
            tmp.unlink()
        tmp.touch()
        sink_id = secrets.token_hex(8)
        sink = Sink(
            sink_id=sink_id,
            tmp_path=tmp,
            final_path=final,
            expected_size=expected_size,
            sha=hashlib.sha256(),
        )
        self._sinks[sink_id] = sink
        return sink

    def chunk(self, sink_id: str, offset: int, data_b64: str) -> int:
        sink = self._require(sink_id)
        data = base64.b64decode(data_b64)
        return sink.write(offset, data)

    def close(self, sink_id: str, expected_checksum: str) -> tuple[Path, str, int]:
        sink = self._require(sink_id)
        final_path, actual = sink.commit(expected_checksum)
        bytes_written = sink.bytes_written
        del self._sinks[sink_id]
        return final_path, actual, bytes_written

    def abort(self, sink_id: str) -> int:
        sink = self._require(sink_id)
        discarded = sink.abort()
        del self._sinks[sink_id]
        return discarded

    def _require(self, sink_id: str) -> Sink:
        sink = self._sinks.get(sink_id)
        if sink is None:
            raise SinkError(f"unknown sinkId: {sink_id}")
        return sink
