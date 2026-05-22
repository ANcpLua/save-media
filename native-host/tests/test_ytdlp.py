from pathlib import Path

from savemedia_host.ytdlp import QUALITY_TO_FORMAT, build_argv, safe_output_name


def test_build_argv_uses_quality_format(tmp_path: Path):
    argv = build_argv("https://example.com/v", "1080p", tmp_path)
    assert argv[0] == "yt-dlp"
    assert "--format" in argv
    assert argv[argv.index("--format") + 1] == QUALITY_TO_FORMAT["1080p"]
    assert argv[-1] == "https://example.com/v"


def test_build_argv_defaults_to_best(tmp_path: Path):
    argv = build_argv("https://example.com/v", "weird-quality", tmp_path)
    assert argv[argv.index("--format") + 1] == QUALITY_TO_FORMAT["best"]


def test_build_argv_never_invokes_shell(tmp_path: Path):
    # The host runs yt-dlp via explicit argv; assert nothing in the argv looks
    # like a shell metacharacter sequence that would matter if it were ever
    # shell-evaluated (paranoia: future regression guard).
    argv = build_argv("https://example.com/v?a=1&b=2", "best", tmp_path)
    joined = " ".join(argv)
    for forbidden in (";", "|", "`", "&&", "$("):
        assert forbidden not in joined.replace("&b=2", ""), f"unexpected {forbidden!r} in argv"


def test_build_argv_creates_output_dir(tmp_path: Path):
    target = tmp_path / "videos"
    build_argv("https://x", "best", target)
    assert target.exists()


def test_safe_output_name_strips_path_separators():
    assert "/" not in safe_output_name("a/b")
    assert "\\" not in safe_output_name("a\\b")
