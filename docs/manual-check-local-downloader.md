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
bun packages/extension/tests/e2e/fixture-server.mjs
```

It serves `http://127.0.0.1:5174/` with fixture pages: `/page/direct.html`
(direct MP4), `/page/hls.html` (plain HLS VOD), `/page/dash.html` (clear DASH
whose byte ranges leave a gap, which the in-browser engine cannot assemble;
the fixture does not serve the file that manifest names) and
`/page/widevine.html` (DASH with a ContentProtection element, refused
everywhere).

## Edge

1. `edge://extensions`, Developer mode on, "Load unpacked", pick
   `packages/extension/dist-chrome`. Note the extension id shown on the card.
2. Open the popup, open **Local downloader** and tick **Use yt-dlp**.
   Expected: Edge shows a permission prompt for "Communicate with cooperating
   native applications". Accept. Yes/No: the prompt appeared and the box stays
   ticked after accepting.
3. The pill next to the heading says **Helper not installed** and the popup
   shows a setup command. Copy it, run it in a terminal. Expected output ends
   with the tool check listing yt-dlp and ffmpeg paths. Yes/No.
   On a computer where a helper from an earlier version is installed, the
   pill says **Helper needs an update** instead, with the same setup command.
   The setup command downloads the helper from the main branch. To check a
   build that is not on the main branch yet, run
   `packages/native-host/install.sh --extension-id <id>` from the checkout
   instead.
4. Close and reopen the popup. Expected: the pill says **Ready**, with the
   yt-dlp and ffmpeg versions and the folder files are saved to below it.
   Yes/No.
5. Open `http://127.0.0.1:5174/page/direct.html` and press Alt+S. Expected:
   toast "Saving, Best quality" with a size, then "Saved" with the file name.
   The browser engine saves it; nothing is handed to yt-dlp. Yes/No.
6. Open `http://127.0.0.1:5174/page/dash.html` and press Alt+S. Expected:
   toast "Saving, With yt-dlp on this computer". The hand-over is what this
   step checks: the fixture does not serve the file, so yt-dlp cannot finish
   and the run ends in "Not saved". Yes/No.
7. Open `http://127.0.0.1:5174/page/widevine.html` and press Alt+S. Expected:
   toast "Not saved, Protected video", nothing handed to yt-dlp, nothing
   downloaded. Yes/No.
8. Untick **Use yt-dlp**. Expected: the pill goes away and Alt+S on the DASH
   page now ends with "Not saved, Can't save this stream in the browser",
   never with a local job. The popup's card for that stream says "The Local
   downloader below can try this page with yt-dlp." Yes/No.

## Firefox

1. `about:debugging#/runtime/this-firefox`, "Load Temporary Add-on", pick
   `packages/extension/dist-firefox/manifest.json`.
2. Open the popup, open **Local downloader** and tick **Use yt-dlp**.
   Expected: Firefox shows the permission prompt in the same click (if it does not appear, that is
   the `await` before `permissions.request` regression, report it). Accept.
   Yes/No.
3. Run the setup command from the popup. Expected: it writes the manifest
   into `~/Library/Application Support/Mozilla/NativeMessagingHosts`
   (macOS) or `~/.mozilla/native-messaging-hosts` (Linux). Yes/No.
4. Steps 4 to 8 as in Edge. Yes/No each.

## What to send back

The eight yes/no answers per browser, the browser version, and for any "no"
the exact text on screen. The savemedia helper's log is at
`~/Library/Logs/savemedia-host.log` (macOS) or
`~/.local/state/savemedia/host.log` (Linux); attach the last twenty lines for
a failed step 6 or 7.
