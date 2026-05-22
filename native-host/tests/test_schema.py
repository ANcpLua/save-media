import pytest

from savemedia_host.schema import SchemaError, validate_request


def test_unknown_type_rejected():
    with pytest.raises(SchemaError, match="unknown request type"):
        validate_request({"type": "nope", "nonce": "n"})


def test_missing_nonce_rejected():
    with pytest.raises(SchemaError, match="nonce"):
        validate_request({"type": "ping", "version": "1"})


def test_ping_requires_version():
    with pytest.raises(SchemaError, match="version"):
        validate_request({"type": "ping", "nonce": "n"})
    assert validate_request({"type": "ping", "nonce": "n", "version": "1"})["type"] == "ping"


def test_ytdlp_requires_url_quality_outputdir():
    base = {"type": "download.ytdlp", "nonce": "n", "quality": "best", "outputDir": "/tmp"}
    with pytest.raises(SchemaError, match="url"):
        validate_request(base)
    assert validate_request({**base, "url": "https://x"})["type"] == "download.ytdlp"


def test_sink_chunk_requires_int_offset():
    msg = {
        "type": "sink.chunk",
        "nonce": "n",
        "sinkId": "s",
        "dataB64": "AAAA",
        "offset": "0",  # wrong type
    }
    with pytest.raises(SchemaError, match="offset"):
        validate_request(msg)


def test_sink_open_expected_size_optional_but_typed():
    assert validate_request({"type": "sink.open", "nonce": "n", "filename": "v.mp4"})
    assert validate_request({"type": "sink.open", "nonce": "n", "filename": "v.mp4", "expectedSize": None})
    with pytest.raises(SchemaError, match="expectedSize"):
        validate_request({"type": "sink.open", "nonce": "n", "filename": "v.mp4", "expectedSize": "1024"})


def test_top_level_must_be_object():
    with pytest.raises(SchemaError, match="object"):
        validate_request("nope")
