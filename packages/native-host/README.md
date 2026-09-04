# savemedia native host

An optional, opt-in native messaging host for the savemedia browser extension.
When enabled, the extension can hand a page URL to this host, and the host runs
the copies of `yt-dlp` and `ffmpeg` that you have already installed on your own
machine. Nothing is bundled and nothing is installed by this package.

## Policy

- User-installed tools only. The host locates `yt-dlp` and `ffmpeg` on `PATH`
  and in the usual per-user install locations. It never downloads, bundles,
  updates, or installs them.
- DRM is refused. If `yt-dlp` reports DRM protected content, the host reports
  the failure code `drm_protected` and stops. No key handling of any kind.
- Personal use. This tool is meant for saving media you are entitled to keep
  for your own use. Respect the terms of the services you use and the rights of
  content owners.
- Cookies are never logged. If you opt into `cookiesFromBrowser`, the browser
  name is passed to `yt-dlp` and nothing else about the cookies touches the log.

## Requirements

- Python 3.9 or newer (`python3` on `PATH`).
- `yt-dlp` and `ffmpeg` installed by you. On macOS, for example:
  `brew install yt-dlp ffmpeg`. On Linux, use your distribution's package
  manager for `ffmpeg` and `python3 -m pip install --user yt-dlp`.
- macOS or Linux. Windows is not covered by `install.sh`.

The host looks for the tools on `PATH`, then in `/opt/homebrew/bin`,
`/usr/local/bin`, `~/.local/bin`, and `~/Library/Python/*/bin`.

## Install

Quickest: open the savemedia popup, switch **Local downloader** on, and copy
the command it shows. It is this one with your extension id filled in:

```sh
curl -fsSL https://raw.githubusercontent.com/ANcpLua/save-media/main/packages/native-host/setup.sh \
  | bash -s -- --extension-id <id>
```

`setup.sh` downloads `host.py` and `install.sh` into
`~/Library/Application Support/savemedia/native-host` (macOS) or
`~/.local/share/savemedia/native-host` (Linux) and runs the installer. It does
not install yt-dlp or ffmpeg; if they are missing it prints the `brew install`
line to run.

From a checkout:

```sh
cd packages/native-host
./install.sh --extension-id <id>
```

This writes the `com.savemedia.host` manifest into the per-user
`NativeMessagingHosts` directory of every browser whose profile directory
already exists (Chrome, Chromium, Edge, Brave, Firefox), marks `host.py`
executable, and prints whether `yt-dlp` and `ffmpeg` were found.

Options:

| Option | Meaning |
| --- | --- |
| `--extension-id <id>` | Chromium extension id to allow. Repeatable. Default is the store id `negbodmpgjhkacmdkbfdpocjanaklifn`. |
| `--firefox-id <id>` | Firefox extension id. Default `savemedia@ancplua.dev`. |
| `--dry-run` | Print the paths that would be written without writing. |
| `--uninstall` | Remove the manifests written earlier. |

Manifest locations:

| Platform | Chromium family | Firefox |
| --- | --- | --- |
| macOS | `~/Library/Application Support/{Google/Chrome, Chromium, Microsoft Edge, BraveSoftware/Brave-Browser}/NativeMessagingHosts` | `~/Library/Application Support/Mozilla/NativeMessagingHosts` |
| Linux | `~/.config/{google-chrome, chromium, microsoft-edge, BraveSoftware/Brave-Browser}/NativeMessagingHosts` | `~/.mozilla/native-messaging-hosts` |

## Uninstall

```sh
./install.sh --uninstall
```

Then delete this directory. The host stores nothing else, apart from its log
at `~/Library/Logs/savemedia-host.log` (macOS) or
`~/.local/state/savemedia/host.log` (Linux).

## Protocol

Framing follows the browser native messaging convention: a 4-byte
native-endian unsigned length followed by that many bytes of UTF-8 JSON, in
both directions. The host stays alive until the extension closes the port
(stdin EOF). Downloads run on worker threads, so `cancel` is handled while a
download is in progress. Only protocol frames are ever written to stdout.

### Extension to host

| Message | Fields |
| --- | --- |
| `ping` | none |
| `download` | `id` (string), `pageUrl` (http or https only), `quality` (`best`, `1080`, `720`, `480`), `cookiesFromBrowser` (`chrome`, `chromium`, `edge`, `firefox`, `brave`, or null), `outputDir` (existing directory under your home, or null for `~/Downloads`) |
| `cancel` | `id` |

### Host to extension

| Message | Fields |
| --- | --- |
| `pong` | `hostVersion`, `protocolVersion` (1), `ytdlp` and `ffmpeg` as `{found, version, path}`, `outputDir` |
| `progress` | `id`, `phase` (`probing`, `downloading`, `merging`), `downloadedBytes`, `totalBytes`, `percent`, `speedBytesPerSec`, `etaSeconds` (each may be null). Throttled to about four per second; phase changes are sent immediately. |
| `complete` | `id`, `filename`, `path`, `bytes` |
| `failed` | `id`, `code`, `message` |

Every `download` ends with exactly one `complete` or `failed`. Unknown or
malformed messages produce `failed` with code `invalid_request`.

### Failure codes

| Code | Meaning |
| --- | --- |
| `ytdlp_missing` | `yt-dlp` was not found. Install it yourself. |
| `ffmpeg_missing` | `ffmpeg` was not found. Install it yourself. |
| `drm_protected` | The content is DRM protected. Refused. |
| `unsupported_url` | `yt-dlp` has no extractor for this URL. |
| `login_required` | The content needs a signed-in session, is private, or is age gated. |
| `geo_restricted` | The content is not available in your region. |
| `network` | Connection failure, HTTP 5xx, or a download that could not be fetched. |
| `timeout` | The download exceeded 30 minutes. |
| `cancelled` | Stopped by a `cancel` message. |
| `invalid_request` | The message was malformed or a field failed validation. |
| `unknown` | Anything else. `message` carries the last `yt-dlp` error line. |

### How yt-dlp is invoked

Progressive files, HLS, and DASH are all handled by the native `yt-dlp`
downloader; `ffmpeg` is used only for merging separate video and audio
streams. Quality maps to these format selectors:

- `best`: `bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best`
- `1080`, `720`, `480`: `bestvideo[height<=N][ext=mp4]+bestaudio[ext=m4a]/best[height<=N]/best`

Output files are named `<title> [<id>].<ext>` inside the output directory.
Cancelling or timing out removes the partial `.part` and `.ytdl` files of that download, including fragment parts and an unfinished per-format file of a merge. If the final file already exists in the output directory, yt-dlp skips the download and the host reports `complete` for the existing file.

## Tests

```sh
python3 test_host.py
```

The tests spawn the host with a temporary `HOME` so the log stays isolated.
