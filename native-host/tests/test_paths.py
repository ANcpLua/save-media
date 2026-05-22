from savemedia_host.paths import sanitize_filename


def test_strips_path_separators():
    assert sanitize_filename("a/b\\c") == "a_b_c"


def test_strips_null_bytes_and_control():
    assert "\x00" not in sanitize_filename("clip\x00name.mp4")


def test_replaces_dotdot():
    assert ".." not in sanitize_filename("../etc/passwd")


def test_strips_trailing_dots_and_spaces():
    assert sanitize_filename("filename...   ") == "filename"


def test_windows_reserved_names_prefixed():
    assert sanitize_filename("CON.txt").startswith("_")
    assert sanitize_filename("LPT1.mp4").startswith("_")


def test_truncates_to_max_length_preserving_extension():
    out = sanitize_filename("a" * 250 + ".mp4", max_length=64)
    assert len(out) == 64
    assert out.endswith(".mp4")


def test_empty_falls_back_to_file():
    assert sanitize_filename("///") == "file"
