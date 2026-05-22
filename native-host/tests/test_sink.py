import base64
import hashlib
from pathlib import Path

import pytest

from savemedia_host.sink import SinkError, SinkRegistry


@pytest.fixture()
def registry(tmp_path: Path) -> SinkRegistry:
    return SinkRegistry(root=tmp_path)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def test_open_chunk_close_round_trip(registry: SinkRegistry, tmp_path: Path):
    sink = registry.open("clip.mp4", expected_size=6)
    registry.chunk(sink.sink_id, 0, b64(b"abc"))
    registry.chunk(sink.sink_id, 3, b64(b"def"))
    final_path, checksum, bytes_written = registry.close(sink.sink_id, sha256(b"abcdef"))
    assert final_path.read_bytes() == b"abcdef"
    assert bytes_written == 6
    assert checksum == sha256(b"abcdef")
    # tmp file removed
    assert not sink.tmp_path.exists()


def test_chunk_out_of_order_rejected(registry: SinkRegistry):
    sink = registry.open("clip.mp4", expected_size=None)
    registry.chunk(sink.sink_id, 0, b64(b"ab"))
    with pytest.raises(SinkError, match="out-of-order"):
        registry.chunk(sink.sink_id, 100, b64(b"cd"))


def test_unknown_sink_id_rejected(registry: SinkRegistry):
    with pytest.raises(SinkError, match="unknown sinkId"):
        registry.close("nope", "")


def test_checksum_mismatch_deletes_tmp_and_raises(registry: SinkRegistry):
    sink = registry.open("clip.mp4", expected_size=None)
    registry.chunk(sink.sink_id, 0, b64(b"abcdef"))
    with pytest.raises(SinkError, match="checksum mismatch"):
        registry.close(sink.sink_id, "deadbeef")
    assert not sink.tmp_path.exists()
    assert not sink.final_path.exists()


def test_size_mismatch_deletes_tmp_and_raises(registry: SinkRegistry):
    sink = registry.open("clip.mp4", expected_size=10)
    registry.chunk(sink.sink_id, 0, b64(b"abc"))
    with pytest.raises(SinkError, match="size mismatch"):
        registry.close(sink.sink_id, sha256(b"abc"))
    assert not sink.tmp_path.exists()


def test_abort_removes_tmp_and_returns_partial_bytes(registry: SinkRegistry):
    sink = registry.open("clip.mp4", expected_size=None)
    registry.chunk(sink.sink_id, 0, b64(b"abc"))
    discarded = registry.abort(sink.sink_id)
    assert discarded == 3
    assert not sink.tmp_path.exists()


def test_uniquifies_existing_filenames(registry: SinkRegistry, tmp_path: Path):
    (tmp_path / "clip.mp4").write_bytes(b"existing")
    sink = registry.open("clip.mp4", expected_size=None)
    registry.chunk(sink.sink_id, 0, b64(b"new"))
    final_path, _, _ = registry.close(sink.sink_id, sha256(b"new"))
    assert final_path.name == "clip (1).mp4"
    assert (tmp_path / "clip.mp4").read_bytes() == b"existing"


def test_filename_sanitization(registry: SinkRegistry, tmp_path: Path):
    sink = registry.open("../../etc/passwd", expected_size=None)
    assert "/" not in sink.tmp_path.name
    assert ".." not in sink.tmp_path.name
