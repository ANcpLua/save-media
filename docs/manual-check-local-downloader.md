# Manual check: local downloader permission prompt

The only part of the local downloader no script can exercise is the browser's
own `nativeMessaging` permission prompt and the popup flow around it. This
takes about ten minutes per browser. Report each numbered step as yes or no.

## Build

```sh
bun install
bun run build:all
```

`packages/extension/dist-chrome` is the Edge build (Edge ships the Chromium
build verbatim), `packages/extension/dist-firefox` is the Firefox build.

Have `yt-dlp` and `ffmpeg` installed (`brew install yt-dlp ffmpeg`), and start
the fixture server in a second terminal so no third-party site is involved:

```sh
node packages/extension/tests/e2e/fixture-server.mjs
```

It serves `http://127.0.0.1:5174/` with fixture pages: `/page/direct.html`
(direct MP4), `/page/hls.html` (plain HLS VOD), `/page/dash.html` (clear DASH,
refused by the in-browser engine) and `/page/widevine.html` (DASH with a
ContentProtection element, refused everywhere).

## Edge

1. `edge://extensions`, Developer mode on, "Load unpacked", pick
   `packages/extension/dist-chrome`. Note the extension id shown on the card.
2. Open the popup, switch **Local downloader** on. Expected: Edge shows a
   permission prompt for "Communicate with cooperating native applications".
   Accept. Yes/No: the prompt appeared and the switch stays on after accepting.
3. The popup shows a setup command. Copy it, run it in a terminal. Expected
   output ends with the tool check listing yt-dlp and ffmpeg paths. Yes/No.
4. Close and reopen the popup. Expected: the Local downloader row says
   **Ready** with the yt-dlp and ffmpeg versions. Yes/No.
5. Open `http://127.0.0.1:5174/page/direct.html` and press Alt+S. Expected: the
   in-browser engine saves the file (toast "Saving", then "Saved"). Yes/No.
6. Open `http://127.0.0.1:5174/page/dash.html` (a DASH page the in-browser engine
   refuses) and press Alt+S. Expected: toast "Local downloader" (delegated),
   then "Saved" with the filename; the file lands in `~/Downloads`. Yes/No.
7. Open `http://127.0.0.1:5174/page/widevine.html` and press Alt+S. Expected: toast "Not
   saved" naming protected media, nothing delegated, nothing downloaded. Yes/No.
8. Switch Local downloader off in the popup. Expected: the row returns to
   its off state and Alt+S on the DASH page now ends with "Nothing to save"
   or "Not saved", never a delegation. Yes/No.

## Firefox

1. `about:debugging#/runtime/this-firefox`, "Load Temporary Add-on", pick
   `packages/extension/dist-firefox/manifest.json`.
2. Open the popup, switch **Local downloader** on. Expected: Firefox shows
   the permission prompt in the same click (if it does not appear, that is
   the `await` before `permissions.request` regression, report it). Accept.
   Yes/No.
3. Run the setup command from the popup. Expected: it writes the manifest
   into `~/Library/Application Support/Mozilla/NativeMessagingHosts`
   (macOS) or `~/.mozilla/native-messaging-hosts` (Linux). Yes/No.
4. Steps 4 to 8 as in Edge. Yes/No each.

## What to send back

The eight yes/no answers per browser, the browser version, and for any "no"
the exact text on screen. The host log is at
`~/Library/Logs/savemedia-host.log` (macOS) or
`~/.local/state/savemedia/host.log` (Linux); attach the last twenty lines for
a failed step 6 or 7.
