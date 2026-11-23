# Manual check: the edge cases no test can reach

The automated suites already prove the happy paths and every refusal against
local fixtures: `bun run --filter './packages/*' test` (unit), `bun run
--filter @savemedia/extension test:e2e:chromium` (headless e2e, ffprobe on
the saved files), `smoke:edge` and `smoke:firefox` (real browsers). Nothing
below repeats those.

What is left needs a person: browser chrome the extension cannot drive, a
keyboard, a network cable, and judgement about whether a sentence in the popup
actually reads well. Every step is a yes or no. Write the answer next to the
number, and for a no write what you saw instead.

Scope rule: every target here is a local fixture. Do not point these steps at
a third-party site, not even to check.

## Setup, once per browser

```sh
bun install
bun run --filter @savemedia/core build
bun run --filter @savemedia/extension build:all      # dist-chrome + dist-firefox
bun packages/extension/tests/e2e/fixture-server.mjs  # serves http://127.0.0.1:5174
```

Keep the fixture server running in its own terminal for the whole session.
`brew install ffmpeg` if `ffprobe` is missing; several steps ask you to probe a
saved file.

| Browser | Load the build |
|---|---|
| Chrome | `chrome://extensions`, Developer mode on, **Load unpacked**, pick `packages/extension/dist-chrome` |
| Edge | `edge://extensions`, Developer mode on, **Load unpacked**, pick `packages/extension/dist-chrome` (Edge ships the Chromium build verbatim) |
| Firefox | `about:debugging#/runtime/this-firefox`, **Load Temporary Add-on**, pick `packages/extension/dist-firefox/manifest.json` |

Note the extension id the card shows; a few steps below use it.

**Check the shortcut before any Alt+S step.** A browser gives a key to one
extension only. If another copy of savemedia is installed (the store version,
also when it is switched off) or another extension uses Alt+S, the copy you
just loaded gets no shortcut: Alt+S then does nothing on any page, and the
popup header reads "No keyboard shortcut is set, so Alt+S does nothing." with
a **Set shortcut** link. Open `chrome://extensions/shortcuts`
(`edge://extensions/shortcuts` in Edge), find the savemedia you loaded, and
set "Save the video or image under the pointer, or the main video of the
page" to Alt+S, or remove the other copy and press Reload on the card. The
popup header must read "Alt+S saves the video or image under the pointer, or
this page's main video." before you go on.

**Rebuilding under a loaded unpacked extension breaks it silently**: the
content scripts keep injecting from disk, but the service worker is gone, so
Alt+S does nothing and the popup cannot reach the background. After any
rebuild, press Reload on the extension card before testing again.

## Part A: the baseline, five minutes

Open each page, press Alt+S, and compare the toast. This is the same matrix
the e2e covers, so a mismatch here means the build or the load is wrong and
the rest of the session is meaningless. Run it in all three browsers.

| # | Page (prefix `http://127.0.0.1:5174/page/`) | Expected toast | Yes/No |
|---|---|---|---|
| A1 | `direct.html` | Saving, Best quality with a size; then Saved with the file name | |
| A2 | `hls.html` | Saving, then Saved with the file name | |
| A3 | `hls-fmp4.html` | Saving, then Saved | |
| A3a | `hls-single-file-fmp4.html`, `hls-single-file-ts.html` | Saving, then Saved (HLS kept in one file, listed as byte ranges) | |
| A4 | `av-merge.html` | Saving, then Saved | |
| A5 | `hls-aes.html` | Saving, then Saved (AES-128 is decrypted) | |
| A6 | `dash-clear.html` | Saving, then Saved (DASH video and audio joined) | |
| A6a | `dash-video-only.html` | Saving, then Saved (DASH that declares no audio, saved with its picture alone) | |
| A6b | `dash-single-file.html`, `dash-on-demand.html` | Saving, then Saved (DASH kept in one file per track) | |
| A7 | `dash.html` | Not saved, Can't save this stream in the browser | |
| A8 | `hls-live.html` | Not ready or Not saved, Live stream | |
| A9 | `hls-fairplay.html` | Not saved, Protected video | |
| A10 | `hls-sample-aes.html` | Not saved, Protected video | |
| A11 | `widevine.html` | Not saved, Protected video (never Nothing to save) | |
| A12 | `clearkey.html` | Not saved, Protected video (never Nothing to save) | |
| A12a | `fetch-blob.html` | Saving, This video; then Saved (a file the page fetched with a script and plays from memory) | |
| A12b | `named-preview.html` | Saving, This video, and "The file this page names has not reached your browser yet."; the popup shows the same under the card, and the card is not titled Holiday.Trip.2024.1080p.mkv | |
| A12c | `canvas-unattached-control.html`, pointer on the square at the left of the canvas | Saving, then Saved with the video's name, never an image | |
| A13 | `negative.html` | Nothing to save, No media detected on this page; the toolbar icon flashes ∅ | |
| A14 | `low.html` | Saving, then Saved (see note) | |

In every toast the bold label says the state (Saving, Saved, Not saved) and
the text after it says the object or the reason. A label that is repeated in
the text is a bug.

A FairPlay or SAMPLE-AES key tag (A9, A10) is read at detection when the
media playlist or the master's session key declares it. If only the job finds
it, the refusal arrives a moment after "Saving".

History, so a regression is recognisable: until 2026-09-13 A9 and A10 stayed
on "Saving" forever, A2 to A6 never said "Saved", and A11 and A12 said
"Nothing to save". The last one was also a boundary bug: "Nothing to save" is
the outcome the local downloader may take over, so a Widevine page could be
delegated. Found by this checklist, now pinned by e2e specs named
"Alt+S on a … page".

A14 is a check on my reading of the code rather than a known-good: there is no
minimum-height gate, so a sub-720p progressive file should save like any other
and its card shows no quality warning. An HLS plan whose variant vanished
between classify and run fails as a malformed playlist, not as a quality
policy, and no automated test uses the `low` fixture for behaviour. If you get
a refusal instead, that is news worth reporting.

A5 and A6 are the two new capabilities. Probe both saved files:

```sh
ffprobe -v error -show_entries stream=codec_type,codec_name -of csv ~/Downloads/<file>
```

A5 must show one h264 stream (the AES fixture is video only), A6 must show
h264 **and** aac in the same file.

## Part B: the edge cases

Unless a step names a browser, run it in all three and give three answers.

**Keyboard and focus**

1. On `direct.html`, click into the address bar, press Alt+S. Expected:
   nothing saved, no toast. The page never saw the key.
2. Add a text field to the page (`about:blank` is not enough, use the console
   on `direct.html`: `document.body.insertAdjacentHTML("beforeend", "<input id=t>"); t.focus()`),
   then press Alt+S. Expected: nothing saved, and on a German layout the
   field shows `ß` or nothing, never a download. This is the rule in
   `packages/extension/src/content/hotkey.ts` (`altSAction` ignores a key
   whose target takes text).
3. Same page, click on the video, press and hold Alt+S for two seconds.
   Expected: exactly one download, not one per repeat. (`event.repeat`.)
4. Press Alt+S twice within a second on `hls.html`. Expected: the second
   press does not start a second identical download while the first runs, and
   its toast says "Saving, Already in progress".
5. Firefox only: open `about:addons`, gear menu, **Manage Extension
   Shortcuts**. Expected: savemedia lists "Save the video or image under the
   pointer, or the main video of the page". If the shortcut is empty, Firefox
   did not assign Alt+S; assign it by hand, then redo A1. Note which case you
   had.

**Service worker and lifetime**

6. Chrome and Edge: open `direct.html`, then leave the browser idle for 60
   seconds without touching the extension (the MV3 service worker unloads
   after about 30 s). Press Alt+S. Expected: the download still starts; the
   worker wakes on the message.
7. Same, but open the popup instead of pressing Alt+S after the idle minute.
   Expected: the popup lists the detected item, not an empty list.
8. Open the popup on `av-merge.html`, then close and reopen it while the
   download runs. Expected: progress continues and the reopened popup shows
   the running job, not a fresh empty state.

   Chrome and Edge, during a running save: open
   `chrome://serviceworker-internals`, find savemedia's worker and press
   **Stop**. Expected: the save finishes once, one file is written, and the
   toolbar icon returns to its normal look.

   Open a tab with `direct.html`, then load or reload the extension on the
   extensions page, and open the popup on that tab without reloading it.
   Expected: "Reload this page so savemedia can see it." with a **Reload
   page** button, not an empty list; after the reload the video is listed.

**Interruption and failure**

9. Start the `av-merge.html` download, then press **Cancel** in the popup
   (the card's one button reads Cancel while the save runs). Expected: the
   card shows "Cancelled" in grey and its button reads Save again, nothing is
   shown as an error, no file is in Downloads, and no `.crdownload` / `.part`
   is left behind.
10. Start `hls.html`, then kill the fixture server in its terminal mid-flight.
    Expected: the card in the popup says the connection was lost and counts
    down to the next try, five times with longer waits (one to two minutes
    in all). Then a failure toast in plain words (a lost connection or a server
    that could not be reached) with what to do, no code in it, and no partial
    file kept. Restart the server afterwards. Variant: restart the server
    within that time. Expected: the save goes on with the segment it was
    reading and ends in Saved, and the file plays to its end. A server that
    hangs takes longer than one that is gone: when it accepts the connection
    and then sends nothing (suspend the server process instead of killing
    it), each try waits 45 seconds for a byte before the card counts down to
    the next one, the progress stands still in between, and the save ends
    as not saved after six such tries, about five minutes in all.
11. Switch the browser to offline (devtools, Network, Offline) and press
    Alt+S on `hls-fmp4.html`. Expected: a network failure refusal, not a
    silent nothing.
12. Navigate away (type a different URL) while a `dash-clear.html` download
    runs. Expected: the download either completes or fails cleanly; no
    zero-byte file.

**Downloads folder behaviour**

13. Turn on "Ask where to save each file" (Chrome/Edge settings, or Firefox
    "Always ask you where to save files"), press Alt+S on `direct.html`, then
    **cancel** the save dialog. Expected: a neutral "Cancelled" toast, no
    failure, nothing written. Turn the setting back off afterwards.
14. Save `direct.html` twice. Expected: two files, the second suffixed by the
    browser (`… (1).mp4`), never an overwrite and never a failure.
15. Open `http://127.0.0.1:5174/page/download-32.html` and press **Save** in
    the popup. Expected: the file is saved as `Färbige Balken 32.mov`, the
    name the page and the server state, with the umlaut and the spaces kept,
    and ffprobe reads it. The popup has no field for a file name.
16. Long names need no step by hand: a name comes from the server or the page
    address and is cut to 180 characters for a file the server names and to
    80 otherwise (`packages/extension/src/util/filename.ts`, checked in
    `tests/unit/util/filename.test.ts`).

**Two things at once**

17. Open `hls.html` and `dash-clear.html` in two tabs and press Alt+S in both
    within a second. Expected: two independent downloads, both playable, no
    mixed-up filenames.
18. Open `direct.html` in two tabs, press Alt+S in the second, and switch back
    to the first while it saves. Expected: the toast belongs to the tab that
    started it.

**Frames and private windows**

19. On `about:blank`, run
    `document.body.insertAdjacentHTML("beforeend", '<iframe src="http://127.0.0.1:5174/page/direct.html" width=700 height=400></iframe>')`,
    click inside the iframe and press Alt+S. Expected: the video is saved and
    the toast appears once, in the top frame only (`window.top === window` in
    `src/content/bridge.ts`).
20. Open a private/incognito window and load `direct.html`. Expected: the
    extension is not active there, and its details page offers no switch to
    allow it in private windows (`"incognito": "not_allowed"` in
    `manifest.json`). Its own requests would carry the normal windows'
    cookies, and its saves would land in their download list.

**How the refusals read**

21. Open the popup on `dash.html`, `hls-fairplay.html`, `hls-live.html` and
    `widevine.html` and read each item's text. Expected: a title that says
    what happened, a body in plain words, a hint that starts with a verb where
    something helps, and codes only after opening **Technical details**. Flag
    any sentence that reads as a promise ("not yet", "coming"), that points at
    a site's own button, or that suggests a way around a block or a
    protection.
22. Read the popup's footer. Expected: "Save only what you have the right to
    keep." exactly once, and nowhere else in the popup, in a toast or on a
    failure.
23. Open the popup on `dash-clear.html` before saving. Expected: one item, a
    resolution and a size estimate that are not obviously wrong (320x180, a
    few tens of kB), and no second phantom item for the audio AdaptationSet.

**Local downloader interaction** (only if you have the host installed)

24. With the Local downloader on, press Alt+S on `dash.html` (the MPD whose
    byte ranges leave a gap, which the in-browser engine cannot assemble).
    Expected: toast "Saving, With yt-dlp on this computer". This is the
    delegation allowlist doing its job. The fixture does not serve the file,
    so the run then ends in "Not saved".
25. With the local downloader on, press Alt+S on `widevine.html`. Expected:
    "Not saved", and **nothing** delegated. If a local run starts here, stop
    and report it: that is the one hard boundary (`DELEGABLE_ERROR_CODES`
    holds no DRM code).

**The user's network, a screen reader, fullscreen**

26. Firefox only (Chromium is covered by `tests/e2e/network-block.spec.ts`
    and `classification.spec.ts`): point a page's video at a host with an
    untrusted certificate, and at a host name that does not exist. Open
    **Technical details** on each failure and write down the exact **Browser
    error** value. Expected titles: "Secure connection not trusted" and
    "Server not found". The Firefox code names in
    `packages/core/src/errors/network-block.ts` (`SEC_ERROR_*`,
    `NS_ERROR_*`) are not verified against a real Firefox; a different value
    here shows the general text and is worth a report.
27. With VoiceOver (macOS) or NVDA (Windows) on, open the popup on a page
    with a failed source. Expected: the failure is not read out on open.
    Then save `hls.html` from the popup. Expected: one announcement per step
    (what was found, "Saving", a stage such as "Joining video and audio",
    "Saved to Downloads"), never the same sentence twice in a row, and a
    failure announced once, as an alert.
28. Put a player in fullscreen (the fixture `http://127.0.0.1:5174/page/direct.html`,
    the player's own fullscreen control) and press Alt+S. Expected: the toast
    is visible above the fullscreen video.

## Part C: browser-specific notes while you test

- **Chrome**: the only browser where the store listing forbids platform
  support beyond fixtures; keep the session local. If the extension card
  shows "Errors", copy them, they are usually a stale rebuild (see Setup).
- **Edge**: same build as Chrome. Edge sometimes keeps its own download
  shelf setting; if step 13 does not show a dialog, check
  `edge://settings/downloads`.
- **Firefox**: a temporary add-on disappears on restart, so reload it after
  every browser restart. Firefox assigns Alt+S less reliably than Chromium
  (step 5), and `smoke:firefox` currently cannot run on Firefox 155 with
  selenium-webdriver 4.44 ("Navigation to moz-extension://… is not allowed
  in this context"), which is exactly why this manual pass matters more there.

## Reporting

Copy this block per browser and fill it in:

```
Browser + version:
Build:            dist-chrome | dist-firefox, commit <sha>
Part A:           A1..A14 all yes? otherwise list
Part B:           1..28, number: yes/no + what you saw
Files probed:     A5, A6, step 16
Anything that felt wrong but passed:
```

A no in Part A is a setup problem. A no in Part B is a bug worth a fixture:
if it is reproducible, it belongs in `tests/e2e/` or a unit test, not only in
this file.
