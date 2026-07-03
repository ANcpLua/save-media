# TASK — Per-site download support (Twitter/X, Instagram, YouTube)

**Goal:** Make savemedia actually download videos from twitter/x.com, instagram.com, and
(unlisted/personal) youtube.com — today it only handles verified direct files + plain HLS VOD,
so those three sites fail (YouTube at capture, Twitter/IG produce silently video-only output).
This is the owner's personal-use demo for brand-protection work (remove.tech) — quality bar is high.

**Standing decision (do not re-ask):** Chrome Web Store prohibits YouTube-download extensions
(SaveFrom pulled 2025). YouTube support therefore ships behind an unlisted/personal build only.
Listing and YouTube-download are mutually exclusive; owner accepts unlisted for the demo.

## Architecture (grounded in a 4-agent code map)

- Capture funnels through `handleCapture` in `background/index.ts`. Emitting a `media-source`
  capture with a resolved URL flows: bridge → handleCapture (credentials:include fetch) →
  classify (magic-byte ftyp confirm) → directDownload → chrome.downloads. **No core change needed
  for progressive MP4.**
- The one new capability all three sites share for HD is an **audio+video merge engine** (mediabunny,
  already a dep) — demuxed CMAF audio (Twitter HLS), Instagram DASH, YouTube adaptive itags.

## Plan / increments (each lands green + reviewable)

- [x] **PR A — Twitter + Instagram progressive extractors** (branch:
      `feat/site-extractors-twitter-instagram`) — DONE, green (typecheck + core 106 + extension 139
      tests + chrome build; content bundle verified free of ESM imports).
  - [x] Green baseline verified (typecheck + 120 unit tests).
  - [x] MAIN-world fetch/XHR interceptor (`content/intercept.ts`) + pure resolvers
        (`content/sites/{twitter,instagram,registry,json,types}.ts`) → emit progressive **muxed** MP4
        (audio included) as `media-source` captures.
  - [x] Gate generic discovery (webRequest + resource-timing) OFF on extractor-managed hosts so the
        clean MP4 is the only surfaced entry (no broken video-only HLS/DASH masquerading as "best").
  - [x] Unit tests: resolvers (golden fixtures), intercept extraction (fetch+XHR), host gate. +19 tests.
  - [x] Docs: docs/design.md contract row + refusal note.
  - [ ] Follow-up (defer): host-mapped e2e fixture for a resolver site (needs host-resolver-rules like
        yt-transcript's youtube-fixture-server). Unit coverage carries PR A; e2e rides PR B.
- [ ] **PR B — mediabunny dual-stream merge engine + YouTube (unlisted)**
  - [ ] Fetch demuxed audio+video, mux into one MP4 with no re-encode.
  - [ ] Unlock Twitter demuxed-HLS audio, Instagram DASH, YouTube adaptive (googlevideo host capture).
  - [ ] Golden fixtures + ffprobe verification per the repo's existing e2e contract.

## Verify
`pnpm typecheck && pnpm -r test` must stay green. E2e (`pnpm test:e2e:chromium`) is the enforcement
mechanism — add fixtures for new capabilities where tractable.
