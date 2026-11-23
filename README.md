# savemedia

A browser extension for Chrome, Edge and Firefox that saves videos and images
that are not DRM encrypted, as the browser receives them. It saves direct
video files in MP4, QuickTime, WebM and MKV, HLS streams with MPEG-TS or
fragmented MP4 segments, and DASH streams with fully addressed tracks, joined
into one MP4 file. Standard HLS AES-128 is decrypted with
the key the player receives. Alt+S saves the video or image under the
pointer. Every file savemedia downloads itself is verified before it
reaches the Downloads folder. The one exception is a download your browser
already holds and continues on its own: savemedia lets the browser finish it
and cannot read its content. DRM is never touched, and live streams are not
saved. Apart from the optional Local downloader, which runs the yt-dlp and
ffmpeg you install, everything runs in the browser. There is no telemetry, no
account and no server. Chrome and Edge come first; the Firefox build is kept
compiling.

What savemedia does and does not do is in
[`docs/boundary-rules.md`](docs/boundary-rules.md), the owner's policy. It
overrides every other document here; read it before changing capture,
parsing, download behaviour or user-facing text. What is supported in detail
is in [`docs/design.md`](docs/design.md). The privacy policy is
[`docs/privacy-policy.md`](docs/privacy-policy.md). GitHub Pages serves the `docs`
folder, so the store listings link to
https://ancplua.github.io/save-media/privacy-policy.html: a GitHub file page
can answer a store's check with 429 or 503.
Direct-file probe retries and checked chunk recovery are described in
[`docs/range-recovery.md`](docs/range-recovery.md), including browser size and
validation limits.

## Stores

The table is rendered from [`store.config.json`](store.config.json) by
`store-publish readme --write`; CI fails when the two disagree. Which version
each store serves is a question for `store-status.yml` below, not for this
file.

<!-- store-config:start -->
| Store | Listing | Dashboard | API docs | Credentials (GitHub Actions secrets) | Notes |
| --- | --- | --- | --- | --- | --- |
| Chrome Web Store | [negbodmpgjhkacmdkbfdpocjanaklifn](https://chromewebstore.google.com/detail/savemedia/negbodmpgjhkacmdkbfdpocjanaklifn) | [dashboard](https://chrome.google.com/webstore/devconsole) | [docs](https://developer.chrome.com/docs/webstore/using-api) | `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`, `CWS_PUBLISHER_ID` | OAuth client and refresh token live in ~/.config/vitals (see keys.json) |
| Microsoft Edge Add-ons | [214e0682-5cde-4319-9608-ed25de6643b7](https://microsoftedge.microsoft.com/addons/detail/savemedia/mmkdllnjmommekajhadhokanofjlglhk) | [dashboard](https://partner.microsoft.com/en-us/dashboard/microsoftedge/214e0682-5cde-4319-9608-ed25de6643b7/packages/dashboard) | [docs](https://learn.microsoft.com/microsoft-edge/extensions/update/api/using-addons-api) | `EDGE_API_KEY`, `EDGE_CLIENT_ID` | API key expires 2026-11-29. Renew at https://partner.microsoft.com/en-us/dashboard/microsoftedge/publishapi, then update the local copy and both repositories' EDGE_API_KEY and EDGE_CLIENT_ID secrets |
| Firefox Add-ons (AMO) | [savemedia@ancplua.dev](https://addons.mozilla.org/firefox/addon/save-media/) | [dashboard](https://addons.mozilla.org/developers/addon/save-media/edit) | [docs](https://mozilla.github.io/addons-server/topics/api/addons.html) | `AMO_JWT_ISSUER`, `AMO_JWT_SECRET` | One key pair per Mozilla account, shared with the other extension repo. Readable copy in the macOS keychain (see keys.json). Never regenerate |
<!-- store-config:end -->

Check credentials before each release. Never regenerate a key to fix
a 401: the stored value is almost always what is broken, and AMO has exactly
one key pair per account, so a new one immediately invalidates the old one for
this repository and for the other extension repository that shares it. Test a
new value before overwriting a working one, and check its length before you
store it. Clipboard round trips have already replaced a 40 character Edge key
with 112 characters of garbage once.

Where the credentials live:

| Credential | Location |
| --- | --- |
| The eight store secrets | GitHub Actions secrets in this repository (`gh api repos/ANcpLua/save-media/actions/secrets --jq '.secrets[].name'`). GitHub never returns values; they can only be exercised in a workflow run. Item and product ids are not secrets, they live in `store.config.json`. |
| Chrome OAuth client and refresh token | `~/.config/vitals/cws-client.json` and `~/.config/vitals/cws-refresh-token.txt`. Google Cloud project `server` (`uplifted-nuance-408417`), OAuth client "Desktop client 2", consent screen in production, so the refresh token does not expire on its own. |
| Edge API key and client id | `~/.config/vitals/store-secrets.env`, pushed to both repositories by `~/.config/vitals/set-store-secrets.sh`. |
| AMO JWT issuer and secret | macOS keychain item `AMO API (addons.mozilla.org)`, issuer in the account field. Presence check: `security find-generic-password -s "AMO API (addons.mozilla.org)"` without `-w`. |
| Register of all of the above | `~/.config/vitals/keys.json` |

Before using `set-store-secrets.sh`, populate all eight values from their
documented sources; the environment file alone does not supply the AMO pair.
For an Edge-only renewal, update only the two Edge secrets in each repository.

Expiry dates:

| What | Expires | Then |
| --- | --- | --- |
| Edge API key | See the generated store table above | Renew at the Edge publish API page, update the local copy and the two Edge secrets in both repositories, update `stores.edge.expires` in both configs, regenerate their README tables, then run `store-publish edge status`. `edge status` warns 30 days ahead and fails after the date. |
| Chrome Web Store API v1.1 | 2026-10-15 | Nothing to do, the tool already uses API v2. |
| Chrome refresh token, AMO key pair | none | Rotate only if they stop working, and never regenerate the AMO pair without updating both repositories in the same minute. |

## Releasing

Release publishing is scripted for all three stores through
[store-publish](https://github.com/ANcpLua/store-publish), a small CLI shared
with the other extension repository. Every store-specific value comes from
`store.config.json`; a new extension copies that file and changes the ids.
One dispatch with `stores=all` attempts all three stores as sequential steps
in one job. This is not a parallel job matrix. Store acceptance and review
remain independent, so a successful submission is not proof that it is live.

```sh
# 1. bump the version in packages/extension/manifest.json and packages/extension/package.json
# 2. check everything locally
bun install                       # refresh bun.lock after the version bump
bun run verify
bunx --bun store-publish lint            # listing, manifest and UI text: no forbidden words, brand names, dashes, emojis or comma chains
bunx --bun store-publish readme --check  # README store table matches store.config.json
release_version=$(bunx --bun store-publish version)
# 3. stage the reviewed release changes, commit, push main, and wait for ci.yml
git add -p
git commit -m "Release $release_version"
git push origin main
# 4. after CI succeeds for this commit, create a new tag and push it
git tag "v$release_version"
git push origin "v$release_version"
```

The tag push runs [`release.yml`](.github/workflows/release.yml): it builds
the Chrome, Edge (same bytes as Chrome) and Firefox zips plus the source zip AMO
requires, and creates the GitHub release with the zips attached. The zips are
store builds: they leave out the one site reader the Chrome Web Store does not
accept, and packing stops if a build still carries it. The tag does
not submit to stores. Wait for that run to succeed before dispatching the
store submission.

Mozilla reviewers can rebuild the source archive with
[`docs/firefox-source-build.md`](docs/firefox-source-build.md). All build
dependencies, including the publishing CLI, are publicly accessible.

Before uploading, run the status checks below and inspect Edge's dashboard
for certification state; its API probe checks credentials only. Resolve any
pending listing or privacy fields and wait for existing reviews that block
uploads. Confirm `main` still contains the tested release code and version.
Then dispatch the same workflow once:

```sh
gh workflow run release.yml -R ANcpLua/save-media --ref main -f stores=all -f chrome=release -f edge=release
gh run list -R ANcpLua/save-media --workflow=release.yml --limit 5
# Replace RUN_ID with the ID of the dispatch just started.
gh run watch RUN_ID -R ANcpLua/save-media --exit-status
```

Select `stores=chrome`, `edge`, or `firefox` when only that store needs an
upload. `chrome=update` and `edge=update` upload without submitting, allowing
dashboard edits first. `release` uploads and submits for review.

### Packed Chrome updates

Regular Chrome on macOS receives signed updates through the Chrome Web Store.
After a version is approved and published, Chrome updates the installed
extension automatically. Self-hosted packages on macOS require a managed
browser. See [Chrome extension distribution](https://developer.chrome.com/docs/extensions/how-to/distribute).

The existing workflow handles an authorized production update using
`stores=chrome` and `chrome=release`. It uses the publisher's configured
OAuth credentials. Check the `chrome` job in `credential-health.yml` before
a release and confirm the published version after store review.

For recurring signed tests, use a separate **private beta** with trusted
testers. Create the item and publish its first version through the developer
dashboard. Give the extension a `BETA` suffix and identify it as a test build
in the listing. Once testers install that item, later approved versions
update in place. Private items also go through review.
[Chrome beta distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)
and [API setup](https://developer.chrome.com/docs/webstore/api).

The same publisher OAuth credentials can target the beta item under that
publisher. Build the beta ZIP with an increased manifest version, verify
the target with `store-publish chrome status --item "$SAVEMEDIA_BETA_ITEM_ID"`,
and use the explicit beta ID and ZIP for an authorized submission.

```sh
bunx --bun store-publish chrome release --item "$SAVEMEDIA_BETA_ITEM_ID" --zip "$SAVEMEDIA_BETA_ZIP"
```

### Retrying a partial release

Let the run finish: later store steps still run when an earlier store fails.
Inspect each store's log and dashboard before retrying; do not rerun all stores
or reuse an existing version blindly.

- If the upload was rejected before a package was accepted, resolve the cause
  and dispatch only that store.
- If Chrome or Edge already accepted the upload but submission failed, finish
  the listing/privacy fields and submit the existing draft in its dashboard,
  or run `bunx --bun store-publish chrome publish` / `bunx --bun store-publish edge publish`
  from this repository with that store's credentials. These commands skip upload.
- If Firefox already has the version, complete any missing source upload or
  review information on that version instead of creating it again.
- If a submission is in review, wait for its decision. Cancel it only when
  intentionally replacing that submission, not as an automatic retry.

On the owner's machine, `~/.config/vitals/edge-publish status` checks the local
Edge credentials and `~/.config/vitals/edge-publish publish` submits the existing
draft. Run the helper from the intended repository root; it reads that repo's
product ID from `store.config.json`.

Completion means recording the version and result for each store separately:
upload failed, uploaded draft, submitted/in review, or live. A green workflow
confirms its API operations, not eventual review approval. Expired credentials,
store outages, review locks, and dashboard requirements can still interrupt a run.

### Publishing maintenance

Routine maintenance and the necessary follow-through are part of the user's
standing authorization. Carry out the next clear step, verify its result,
and report what changed. Do not stop to ask whether to check status, fix a
known workflow failure, fill a field from verified repository facts, sync a
renewed credential, or finish an already requested submission.

- At task start, compare recorded expiry dates with today's date and check
  known unresolved publishing issues. Before any store submission, refresh
  live status and credential checks using the runbook. Edge's credential
  probe does not reveal certification state; inspect its dashboard.
- Treat a key expiring within 30 days as maintenance due. Renew it through
  the supported flow when access allows, update the local copy and affected
  secrets in both extension repositories, update both configs and generated
  tables, and verify both repositories' authentication. Diagnose rejected
  credentials before rotating them; preserve the shared AMO pair as described
  above. Keep secret values out of logs and commits.
- Complete required dashboard fields from the current code, privacy policy,
  and saved listing answers. Resolve factual mismatches in the code and docs;
  ask only for an essential fact that those sources cannot establish.
- For a failed upload or submission, follow the partial-release rules above
  and continue the other stores. For an open review, retain the submission
  and report its current state and next check; review approval is external.
  Investigate a rejection and implement the justified fix before resubmitting
  within the authorized release. Publish completion still requires evidence
  for each store separately.
- Remind the user when a deadline is approaching or a blocker needs their
  action. Include the store, due date or review state, work already completed,
  and the exact remaining action. Repeat only for a meaningful change or an
  approaching deadline. If login, MFA, access, or an unknown required fact
  prevents progress, explain that specific blocker and continue independent work.

Session instructions do not run between tasks. When reminders or review
checks are scheduled, use an actual automation, identify the next check,
and notify on actionable changes rather than unchanged pending reviews.
Keep unresolved follow-up explicit; never promise unattended monitoring
unless a scheduled check exists.

### Listing changes

The listing text lives in
[`packages/extension/store-assets/listing.md`](packages/extension/store-assets/listing.md).
The AMO description is written from there by the workflow below. Chrome and
Edge have no API for listing text; paste the "Chrome and Edge description"
section into the two dashboards when it changes. Screenshots and the store
icon are under `packages/extension/store-assets/`, regenerated with
`bun run --filter @savemedia/extension screenshots` and `store:assets`.

Store icons and screenshots are listing fields on all three stores, not
package contents: Chrome (Store listing, Graphic assets) and Edge (Details
page, Extension logo) take them in the dashboard, AMO through the two
workflow options below. A new package never changes them.

Store review traps, each one has already cost a rejection or a takedown:

- No platform or brand names in the extension name, listing, screenshots,
  README, commit messages or tests. Say "direct MP4", "plain HLS VOD", "DASH".
- None of the three words `store-publish lint` forbids (they name ways around
  a protection), not even in a negation. The owner's policy sentence in
  `docs/boundary-rules.md` is the one place that uses one of them; the listing
  and this file do not.
- No "any site" and no "all videos". Say what the extension does.
- No comma-separated runs of format names. Formats belong in a sentence that
  says what they are for.
- Chrome lists video downloaders as not eligible for the Featured badge. Do
  not promise it.
- AMO stores the listing under the locale the add-on was created with, which
  is `de` although the text is English. Never hardcode a locale.

## Reading store status without publishing

The `status`, `chrome`, `firefox`, `edge`, and diff/list options in
[`store-status.yml`](.github/workflows/store-status.yml) are read-only.
The `amo-*-apply` options below change the live listing:

```sh
gh workflow run store-status.yml -R ANcpLua/save-media --ref main -f store=status            # one table: live version, review state, credential check for all three
gh workflow run store-status.yml -R ANcpLua/save-media --ref main -f store=chrome             # review and publish state
gh workflow run store-status.yml -R ANcpLua/save-media --ref main -f store=firefox            # versions and their review status
gh workflow run store-status.yml -R ANcpLua/save-media --ref main -f store=edge               # credential probe, key length, days until the key expires
gh workflow run store-status.yml -R ANcpLua/save-media --ref main -f store=amo-listing-diff   # repo listing vs live AMO description
gh workflow run store-status.yml -R ANcpLua/save-media --ref main -f store=amo-listing-apply  # writes the AMO description
gh workflow run store-status.yml -R ANcpLua/save-media --ref main -f store=amo-icon-diff       # which icon AMO serves (the manifest icon is not used there)
gh workflow run store-status.yml -R ANcpLua/save-media --ref main -f store=amo-icon-apply      # uploads stores.firefox.icon
gh workflow run store-status.yml -R ANcpLua/save-media --ref main -f store=amo-previews-list   # listing screenshots on AMO
gh workflow run store-status.yml -R ANcpLua/save-media --ref main -f store=amo-previews-apply  # replaces them with stores.firefox.previews
gh run watch -R ANcpLua/save-media
```

Locally, with the credentials in the environment, the same commands are
`bunx --bun store-publish chrome status`, `edge status`, `firefox status` and
`amo-listing diff`.

## Development

Bun workspace. Bun (`packageManager` in `package.json`, 1.4 or newer) installs
the packages and runs everything: the scripts, Vite, Vitest and Playwright.
Node is not needed. The package scripts start tools with `bun --bun`, and the
commands below use `bunx --bun`, because a tool whose launcher names `node`
would otherwise run on Node wherever Node is installed, as on CI runners.

- `packages/core`: media classification, HLS and DASH parsing, verification,
  dispatch. Pure TypeScript, no browser APIs. Must be built before the
  extension typechecks.
- `packages/extension`: the MV3 extension. `src/background` (capture, router,
  download-best, the observer of savemedia's own requests), `src/content`
  (page bridge, and three site readers that are an open owner decision, see
  the policy; store packages carry two of them), `src/selection` (the one main-video selector), `src/engine`
  (in-browser download, remux, sinks), `src/native` (local downloader client),
  `src/popup` (React and Tailwind), `src/ui` (the text catalogues),
  `src/types/messages.ts`. Vite builds `dist-chrome` and `dist-firefox`.
- `packages/native-host`: optional Python native messaging host that runs the
  user's own yt-dlp and ffmpeg. Protocol in its README.

```sh
bun install
bun run build            # core + chrome build
bun run build:all        # plus firefox
bun run --filter @savemedia/extension zip   # store packages: every target built with SAVEMEDIA_STORE_BUILD=1
bun run test             # vitest in every package, python tests in the native host
bun run typecheck        # builds core first
bun run test:e2e         # playwright, chromium
bun run --filter @savemedia/extension smoke:native   # local downloader end to end
python3 -m unittest discover -s packages/native-host   # protocol, host internals, install.sh, setup.sh
bun run verify           # full pre-release check
```

To try a change in the browser, run `bun run build` and load
`packages/extension/dist-chrome` as an unpacked extension. After each further
build, press Reload on the extension's card. There is no watch build: only
`bun run build` writes `dist-chrome` and its manifest.

For direct file changes, see [direct file discovery and recovery](docs/range-recovery.md#verify-locally)
for a focused popup and Alt+S check.

A complete MPEG transport stream declared by a video element or download link
saves as its original file. For HLS VOD, the browser checks the transport
program map in each segment. When MP4 can carry the audio and video, such as
H.264 or HEVC with AAC or MPEG audio, the stream remuxes to MP4 and metadata
streams such as timed ID3 or SCTE-35 cues are left out. A program with audio,
video or another stream MP4 cannot carry saves as `.ts` with every packet, and
so does a stream whose clock starts again part-way, as when a clip is joined
in on the server.

To check the popup and Alt+S against a timed ID3 fixture and a server that
keeps answering 522, run the following after building the extension.

```sh
cd packages/extension
bunx --bun playwright test --project=chromium -g 'transport stream|manifest 522'
```

Regenerate the timed ID3 fixture with
`bun packages/extension/scripts/generate-transport-fixture.mjs`. Without
arguments it writes to a temporary directory and compares the result with the
committed file; `--write` replaces the committed file.

Every committed media fixture has a script in `packages/extension/scripts`
that says how it is made and makes it again with ffmpeg:
`generate-base-fixtures.mjs` (the direct files, the one-segment HLS fixtures
and the unit test inputs; it also compares before it writes),
`generate-hls-multi-fixtures.mjs`, `generate-packed-audio-fixtures.mjs`, `generate-av-merge-fixtures.mjs`,
`generate-dash-fixtures.mjs`, `generate-webm-fixtures.mjs`,
`generate-merge-codec-fixtures.mjs`, `generate-transport-fixture.mjs` and
`generate-ac3-transport-fixtures.mjs`.
Tests never run them: a regenerated fixture has other bytes and is a new
fixture.

User-facing text has one home per kind. `JobError` failures: core
`errors/messages.ts` and `errors/network-block.ts`. Everything else,
including Local downloader failures and image refusals: extension
`ui/text.ts`, `ui/toast-text.ts` and `util/transfer-progress.ts`. Each file
starts with the wording rules. A failure is shown one way everywhere: what happened, what
the user can do, and codes and HTTP details only under Technical details. To
check the popup's live regions, the cancel path, the toast and the
explanations for a server the network blocks:

```sh
cd packages/extension
bunx --bun playwright test --project=chromium tests/e2e/popup-ux.spec.ts tests/e2e/network-block.spec.ts
```

Alt+S saves the video or image under the pointer. Every frame reports what
lies under the pointer, and one selector in the background decides: the same
one that picks the popup's main card and the toolbar count. A video at the
pointer wins over images there, also across frames, because players draw
their poster, play button, controls and banners above the video, and a video
that ignores the pointer is still found by its position. A canvas stands for
the video that feeds it, and for a video the page never attached, the one
stream its document loaded outside any video element. With the pointer over
nothing, the page's main video is saved. An image is fetched once, its bytes are checked, and only those
bytes are saved. To check it against two players, a poster with a play
button, and an image:

```sh
cd packages/extension
bunx --bun playwright test --project=chromium -g 'under the pointer'
```

What a page's ad responses name is never the main video and is never
requested by savemedia on its own. An ad the browser itself loaded is listed
last, in a closed "Ads (n)" group that the toolbar count leaves out, and is
requested only when the user presses Save on it.

The main-video suite covers ads, frames, shadow roots, canvases, route
changes, key use, gates and disguised bytes:

```sh
cd packages/extension
bunx --bun playwright test --project=chromium tests/e2e/main-video.spec.ts
```

Alt+S in the end-to-end suites is a key event the page receives. The
browser's own command cannot be pressed from a test; both reach the same
function, which the unit tests drive through the registered command.

The end-to-end suites run Playwright's full Chromium in headless mode, which
loads the extension without opening a window. Set `SAVEMEDIA_HEADED=1`, or use
`bun run --filter @savemedia/extension test:e2e:headed`, to watch the browser.

Toolchain decision, shared with the other extension repository so a third
extension can copy either as a template: Bun is the package manager and the
runtime, Vitest is the unit test runner and Playwright the end-to-end runner,
both running on Bun. Vitest runs the test files in worker threads, because
Bun's child processes lack what Vitest's default process pool needs. `bun test`
was not adopted: it is a third runner with
its own mock and snapshot API, and the popup tests depend on jsdom and
testing-library, which Vitest handles and `bun test` does not. Google Chrome 137 and newer ignores
`--load-extension`, so the e2e suite uses Playwright's Chromium; with a custom
`--user-data-dir` the native host manifest must be in
`<user-data-dir>/NativeMessagingHosts`.

Rules that override everything else, short form of `docs/boundary-rules.md`:

- Observe, never defeat. Save what the browser receives in the clear during
  normal playback and browsing. Never click anything for the user, never
  fetch an ad unless the user saves it from the Ads list, never skip or mute
  ads, never forge a token or guess an address, and never reach a server the
  user's network blocks another way. For a page on the internet, a server
  inside the user's network is requested only when the browser itself loaded
  from it for that page.
- Encryption is the only refusal on purpose. (One more is listed as open
  in `docs/boundary-rules.md` under "Where the code differs from the policy
  today": the local-network rule.)
  Only `EXT-X-KEY` `METHOD=AES-128` with an
  identity `KEYFORMAT` is decrypted: the key is 16 bytes fetched the way the
  player fetches it. Every other method, every other `KEYFORMAT`, a key
  address that answers 401, 402 or 403, DASH `ContentProtection`, Common
  Encryption and scrambled transport streams are refused. A price or a
  "premium" label decides nothing. Keep the refusal tests.
- Site-agnostic and idempotent. No text and no code path points at a site's
  own buttons. The same page state gives the same detection and the same
  save; repeated scans, popup opens and Alt+S presses change nothing.
- The savemedia helper never bundles, downloads or installs yt-dlp or ffmpeg.
  The Alt+S fallback and the offer under a failed save are never made for
  protected media: `DELEGABLE_ERROR_CODES` in `src/native/local-downloader.ts`
  is an allowlist without a protection code. **Save this page with yt-dlp**
  hands over the page address whatever savemedia found on the page, and
  relies on yt-dlp's own DRM data.
- Test fixtures are local files under `tests/`, Creative Commons assets, or
  the author's own uploads. Never a third-party platform.

Conventions:

- Commit messages: subject line only, plus the Co-Authored-By trailer when an
  agent wrote the change.
- Public text (README, docs, listing, release notes, UI): no em dashes, no
  emojis, no site or brand names, claims verified before they are written.
  The product is `savemedia`, in lowercase, also at the start of a sentence.
- Firefox: request permissions synchronously inside the click handler. An
  `await` before `permissions.request` drops the user gesture.
- Native host subprocesses use `stdin=DEVNULL`, otherwise they inherit the
  browser's stdin pipe and stall.
- The version lives in `packages/extension/manifest.json` and
  `packages/extension/package.json`. The root and core `package.json` are
  private and lag behind on purpose.
- On a store update, `chrome.runtime.onInstalled` with `reason === "update"`
  runs once in the background and is the place for one-time cleanup of
  storage left by earlier versions.

## Optional local downloader

For pages the in-browser engine cannot save (HLS or DASH byte ranges that do
not add up to one file, unusual containers), savemedia can hand the page
address to yt-dlp and ffmpeg that the user installs themselves. It is off by
default and asks for the `nativeMessaging` permission only when switched on.
The Alt+S fallback and the offer under a failed save are never made for
protected media; **Save this page with yt-dlp** relies on yt-dlp's own DRM
data. yt-dlp writes its file itself and makes its own requests, so savemedia's
file check and the browser's network settings do not apply to it. A helper
installed for an earlier version of savemedia is not used: the popup says
that it needs an update and shows the setup command. Setup and the wire
protocol are in
[`packages/native-host/README.md`](packages/native-host/README.md).

The feature has been part of the extension since 1.0.0, off until switched
on. The release check for it:

- `bun run --filter @savemedia/extension smoke:native` passes: Playwright
  Chromium plus the real host and the user's own yt-dlp and ffmpeg. Verified
  on 2026-09-12 (yt-dlp 2026.08.19, ffmpeg 9.0.1, saved file checked with
  ffprobe).
- `python3 -m unittest discover -s packages/native-host` passes: framing,
  request validation, output directory containment, progress parsing,
  cancel and timeout, partial-file cleanup, log rotation, and install.sh and
  setup.sh against a temporary HOME.
- Manual run in Edge and Firefox with the built extension, the one step
  that needs a person because of the permission prompt. Checklist:
  [`docs/manual-check-local-downloader.md`](docs/manual-check-local-downloader.md).
  Still open.
- The browser edge cases no test can reach (keyboard focus, service-worker
  sleep, cancelled saves, duplicate and non-ASCII filenames, frames, private
  windows, how the refusals read) have their own per-browser checklist:
  [`docs/manual-check-browsers.md`](docs/manual-check-browsers.md).
- The `nativeMessaging` permission is optional and asked for only when the
  user switches the Local downloader on. Its justification is in
  `docs/privacy-policy.md`.

## Support and security

Bugs and store-review questions go to
[GitHub Issues](https://github.com/ANcpLua/save-media/issues), see
[`SUPPORT.md`](SUPPORT.md). Security reports: [`SECURITY.md`](SECURITY.md).

## License

[Apache-2.0](LICENSE)

## Credential health monitoring

`.github/workflows/credential-health.yml` checks Chrome, Edge, and Firefox
credentials every six hours and through **Run workflow**. These are read-only
checks: nothing is uploaded or published. Vitals reads the secret metadata and
per-store authentication results without downloading secret values. A replaced
secret needs a newer successful check; results older than 24 hours are stale.
The Edge check reads a previous real publishing operation, so a 404 or server
error is never reported as successful authentication.
