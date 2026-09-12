# Manual check: the edge cases no test can reach

The automated suites already prove the happy paths and every refusal against
local fixtures: `bun run --filter './packages/*' test` (unit), `bun run
--filter @savemedia/extension test:e2e:chromium` (35 e2e specs, ffprobe on
every saved file), `smoke:edge` and `smoke:firefox` (real browsers). Nothing
below repeats those.

What is left needs a person: browser chrome the extension cannot drive, a
keyboard, a network cable, and judgement about whether a sentence in the popup
actually reads well. Every step is a yes or no. Write the answer next to the
number, and for a no write what you saw instead.

Scope rule from `docs/boundary-rules.md` P3: every target here is a local
fixture. Do not point these steps at a third-party site, not even to check.

## Setup, once per browser

```sh
bun install
bun run --filter @savemedia/core build
bun run --filter @savemedia/extension build:all      # dist-chrome + dist-firefox
node packages/extension/tests/e2e/fixture-server.mjs # serves http://127.0.0.1:5174
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
| A1 | `direct.html` | Saving, then Saved | |
| A2 | `hls.html` | Saving, then Saved | |
| A3 | `hls-fmp4.html` | Saving, then Saved | |
| A4 | `av-merge.html` | Saving, then Saved | |
| A5 | `hls-aes.html` | Saving, then Saved (new: AES-128 is decrypted) | |
| A6 | `dash-clear.html` | Saving, then Saved (new: DASH video+audio merged) | |
| A7 | `dash.html` | Not saved, DASH is not supported | |
| A8 | `hls-live.html` | Not saved, live HLS | |
| A9 | `hls-fairplay.html` | Not saved, protected stream | |
| A10 | `hls-sample-aes.html` | Not saved, protected stream | |
| A11 | `widevine.html` | Not saved, protected stream | |
| A12 | `clearkey.html` | Not saved, ClearKey not implemented | |
| A13 | `negative.html` | Nothing to save, and the toolbar icon flashes ∅ | |
| A14 | `low.html` | Saving, then Saved (see note) | |

A14 is a check on my reading of the code rather than a known-good: there is no
minimum-height gate in `dispatch`, so a sub-720p progressive file should save
like any other. The `no_variant_meets_minimum` refusal exists for an HLS plan
whose variant vanished between classify and run, not as a quality policy, and
no automated test uses the `low` fixture for behaviour. If you get a refusal
instead, that is news worth reporting.

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
   field shows `ß` or nothing, never a download. This is the
   `isEditableTarget` guard.
3. Same page, click on the video, press and hold Alt+S for two seconds.
   Expected: exactly one download, not one per repeat. (`event.repeat`.)
4. Press Alt+S twice within a second on `hls.html`. Expected: the second
   press does not start a second identical download while the first runs.
5. Firefox only: open `about:addons`, gear menu, **Manage Extension
   Shortcuts**. Expected: savemedia lists "Download highest available media
   quality". If the shortcut is empty, Firefox did not assign Alt+S; assign it
   by hand, then redo A1. Note which case you had.

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

**Interruption and failure**

9. Start the `av-merge.html` download, then press cancel in the popup (the
   running item has a cancel control). Expected: no file in Downloads, and no
   `.crdownload` / `.part` left behind.
10. Start `hls.html`, then kill the fixture server in its terminal mid-flight.
    Expected: a failure toast naming a segment or network problem, and no
    partial file kept. Restart the server afterwards.
11. Switch the browser to offline (devtools, Network, Offline) and press
    Alt+S on `hls-fmp4.html`. Expected: a network failure refusal, not a
    silent nothing.
12. Navigate away (type a different URL) while a `dash-clear.html` download
    runs. Expected: the download either completes or fails cleanly; no
    zero-byte file.

**Downloads folder behaviour**

13. Turn on "Ask where to save each file" (Chrome/Edge settings, or Firefox
    "Always ask you where to save files"), press Alt+S on `direct.html`, then
    **cancel** the save dialog. Expected: a failure toast, nothing written.
    Turn the setting back off afterwards.
14. Save `direct.html` twice. Expected: two files, the second suffixed by the
    browser (`… (1).mp4`), never an overwrite and never a failure.
15. Fill the popup's filename field with 200 characters plus `.mp4` and save.
    Expected: either a saved file with a truncated name or a clean failure
    toast; no hang.
16. Put non-ASCII in the filename (`Grüße-测试-🎬.mp4`) and save `hls.html`.
    Expected: the file exists with a readable name and ffprobe still reads it.

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
20. Open a private/incognito window and load `direct.html`. Expected: either
    the extension is not active there at all (the default: extensions are off
    in private windows until you allow it) or, once allowed, Alt+S saves
    normally. Never a console error or a dead popup.

**How the refusals read**

21. Open the popup on `dash.html`, `hls-fairplay.html`, `hls-live.html` and
    `low.html` and read each item's refusal text. Expected: title and body say
    what is wrong and imply no fix the user cannot do. Flag any sentence that
    reads as a promise ("not yet", "coming") or as advice to defeat a
    protection.
22. Specifically re-read the encrypted-HLS text (it changed with AES-128
    support): "This encrypted HLS stream cannot be saved" plus a body that
    says AES-128 with a key in the clear is saved normally. Expected: it makes
    sense to someone who just successfully saved A5 and then hit this on a
    different stream.
23. Open the popup on `dash-clear.html` before saving. Expected: one item, a
    resolution and a size estimate that are not obviously wrong (320x180, a
    few tens of kB), and no second phantom item for the audio AdaptationSet.

**Local downloader interaction** (only if you have the host installed)

24. With the local downloader on, press Alt+S on `dash.html` (the audio-less
    MPD the in-browser engine refuses). Expected: toast "Local downloader",
    then Saved. This is the delegation allowlist doing its job.
25. With the local downloader on, press Alt+S on `widevine.html`. Expected:
    "Not saved", and **nothing** delegated. If a local run starts here, stop
    and report it: that is the one hard boundary (`DELEGABLE_ERROR_CODES`
    holds no DRM code).

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
Part B:           1..25, number: yes/no + what you saw
Files probed:     A5, A6, step 16
Anything that felt wrong but passed:
```

A no in Part A is a setup problem. A no in Part B is a bug worth a fixture:
if it is reproducible, it belongs in `tests/e2e/` or a unit test, not only in
this file.
