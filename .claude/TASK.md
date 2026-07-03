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
- [ ] **PR B — mediabunny dual-stream merge engine + YouTube (unlisted)** (branch:
      `feat/av-merge-engine`)
  - [x] Merge primitive `engine/remux/merge-av.ts` — copy-encoded-packets mux, global-offset
        timestamp rebase for negative-AAC-priming. Real mediabunny mux unit-tested in a node-env
        vitest (`tests/unit/engine/merge-av.test.ts`, 4 tests) against committed ffmpeg fixtures;
        asserts the output MP4 carries both an avc + aac track. Green (extension 145→149).
  - [x] Engine job `engine/jobs/av-merge.ts` — `runAvMergeJob(plan, onProgress, signal, sink?)`:
        fetch init+segments per track (fetchWithRetry), concat, `mergeAvToMp4`, write to sink. Core
        `AvMergePlan`/`MergeTrack` types added (exported, NOT yet in the JobPlan union → dispatch
        can't emit it → engine stays un-half-wired). Node-env unit test drives the REAL merge via
        mocked fetch + injected sink; asserts both tracks + progress/error/abort/empty. Green (149→154).
  - [ ] Core: HLS `EXT-X-MEDIA` audio-group parse (drop hard-coded audioRenditionId null) +
        add `AvMergePlan` to the JobPlan union + dispatch (demuxed HLS / clear DASH → AvMergePlan,
        not refuse) + route av-merge in engine/download.ts + runner. THEN it becomes reachable.
  - [ ] Unlock Twitter demuxed-HLS audio, Instagram DASH, YouTube adaptive (googlevideo host capture).
  - [ ] Golden e2e fixtures + ffprobe verification per the repo's existing e2e contract.

  ### PR B — grounded design (mediabunny 1.45.3, API confirmed from installed .d.ts)

  **Merge primitive** (`engine/remux/merge-av.ts`, sibling to `remux/ts-to-mp4.ts`). Copy encoded
  packets, no re-encode:
  ```
  const vIn = new Input({ formats: ALL_FORMATS, source: new BufferSource(videoBytes) });
  const aIn = new Input({ formats: ALL_FORMATS, source: new BufferSource(audioBytes) });
  const vTrack = await vIn.getPrimaryVideoTrack();   // InputVideoTrack; .codec, .getDecoderConfig()
  const aTrack = await aIn.getPrimaryAudioTrack();
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const vSrc = new EncodedVideoPacketSource(vTrack.codec);   // add via output.addVideoTrack(vSrc, meta)
  const aSrc = new EncodedAudioPacketSource(aTrack.codec);   // output.addAudioTrack(aSrc, meta)
  await output.start();
  for await (const pkt of new EncodedPacketSink(vTrack).packets()) await vSrc.add(pkt, firstMeta);
  for await (const pkt of new EncodedPacketSink(aTrack).packets()) await aSrc.add(pkt, firstMeta);
  await output.finalize();  // → new Uint8Array(target.buffer)
  ```
  decoderConfig (from `track.getDecoderConfig()`) rides the FIRST `source.add(pkt, meta)` as
  `EncodedVideoChunkMetadata.decoderConfig`. Runs in the offscreen doc (where mediabunny already
  runs); verify via e2e golden fixtures, not vitest (repo mocks remux in unit tests).

  **Core changes** (must land WITH the engine — do NOT half-wire dispatch):
  - `parser/hls/adapter.ts`: stop hard-coding `audioRenditionId: null`; parse `EXT-X-MEDIA
    TYPE=AUDIO` groups + link each variant's `AUDIO=` group → `audioRenditions[]` on the descriptor.
  - `types/job.ts`: new `AvMergePlan` (video seg/url + audio seg/url + outputContainer). `dispatch`:
    demuxed HLS (variant has an audio group) → AvMergePlan instead of HlsPlainPlan; DASH video+audio
    AdaptationSets → AvMergePlan (stop refusing `dash_unsupported` when clear).
  - `engine/jobs/{hls,dash,merge}.ts`: fetch both track segment sequences (reuse
    `fetch-with-retry.ts`), assemble each to a byte buffer, call `mergeAvToMp4`.

  **YouTube** (unlisted/personal build only — see standing decision above):
  - `content/sites/youtube.ts` resolver: intercept `/youtubei/v1/player` → `streamingData.
    adaptiveFormats`; prefer H.264 video itag (137/136/135) + AAC audio itag (140) so output is a
    clean MP4 without VP9/Opus (≤1080p covers the demo; >1080p is VP9/AV1 → WebM, later).
  - `background/network-capture.ts`: add googlevideo host capture (videoplayback URLs have no file
    extension, so `looksLikeMediaEntryUrl` won't catch them — needs explicit host match) OR emit the
    two chosen itag URLs from the resolver directly. Add `googlevideo.com` to extractor-managed set.
  - Merge the two itag byte ranges via `mergeAvToMp4`. Works only while the video is actively
    playing (intercept-first; no paste-URL). Signed URLs expire ~6h.

  **Verification:** ffmpeg-generated demuxed fixtures (video-only mp4 + audio-only m4a) served by the
  e2e fixture-server; a page triggers the merge; ffprobe asserts the output MP4 has BOTH a video and
  an audio stream. Mirror the existing TS→MP4 e2e gate in `tests/e2e/classification.spec.ts`.

  ### PR B — DE-RISKED ✅ (merge primitive proven end-to-end, 2026-07-03)
  Ran the exact mediabunny flow above in node against real ffmpeg fixtures (H.264 video-only mp4 +
  AAC audio-only m4a). Result muxed cleanly; **ffprobe independently confirmed the output MP4 has both
  an h264 video and an aac audio stream** (no re-encode). mediabunny muxes fine under the node entry,
  so the primitive is unit-testable without the browser — but final wiring still verifies via e2e per
  repo convention.
  **CRITICAL GOTCHA (found + solved):** demuxed AAC's first packet has a NEGATIVE timestamp (encoder
  priming, e.g. −0.023s); `IsobmffMuxer.validateTimestamp` throws `Timestamps must be non-negative`.
  Fix: `shift = max(0, -min(videoFirstTs, audioFirstTs))` via `track.getFirstTimestamp()`, then
  `pkt.clone({ timestamp: pkt.timestamp + shift })` for BOTH tracks (one global offset preserves A/V
  sync). This is the silent-corruption trap the merge engine MUST carry. Working proof:
  scratchpad/mbtest/merge-smoke.mjs.

  ### PR B — fragmented-fMP4 input DE-RISKED (2026-07-03)
  The wiring will feed `mergeAvToMp4` CONCATENATED fragmented fMP4 (per track: init segment + all
  media `.m4s` bytes, in order) — the shape DASH SegmentList/Template and HLS-fMP4 produce. Confirmed
  end-to-end: generated fragmented video-only + audio-only fMP4 via `ffmpeg -f hls -hls_segment_type
  fmp4`, concatenated `init + *.m4s` per track, ran the merge -> ffprobe confirms both h264 + aac
  tracks in the output (30 video + 88 audio packets, 2s). So the DASH/HLS engine job is: fetch(init) +
  fetch(each media segment) -> concat per track -> `mergeAvToMp4(videoBytes, audioBytes)`. No
  per-segment demux needed; mediabunny reads the whole concatenated fragmented stream. Proof:
  scratchpad/mbtest/merge-frag-smoke.mjs.

## Verify
`pnpm typecheck && pnpm -r test` must stay green. E2e (`pnpm test:e2e:chromium`) is the enforcement
mechanism — add fixtures for new capabilities where tractable.
