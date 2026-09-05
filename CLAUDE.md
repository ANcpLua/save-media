# savemedia

Browser extension (Chrome, Edge, Firefox) that saves browser-visible video only when it can
prove the bytes are a complete, playable file. Published as v0.0.7 on the Chrome Web Store and
AMO. Repo: https://github.com/ANcpLua/save-media

This is the only savemedia codebase. `~/video-rescue` is a different project (resumes broken
`.crdownload` files) and the zips under `~/Developer/cv` are archives. Do not edit those.

## Layout

pnpm workspace, Node >= 22.11, pnpm 9.12 (`.nvmrc`).

- `packages/core` – media classification, HLS/DASH parsing, verification, dispatch. Pure TS, no
  browser APIs. Must be built (`pnpm --filter @savemedia/core build`) before extension typecheck.
- `packages/extension` – MV3 extension. `background/` (capture, router, download-best),
  `content/` (page bridge, site readers), `engine/` (in-browser download, remux, sinks),
  `native/` (local downloader client), `popup/` (React + Tailwind), `types/messages.ts`.
  Vite builds to `dist-chrome` and `dist-firefox`.
- `packages/native-host` – optional Python native-messaging host that runs the user's own
  yt-dlp and ffmpeg. `host.py`, `install.sh`, `setup.sh`, `test_host.py`. Protocol in its README.
- `docs/design.md` support contract, `docs/boundary-rules.md` legal/engineering rules,
  `docs/publishing.md` store release steps, `docs/privacy-policy.md`.

## Commands

```sh
pnpm install
pnpm build            # core + chrome build
pnpm build:all        # plus firefox
pnpm test             # vitest in every package
pnpm typecheck        # builds core first
pnpm test:e2e         # playwright, chromium
pnpm --filter @savemedia/extension dev            # vite watch, load dist-chrome unpacked
pnpm --filter @savemedia/extension smoke:native   # local downloader end to end
python3 packages/native-host/test_host.py
pnpm verify           # scripts/verify.mjs, full pre-release check
```

## Rules that override everything else

Read `docs/boundary-rules.md` before touching capture, parsing, site readers, or the native
host. Short form:

- Observe, do not defeat. Save what the browser already received in the clear. Never touch
  DRM, CDM keys, EME, PSSH, signature or n-cipher solving, paywalls, geo or login bypass.
- Refuse loudly. Every EXT-X-KEY method except AES-128 is refused. Keep the refusal tests.
- The native host never bundles, downloads or installs yt-dlp/ffmpeg. DRM refusals are never
  delegated to it: `DELEGABLE_ERROR_CODES` in `native/local-downloader.ts` is an allowlist.
- No site or brand names in the extension name, listing, screenshots, README, commit messages
  or tests. Say "direct MP4", "plain HLS VOD", "DASH", not a platform. A trademark complaint
  already happened once.
- Test fixtures are local files under `tests/`, Creative Commons assets, or the author's own
  uploads. Never a third-party platform.
- No "bypass", "unlock", "circumvent" wording anywhere.

## Working conventions

- Commit messages: subject line only, no body. Add the Co-Authored-By trailer.
- Public text (README, listing, release notes): no em dashes, no emojis, claims verified first.
- Firefox: request permissions synchronously inside the click handler, an `await` before
  `permissions.request` drops the user gesture.
- Chromium e2e: Google Chrome 137+ ignores `--load-extension`, use Playwright's Chromium.
  With a custom `--user-data-dir` the host manifest must be in
  `<user-data-dir>/NativeMessagingHosts`.
- Native host subprocesses must use `stdin=DEVNULL`, otherwise they inherit the browser's
  stdin pipe and stall.
- Version lives in `packages/extension/manifest.json` and `packages/extension/package.json`
  (root and core package.json lag behind on purpose, they are private).

## Status 2026-09-05 (read this first tomorrow)

The local downloader (commit 949713f) is committed but **untested** in a real browser. Goal:
every feature works, all three browsers ship the same version, release is scripted.

Verification order:

1. `pnpm install && pnpm typecheck && pnpm test` and `python3 packages/native-host/test_host.py`.
2. `pnpm --filter @savemedia/extension smoke:native` (Playwright Chromium + host).
3. Manual: load `dist-chrome` unpacked, switch Local downloader on, run the setup command it
   shows, save a DASH page. Repeat in Edge (same build) and Firefox (`dist-firefox`, `web-ext run`).
4. Check the popup refuses DRM in all three and the Alt+S fallback toast appears.

Release path (all three stores are scripted since v0.0.5, see `docs/publishing.md`):
bump version in `packages/extension/manifest.json` and `package.json`, `pnpm verify`,
commit, tag `vX.Y.Z`, push the tag. `.github/workflows/release.yml` publishes Edge, Chrome
and Firefox and creates the GitHub release. Store secrets live in repo Actions secrets.
The nativeMessaging permission is new, so expect a store re-review; the justification text
belongs in `docs/privacy-policy.md`.

## History pointers

- Archive branch `native-host-v1.1.0` holds the March 2026 plain-JS variant of the local
  downloader (single commit 9bf8bb2).
- Boundary rules artifact: https://claude.ai/code/artifact/497bcfea-3a88-43db-8de6-094e9178b3d7
- The Alt+S fallback toast lives in `content/bridge.ts`; delegation goes only through the
  `DELEGABLE_ERROR_CODES` allowlist.
