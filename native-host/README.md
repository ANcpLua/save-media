# savemedia native host

Optional Python 3 native messaging host that backs three power-tool flows:

- `download.ytdlp` — yt-dlp escalation for cookie-bound CDNs that defeat the
  in-browser engine.
- `sink.open` / `sink.chunk` / `sink.close` / `sink.abort` — streaming sink
  for files larger than 2 GB or for destinations the browser's Downloads API
  cannot reach.
- `probe` — ffprobe wrapper that returns muxer + codec info as JSON.

The host runs as an unprivileged user. All input is shape-validated; no
`shell=True`; filenames are sanitised; subprocesses are time-boxed. Logs
land at `~/Downloads/save-media/host.log` with URL-hash redaction unless
`SAVEMEDIA_DEBUG_URLS=1` is set.

## Layout

```
native-host/
  host.py                # entry point — Chrome native messaging protocol
  savemedia_host/
    __init__.py
    protocol.py          # length-prefixed JSON framing
    schema.py            # request / response validation
    sink.py              # streaming sink + checksum
    ytdlp.py             # yt-dlp argv builder + runner
    probe.py             # ffprobe wrapper
    logging_setup.py     # rotating file logger with URL redaction
    paths.py             # cross-platform downloads directory resolution
  tests/
    test_protocol.py
    test_schema.py
    test_sink.py
    test_ytdlp.py
    test_probe.py
  pyproject.toml         # python deps + dev tooling
  build.spec             # PyInstaller spec
  scripts/
    install.sh           # cross-platform installer (calls Python helper)
    install.py           # browser detection + manifest/registry writer
    smoketest.py         # spawns the binary and exchanges ping/pong
```

## Dev

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -e .[dev]
pytest -q
```

## Build

```sh
pip install pyinstaller
pyinstaller build.spec --clean --noconfirm
# emits dist/savemedia-host-<platform>-<arch>(.exe)
```
