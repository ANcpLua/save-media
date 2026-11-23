# savemedia helper (native host)

The savemedia helper is an optional program for the savemedia browser
extension. You install it yourself. When you turn on the **Local downloader**
in the popup, the extension can hand a page address to the helper, which runs
the yt-dlp and ffmpeg you installed. The browser talks to it over native
messaging; nothing else does.

## Policy

- User-installed tools only. The helper locates `yt-dlp` and `ffmpeg` on
  `PATH` and in the usual per-user install locations. It never downloads,
  bundles, updates, or installs them.
- DRM is refused. If `yt-dlp`'s own format data marks every video format of
  the page as DRM protected, the helper reports `drm_protected` and stops. No
  key handling of any kind. Words in a title, a warning or an error line never
  decide this. The extension's Alt+S fallback and its offer under a failed
  save are never made for media it has found to be protected. **Save this page
  with yt-dlp** hands over the page address whatever the extension found on
  the page, and relies on this check.
- The network is the user's. The helper passes `yt-dlp` no proxy, no resolver
  and no option that skips a certificate check.
- No made-up location. The helper turns off `yt-dlp`'s geographic bypass
  (`--no-geo-bypass`), which would send a made-up `X-Forwarded-For` address to
  sites limited to some countries. A video the site does not offer where you
  are fails with the site's own answer. The flag is on the command line, so a
  yt-dlp configuration file cannot turn the bypass back on.
- No time limit on a save that is making progress. The helper ends a run
  only when `yt-dlp` has written nothing for 5 minutes (60 minutes while
  ffmpeg joins the tracks, which prints nothing).
- Cookies are never logged. Unless you choose **No cookies**, the name of
  this browser, or of the browser you pick under Cookies, is passed to
  `yt-dlp`, which reads that browser's cookies itself. Nothing else about the
  cookies touches the log. The log holds no page addresses.
- Save only what you have the right to keep.

## Requirements

- Python 3.9 or newer (`python3` on `PATH`).
- `yt-dlp` and `ffmpeg` installed by you. On macOS, for example:
  `brew install yt-dlp ffmpeg`. On Linux, use your distribution's package
  manager for `ffmpeg` and `python3 -m pip install --user yt-dlp`.
- macOS or Linux. Windows is not covered by `install.sh`.

The helper looks for the tools on `PATH`, then in `/opt/homebrew/bin`,
`/usr/local/bin`, `~/.local/bin`, and `~/Library/Python/*/bin`.

## Install

Quickest: open the savemedia popup, open **Local downloader**, tick **Use
yt-dlp** and copy the command it shows. It is this one with your extension id filled in:

```sh
curl -fsSL https://raw.githubusercontent.com/ANcpLua/save-media/main/packages/native-host/setup.sh \
  | bash -s -- --extension-id <id>
```

`setup.sh` downloads `host.py` and `install.sh` into
`~/Library/Application Support/savemedia/native-host` (macOS) or
`~/.local/share/savemedia/native-host` (Linux), removes helper files that
earlier versions installed there, and runs the installer. It does not install
yt-dlp or ffmpeg; if they are missing it prints the `brew install` line to run.

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

Then delete this directory. The helper keeps two more files, which you can
delete too:

| File | macOS | Linux |
| --- | --- | --- |
| Its log: job ids, sizes, failure codes, no page addresses. It rotates at 2 MB and keeps three older files. | `~/Library/Logs/savemedia-host.log` | `$XDG_STATE_HOME/savemedia/host.log` (default `~/.local/state/savemedia/host.log`) |
| yt-dlp's download archive: the site and video ID of each video saved, so a video is not saved twice. | `~/Library/Application Support/savemedia/download-archive.txt` | `$XDG_STATE_HOME/savemedia/download-archive.txt` |

## Protocol

Framing follows the browser native messaging convention: a 4-byte
native-endian unsigned length followed by that many bytes of UTF-8 JSON, in
both directions. The helper stays alive until the extension closes the port
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
| `pong` | `hostVersion`, `protocolVersion` (2), `ytdlp` and `ffmpeg` as `{found, version, path}`, `outputDir` |
| `progress` | `id`, `phase` (`probing`, `downloading`, `merging`), `downloadedBytes`, `totalBytes`, `percent`, `speedBytesPerSec`, `etaSeconds` (each may be null). Throttled to about four per second; phase changes are sent immediately. |
| `complete` | `id`, `filename`, `path`, `bytes` |
| `failed` | `id`, `code`, `message` |

Every `download` ends with exactly one `complete` or `failed`. Unknown or
malformed messages produce `failed` with code `invalid_request`.

A failure can also include `httpStatus`: the HTTP status number in `yt-dlp`'s
final error line, when that line names one. The extension explains the status
in plain words and shows the number and the helper's line under Technical
details, as the rows "HTTP status" and "Helper said". Neither appears in the
main text.

A `download` request may carry `allowWithoutCookies: true` (the popup's
automatic cookie setting). The helper then looks for the selected browser's
cookie database in the file system before it starts `yt-dlp`, and runs without
browser cookies when there is none. A browser the user selected is always
passed to `yt-dlp` as it is. Selecting **No cookies** also overrides cookie
options from the user's yt-dlp configuration. Missing media fragments end the
download.

The extension reads `protocolVersion` before it uses the helper. Protocol 2
is the one described here; protocol 1 had neither `allowWithoutCookies` nor
`httpStatus`. When the installed helper reports a lower number than the
extension speaks, the popup says **Helper needs an update** and shows the
setup command, and nothing is saved with that helper until it is updated.
`PROTOCOL_VERSION` in `host.py` and `NATIVE_PROTOCOL_VERSION` in the
extension's `src/types/native.ts` change together.

### Failure codes

| Code | Meaning |
| --- | --- |
| `ytdlp_missing` | `yt-dlp` was not found. Install it yourself. |
| `ffmpeg_missing` | `ffmpeg` was not found. Install it yourself. |
| `drm_protected` | `yt-dlp`'s format data says every video format is DRM protected. Refused. |
| `timeout` | `yt-dlp` wrote nothing for 5 minutes (60 minutes while ffmpeg joins the tracks), so the helper ended the run. The length of a run is never the reason. |
| `cancelled` | Stopped by a `cancel` message. |
| `already_saved` | yt-dlp found this video in the download archive (it ends with exit status 101, `--break-on-existing`). |
| `invalid_request` | The message was malformed or a field failed validation. The popup's hint is to update the helper, and it shows the setup command with that hint. |
| `unknown` | Anything else. `message` carries the last `yt-dlp` error line, and `httpStatus` the status that line names, if any. |

The protocol's codes `unsupported_url`, `login_required`, `geo_restricted` and
`network` belonged to helpers that read the words of `yt-dlp`'s error text.
This helper reports such failures as `unknown` with the line itself. The
extension has plain text for every code, old and new
(`localFailureMessage` in `packages/extension/src/ui/text.ts`).

### How yt-dlp is invoked

Progressive files, HLS, and DASH are all handled by the native `yt-dlp`
downloader; `ffmpeg` is used only for merging separate video and audio
streams. Quality maps to these format selectors:

- `best`: `bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best`
- `1080`, `720`, `480`: `bestvideo[height<=N][ext=mp4]+bestaudio[ext=m4a]/best[height<=N]/best`

Completed files go in a dated part-of-day folder, for example
`2026-01-05 1 Night/2026-01-05_030405.mp4`. Concurrent saves receive
distinct filenames. Each job keeps its partial fragments and unfinished
merges in a temporary directory that the helper cleans on success, failure
or cancellation. That directory is also yt-dlp's home path and working
directory for the job, so a `yt-dlp.conf` that a web page drops into the
Downloads folder is never read. Your own yt-dlp configuration in your home
folder still applies. A video already recorded in the yt-dlp archive returns
`already_saved`.

## Tests

From the repository root:

```sh
python3 -m unittest discover -s packages/native-host
```

The tests spawn the helper with a temporary `HOME` so the log stays isolated.

`RealYtDlpTest` runs the helper against the installed `yt-dlp` and a loopback
server: protection read from format data, the archive hit and the last error
line. It needs `yt-dlp` and `ffmpeg` and is skipped without them. CI runs it
against the pinned `YT_DLP_VERSION` in the Chromium e2e job, with
`SAVEMEDIA_REQUIRE_YTDLP=1`, which turns a missing tool into a failure.

`bun run smoke:native` at the repository root exercises the popup and the
helper against a loopback server. It needs `python3`, `yt-dlp`, `ffmpeg` and
`ffprobe` on `PATH` and says which one is missing. It uses a temporary helper
home with an empty cookie profile, checks the finished file with ffprobe and
tests a server that never answers in time.
