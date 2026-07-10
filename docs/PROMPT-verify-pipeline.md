# Task: Fix broken features & build an end-to-end verification pipeline for SaveMedia

## Context (you have no other context — everything you need is here or in the repo)

- Repo: the repo root — a pnpm-workspace browser extension (Manifest V3) called **SaveMedia** that downloads media (progressive files, demuxed HLS, clear DASH, YouTube adaptive with audio+video merging, Twitter/X and Instagram support).
- It is published on the Edge Add-ons store: https://microsoftedge.microsoft.com/addons/detail/savemedia/mmkdllnjmommekajhadhokanofjlglhk (installable in Edge via `edge://extensions/?id=mmkdllnjmommekajhadhokanofjlglhk`).
- Work directly on `main`, commit and push when done (this is the repo owner's standing policy).

## Known bug to fix first

**The `Alt+S` keyboard shortcut does nothing.** The extension advertises Alt+S to trigger a download of the media on the current page, but pressing it downloads nothing (observed in Edge). Investigate the `commands` entry in the manifest and its handler in the service worker / content scripts, find why it's dead (unregistered command, missing listener, key conflict, handler that silently fails, etc.), and fix it.

## Main task: audit all promised features, then build a verification pipeline

1. **Inventory the promises.** Read the README, store-listing text in the repo (if any), popup/options UI strings, and manifest. Produce a checklist of every user-facing feature the extension claims (per-site support, shortcuts, merge engine, quality selection, etc.).

2. **Verify each claim end-to-end.** For each feature, actually exercise it — load the unpacked extension in a Chromium browser (headless or via Playwright/Puppeteer with `--load-extension`), drive a real or fixture page, and observe the real outcome (a download happens, a merged file is produced, the popup shows the item, etc.). Record pass/fail. Fix what's broken where feasible; file the rest in a `KNOWN-ISSUES.md`.

3. **Turn those checks into a permanent E2E test suite** (this is the deliverable):
   - Use Playwright with a persistent Chromium context loading the built extension (`chromium.launchPersistentContext(..., args: ['--load-extension=<dist>', '--disable-extensions-except=<dist>'])`).
   - Serve **local fixture pages** (static HTML + sample MP4/HLS/DASH assets under `tests/fixtures/`, served by a tiny local HTTP server) so tests are deterministic and don't depend on YouTube/Twitter being reachable. Where a real-site smoke test is valuable, mark it as an optional/nightly tagged test.
   - Cover at minimum: progressive MP4 download, HLS download+merge, DASH download+merge, the Alt+S shortcut (use CDP `Input.dispatchKeyEvent` or Playwright keyboard on the page), and popup UI listing detected media.
   - Assert on real artifacts: the downloaded file exists, is non-zero, and (for merges) ffprobe shows both audio and video streams.
   - Wire it up as `pnpm test:e2e`, and add a GitHub Actions workflow that builds the extension and runs the suite on every push to `main`. The gate is: build green + e2e green.

4. **Finish**: update README with how to run the pipeline, commit everything to `main` in one consolidated commit, push, and confirm CI is green.

Keep effort proportionate: prefer simple fixture-based tests that genuinely exercise the feature over elaborate mocking. A test that doesn't observe a real download proves nothing.
