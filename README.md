# savemedia

Browser extension for Chrome, Edge and Firefox that saves browser-visible video
when it can prove the bytes are one complete, playable file. It saves direct
MP4, WebM and MKV files, plain HLS VOD with MPEG-TS segments (remuxed locally to
MP4), and clear HLS fMP4/CMAF streams. It refuses DRM, encrypted HLS, DASH,
live streams, and anything it cannot verify, rather than writing a broken file.
Everything runs in the browser. There is no telemetry, no account and no server.

The support contract is [`docs/design.md`](docs/design.md). The legal and
engineering limits are [`docs/boundary-rules.md`](docs/boundary-rules.md); read
that file before touching capture, parsing, site readers or the local
downloader. The privacy policy is [`docs/privacy-policy.md`](docs/privacy-policy.md).

## Stores

The table is rendered from [`store.config.json`](store.config.json) by
`store-publish readme --write`; CI fails when the two disagree. Which version
each store serves is a question for `store-status.yml` below, not for this
file.

<!-- store-config:start -->
| Store | Listing | Dashboard | API docs | Credentials (GitHub Actions secrets) | Notes |
| --- | --- | --- | --- | --- | --- |
| Chrome Web Store | [negbodmpgjhkacmdkbfdpocjanaklifn](https://chromewebstore.google.com/detail/savemedia/negbodmpgjhkacmdkbfdpocjanaklifn) | [dashboard](https://chrome.google.com/webstore/devconsole) | [docs](https://developer.chrome.com/docs/webstore/using-api) | `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`, `CWS_PUBLISHER_ID` | OAuth client and refresh token live in ~/.config/vitals (see keys.json) |
| Microsoft Edge Add-ons | [214e0682-5cde-4319-9608-ed25de6643b7](https://microsoftedge.microsoft.com/addons/detail/savemedia/mmkdllnjmommekajhadhokanofjlglhk) | [dashboard](https://partner.microsoft.com/en-us/dashboard/microsoftedge/214e0682-5cde-4319-9608-ed25de6643b7/packages/dashboard) | [docs](https://learn.microsoft.com/microsoft-edge/extensions/update/api/using-addons-api) | `EDGE_API_KEY`, `EDGE_CLIENT_ID` | API key expires 2026-11-21 (70 days from 2026-09-12). Renew at https://partner.microsoft.com/en-us/dashboard/microsoftedge/publishapi, then run ~/.config/vitals/set-store-secrets.sh |
| Firefox Add-ons (AMO) | [savemedia@ancplua.dev](https://addons.mozilla.org/firefox/addon/save-media/) | [dashboard](https://addons.mozilla.org/developers/addon/save-media/edit) | [docs](https://mozilla.github.io/addons-server/topics/api/addons.html) | `AMO_JWT_ISSUER`, `AMO_JWT_SECRET` | One key pair per Mozilla account, shared with the other extension repo. Readable copy in the macOS keychain (see keys.json). Never regenerate |
<!-- store-config:end -->

The four credential sets are valid and verified. Never regenerate a key to fix
a 401: the stored value is almost always what is broken, and AMO has exactly
one key pair per account, so a new one immediately invalidates the old one for
this repository and for the other extension repository that shares it. Test a
new value before overwriting a working one, and check its length before you
store it. Clipboard round trips have already replaced a 40 character Edge key
with 112 characters of garbage once.

Where the credentials live:

| Credential | Location |
| --- | --- |
| All ten store secrets | GitHub Actions secrets in this repository (`gh api repos/ANcpLua/save-media/actions/secrets --jq '.secrets[].name'`). GitHub never returns values; they can only be exercised in a workflow run. `CWS_ITEM_ID` and `EDGE_PRODUCT_ID` are still set but unused, the ids come from `store.config.json`. |
| Chrome OAuth client and refresh token | `~/.config/vitals/cws-client.json` and `~/.config/vitals/cws-refresh-token.txt`. Google Cloud project `server` (`uplifted-nuance-408417`), OAuth client "Desktop client 2", consent screen in production, so the refresh token does not expire on its own. |
| Edge API key and client id | `~/.config/vitals/store-secrets.env`, pushed to both repositories by `~/.config/vitals/set-store-secrets.sh`. |
| AMO JWT issuer and secret | macOS keychain item `AMO API (addons.mozilla.org)`, issuer in the account field. Presence check: `security find-generic-password -s "AMO API (addons.mozilla.org)"` without `-w`. |
| Register of all of the above | `~/.config/vitals/keys.json` |

Expiry dates:

| What | Expires | Then |
| --- | --- | --- |
| Edge API key | 2026-11-21 | Renew at the Edge publish API page, update `stores.edge.expires` in `store.config.json`, run `set-store-secrets.sh`, run `store-publish edge status`. `edge status` warns 30 days ahead and fails after the date. |
| Chrome Web Store API v1.1 | 2026-10-15 | Nothing to do, the tool already uses API v2. |
| Chrome refresh token, AMO key pair | none | Rotate only if they stop working, and never regenerate the AMO pair without updating both repositories in the same minute. |

## Releasing

Release publishing is scripted for all three stores through
[store-publish](https://github.com/ANcpLua/store-publish), a small CLI shared
with the other extension repository. Every store-specific value comes from
`store.config.json`; a new extension copies that file and changes the ids.

```sh
# 1. bump the version in packages/extension/manifest.json and packages/extension/package.json
# 2. check everything locally
bun run verify
bunx store-publish lint            # listing text: no forbidden words, no comma chains
bunx store-publish readme --check  # README store table matches store.config.json
bunx store-publish version         # manifest.json and package.json carry the same version
# 3. commit, tag, push the tag
git commit -am "Release 0.0.8"
git tag v0.0.8
git push origin main v0.0.8
```

The tag push runs [`release.yml`](.github/workflows/release.yml): it builds
the Chrome, Edge (same bytes as Chrome) and Firefox zips plus the source zip AMO
requires, publishes to Edge, Chrome and Firefox in that order, and creates the
GitHub release with the zips attached. Each store then reviews on its own
schedule; the previous version stays live until the new one is approved.

To publish to a subset of stores, or to retry one store after a fix, dispatch
the same workflow by hand:

```sh
gh workflow run release.yml -R ANcpLua/save-media --ref main -f stores=firefox   # all | chrome | edge | firefox
```

Only the version bump and the listing text ever need a human. The listing
text lives in
[`packages/extension/store-assets/listing.md`](packages/extension/store-assets/listing.md).
The AMO description is written from there by the workflow below. Chrome and
Edge have no API for listing text; paste the "Chrome and Edge description"
section into the two dashboards when it changes. Screenshots and the store
icon are under `packages/extension/store-assets/`, regenerated with
`bun run --filter @savemedia/extension screenshots` and `store:assets`.

Store review traps, each one has already cost a rejection or a takedown:

- No platform or brand names in the extension name, listing, screenshots,
  README, commit messages or tests. Say "direct MP4", "plain HLS VOD", "DASH".
- No "bypass", "unlock" or "circumvent", not even in a negation.
- No comma-separated runs of format names. Formats belong in a sentence that
  says what they are for.
- Chrome lists video downloaders as not eligible for the Featured badge. Do
  not promise it.
- AMO stores the listing under the locale the add-on was created with, which
  is `de` although the text is English. Never hardcode a locale.

## Reading store status without publishing

[`store-status.yml`](.github/workflows/store-status.yml) is read-only and
publishes nothing:

```sh
gh workflow run store-status.yml -R ANcpLua/save-media --ref main -f store=chrome             # review and publish state
gh workflow run store-status.yml -R ANcpLua/save-media --ref main -f store=firefox            # versions and their review status
gh workflow run store-status.yml -R ANcpLua/save-media --ref main -f store=edge               # credential probe, key length, days until the key expires
gh workflow run store-status.yml -R ANcpLua/save-media --ref main -f store=amo-listing-diff   # repo listing vs live AMO description
gh workflow run store-status.yml -R ANcpLua/save-media --ref main -f store=amo-listing-apply  # writes the AMO description (the one write in this workflow)
gh run watch -R ANcpLua/save-media
```

Locally, with the credentials in the environment, the same commands are
`bunx store-publish chrome status`, `edge status`, `firefox status` and
`amo-listing diff`.

## Development

Bun workspace. Bun (`packageManager` in `package.json`, 1.4 or newer) installs
and runs scripts; Node (`.nvmrc`) still executes Vite, Vitest and Playwright,
because MV3 needs Vite's output and the popup tests need jsdom. Bun replaces
the package manager only, not the bundler and not the unit test runner.

- `packages/core`: media classification, HLS and DASH parsing, verification,
  dispatch. Pure TypeScript, no browser APIs. Must be built before the
  extension typechecks.
- `packages/extension`: the MV3 extension. `src/background` (capture, router,
  download-best), `src/content` (page bridge, site readers), `src/engine`
  (in-browser download, remux, sinks), `src/native` (local downloader client),
  `src/popup` (React and Tailwind), `src/types/messages.ts`. Vite builds
  `dist-chrome` and `dist-firefox`.
- `packages/native-host`: optional Python native messaging host that runs the
  user's own yt-dlp and ffmpeg. Protocol in its README.

```sh
bun install
bun run build            # core + chrome build
bun run build:all        # plus firefox
bun run test             # vitest in every package, python tests in the native host
bun run typecheck        # builds core first
bun run test:e2e         # playwright, chromium
bun run --filter @savemedia/extension dev            # vite watch, load dist-chrome unpacked
bun run --filter @savemedia/extension smoke:native   # local downloader end to end
python3 packages/native-host/test_host.py
bun run verify           # full pre-release check
```

Toolchain decision, shared with the other extension repository so a third
extension can copy either as a template: bun is the package manager, Vitest
is the unit test runner (invoked through bun, running on Node), Playwright is
the end-to-end runner. `bun test` was not adopted: it is a third runner with
its own mock and snapshot API, and the popup tests depend on jsdom and
testing-library, which Vitest handles and `bun test` does not. Google Chrome 137 and newer ignores
`--load-extension`, so the e2e suite uses Playwright's Chromium; with a custom
`--user-data-dir` the native host manifest must be in
`<user-data-dir>/NativeMessagingHosts`.

Rules that override everything else, short form of `docs/boundary-rules.md`:

- Observe, do not defeat. Save what the browser already received in the
  clear. Never touch DRM, CDM keys, EME, PSSH, signature or n-cipher solving,
  paywalls, geo or login restrictions.
- Refuse loudly. Every EXT-X-KEY method except AES-128 is refused. Keep the
  refusal tests.
- The native host never bundles, downloads or installs yt-dlp or ffmpeg. DRM
  refusals are never delegated to it: `DELEGABLE_ERROR_CODES` in
  `src/native/local-downloader.ts` is an allowlist.
- Test fixtures are local files under `tests/`, Creative Commons assets, or
  the author's own uploads. Never a third-party platform.

Conventions:

- Commit messages: subject line only, plus the Co-Authored-By trailer when an
  agent wrote the change.
- Public text (README, listing, release notes): no em dashes, no emojis,
  claims verified before they are written.
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

For pages the in-browser engine cannot save (DASH, browser memory limits,
unusual containers), savemedia can hand the page address to yt-dlp and ffmpeg
that the user installs themselves. It is off by default, asks for the
`nativeMessaging` permission only when switched on, and refuses protected media
exactly like the browser engine does. Setup and the wire protocol are in
[`packages/native-host/README.md`](packages/native-host/README.md).

The feature is on `main` and is not part of 0.0.7, the last version released
to the stores. It ships in the next release after the checklist below is
green:

- `bun run --filter @savemedia/extension smoke:native` passes: Playwright
  Chromium plus the real host and the user's own yt-dlp and ffmpeg. Verified
  on 2026-09-12 (yt-dlp 2026.08.19, ffmpeg 9.0.1, saved file checked with
  ffprobe).
- Manual run in Chrome, Edge and Firefox with the built extension: switch
  Local downloader on, run the setup command the popup shows, save a DASH
  page, confirm the popup refuses DRM and the Alt+S fallback toast appears.
  Still open.
- The `nativeMessaging` permission is new for the stores, so expect a
  re-review. The justification text is in `docs/privacy-policy.md`.

History: the archive branch `native-host-v1.1.0` holds the March 2026 plain-JS
variant of the local downloader.

## Support and security

Bugs and store-review questions go to
[GitHub Issues](https://github.com/ANcpLua/save-media/issues), see
[`SUPPORT.md`](SUPPORT.md). Security reports: [`SECURITY.md`](SECURITY.md).

## License

[Apache-2.0](LICENSE)
