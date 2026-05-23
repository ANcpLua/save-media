# savemedia — Design

## 1. Product

`savemedia` is a browser-extension video downloader. It detects browser-visible media, classifies the stream accurately, lets the user pick quality and output mode, and saves a complete verified video file. Runs on Chrome, Edge, and Firefox with feature parity.

The detector preserves this invariant:

```
container != codec != protocol != stream type != output format
```

File extension never decides playability, mergeability, or conversion behaviour.

## 2. Scope

**In scope:**

- Direct video files: `.mp4 / .m4v / .webm / .mov / .mkv / .avi / .wmv / .flv`
- Progressive video downloads
- HTML5 `<video>` element media
- Embedded-player media observable from the browser runtime
- HLS / `.m3u8` (master + media playlists, variant streams, audio renditions, MPEG-TS + fMP4 + CMAF segments, VOD + Live/DVR)
- DASH / `.mpd` (video + audio representations, `SegmentTemplate`, `SegmentTimeline`, `SegmentBase`, fMP4 + CMAF segments)
- HLS AES-128 with reachable key URI (decrypted client-side via SubtleCrypto)

**Out of scope:**

- Standalone audio downloads (audio is supported only when muxed with video)
- DRM circumvention (Widevine / PlayReady / FairPlay) — detected and surfaced as terminal failure
- ClearKey / CENC sample-encryption decryption (detected, deferred to v2)
- Mobile browser support
- `.html / .jpg / .jpeg / .png / .gif / .css / .js` and other non-media assets

## 3. Architecture

### 3.1 Execution contexts

```
Page context — MAIN world (content-script.ts, document_start)
    │
    ├── window.fetch + XMLHttpRequest hooks
    ├── MediaSource.addSourceBuffer hook
    ├── navigator.requestMediaKeySystemAccess hook (DRM signal)
    ├── MediaSource.isTypeSupported probe hook
    └── MutationObserver for <video> / <audio> elements
            │  No chrome.runtime API in MAIN world — must relay
            ▼  window.postMessage({ __savemedia: true, ... })
Page context — ISOLATED world (bridge.ts, document_start)
    │
    └── window.addEventListener("message") with __savemedia discriminator
            │  Filters foreign messages, validates shape
            ▼  chrome.runtime.sendMessage
Background context
    Chromium: service worker (manifest_v3 service_worker)
    Firefox:  event page  (manifest_v3 background.scripts)
    │
    ├── Classifier  (URL + headers + manifest + magic bytes + init-segment probe)
    ├── Parser      (m3u8-parser + mpd-parser)
    ├── Coordinator (job state machine, queue, retry policy)
    └── chrome.downloads.download (direct files)
            │
            ▼  runtime.sendMessage to engine host
Engine host
    Chromium: offscreen document  (chrome.offscreen.createDocument)
    Firefox:  event-page DOM      (event pages still have DOM in MV3)
    │
    └── Web Worker
        ├── Mediabunny + WebCodecs (primary remux engine, hardware-accelerated)
        └── ffmpeg.wasm           (lazy-loaded; transcode-only fallback)
            │
            ▼  optional stdio (length-prefixed JSON)
Native host (Python 3 + yt-dlp + ffmpeg, packaged as PyInstaller binary)
    │
    ├── download.ytdlp  (power-tool fallback for cookie-bound CDNs)
    ├── sink.open / .chunk / .close / .abort  (streaming sink for > 2 GB files)
    └── probe           (ffprobe wrapper)
```

### 3.2 Per-browser differences

| Layer | Chromium (Chrome + Edge) | Firefox |
|---|---|---|
| Background | Service worker (`service_worker`) | Event page (`background.scripts`) |
| Engine host | Offscreen document via `chrome.offscreen` | Event page DOM directly |
| Extension ID | RSA `"key"` field in manifest | `browser_specific_settings.gecko.id` |
| Native host JSON | `~/Library/Application Support/{Google Chrome,Microsoft Edge}/NativeMessagingHosts/com.savemedia.host.json`, `allowed_origins: ["chrome-extension://{ID}/"]` | `~/Library/Application Support/Mozilla/NativeMessagingHosts/com.savemedia.host.json`, `allowed_extensions: ["savemedia@ancplua.dev"]` |
| Native host registry (Windows) | `HKCU\Software\{Google\Chrome,Microsoft\Edge}\NativeMessagingHosts\com.savemedia.host` | `HKCU\Software\Mozilla\NativeMessagingHosts\com.savemedia.host` |
| ffmpeg.wasm threading | Multi-threaded (SAB available with COOP/COEP) | Single-threaded only (Firefox extensions lack SAB) |
| Min version | Chrome 114+, Edge 114+ | Firefox 128+ |
| `saveAs:true` | Supported on Desktop | Supported on Desktop, errors on Firefox Android |
| `downloads.download` output folder | Filename relative to default Downloads dir; custom folder requires native host | Same restriction |
| `webRequest` blocking | Not allowed in MV3 (we observe only) | Allowed (we still only observe) |

### 3.3 Tech stack

- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
- Vite + React 18 + Tailwind 4 (popup UI)
- `@ffmpeg/ffmpeg` v0.12.x (bundled lite core for transcode fallback)
- Mediabunny (primary remux engine)
- `m3u8-parser` + `mpd-parser` (manifest parsers)
- `mp4box.js` (init-segment codec probe)
- Direct `chrome.*` API (no `webextension-polyfill`)
- Python 3 + yt-dlp + ffmpeg (native host, PyInstaller-built binary)
- Vitest (unit), Playwright (e2e)

## 4. Stream classifier taxonomy

### 4.1 The `StreamDescriptor` type

Single source of truth for every downstream component. Immutable. Carries five orthogonal dimensions plus per-variant details:

```typescript
export interface StreamDescriptor {
  readonly id: StreamId;
  readonly tabId: number;
  readonly pageUrl: string;
  readonly title: string | null;
  readonly detectedAt: number;
  readonly source: StreamSource;
  readonly protocol: ProtocolFamily;       // progressive-http | hls | dash | unknown
  readonly container: Container;           // mp4 | webm | mkv | mov | mpegts | fmp4 | cmaf | avi | wmv | flv | unknown
  readonly codecs: CodecSet;
  readonly variants: readonly Variant[];
  readonly drm: DrmStatus;
  readonly capabilities: OutputCapabilities;
  readonly confidence: Confidence;
}
```

### 4.2 Five-layer classification pipeline

Each layer can refine or correct earlier layers. Confidence increases monotonically.

1. **URL hint** — file extension, query params, path patterns → `confidence: "guessed"`
2. **HTTP response headers** — `Content-Type`, `Content-Disposition` → `confidence: "probable"`
3. **Manifest parse** — M3U8 or MPD via the videojs parsers → `confidence: "confirmed"` for protocol + variants; DRM signals from `#EXT-X-KEY` / `<ContentProtection>`
4. **Magic-byte sniff** — `Range: bytes=0-4095` on the source → `confidence: "confirmed"` for container
5. **Init-segment probe** — `mp4box.js` on fMP4 init segment → `confidence: "confirmed"` for exact RFC 6381 codec strings

### 4.3 Encryption detection

| Source | Where it fires | Specific check | v1 verdict |
|---|---|---|---|
| `eme-hook` | MAIN-world content script (via ISOLATED relay) | `navigator.requestMediaKeySystemAccess(keySystem, ...)` call | `keySystem === "org.w3.clearkey"` → ClearKey deferral; any other keySystem → DRM-blocked |
| `mediasource-probe` | MAIN-world content script (via ISOLATED relay) | `MediaSource.isTypeSupported(...; encrypted)` returning `true` | DRM-blocked |
| `hls-ext-x-key` | Manifest parse | `METHOD ∈ {SAMPLE-AES, SAMPLE-AES-CTR, AES-CTR}` | DRM-blocked |
| `hls-ext-x-key (AES-128)` | Manifest parse | `METHOD=AES-128` AND key URI is reachable | Supported — decrypted client-side via `SubtleCrypto.decrypt` (AES-CBC, per-segment IV) |
| `dash-content-protection (CDM-bound)` | Manifest parse | `schemeIdUri` in {Widevine UUID, PlayReady UUID, FairPlay UUID} | DRM-blocked |
| `dash-content-protection (ClearKey)` | Manifest parse | W3C ClearKey UUID or ClearKey JWK delivery | Deferred to v2 — reason `clearkey_deferred` |

ClearKey is an EME scheme delivering keys in cleartext, but its on-the-wire crypto is CENC sample-encryption (AES-CTR per-sample with `senc` / `saio` / `saiz` MP4 boxes), not whole-segment AES-CBC like HLS AES-128. v1 detects ClearKey but the decryptor lives in v2.

### 4.4 Quality variant filtering

Visible variants are ≥ 720p. Sub-720p hidden unless the source is sub-720p-only, in which case the item is tagged `BelowMinimumQuality` and requires explicit user override.

### 4.5 Codec normalisation

Internal: RFC 6381 strings (`avc1.640028`, `vp09.00.50.08`, `hvc1.1.6.L150.B0`, `av01.0.05M.08`, `mp4a.40.2`, `opus`, `ac-3`, `ec-3`).
UI: data-driven friendly mapping (`H.264 High @ 4.0`, `AAC-LC`, etc.). Adding a codec = one row in `codec-registry.ts`.

## 5. Native host + cross-browser installer

### 5.1 Distribution

Single PyInstaller binary per OS/architecture: `savemedia-host-{darwin,linux,windows}-{arm64,x64}` (~15 MB). Bundles Python 3 runtime; user only needs `yt-dlp` and `ffmpeg` in `PATH`.

### 5.2 Installer flow

```
[1/5] Detecting installed browsers (Chrome / Edge / Firefox)
[2/5] Checking dependencies (Python bundled; yt-dlp; ffmpeg)
[3/5] Resolving host path (absolute path to PyInstaller binary)
[4/5] Writing registrations:
      macOS/Linux: ~/Library/.../NativeMessagingHosts/com.savemedia.host.json
      Windows:     HKCU\Software\.../NativeMessagingHosts\com.savemedia.host
[5/5] Smoke-testing: spawn host, exchange ping/pong with nonce, await capability list
```

Smoke test catches the entire bug class around stale paths, missing binaries, missing deps, malformed JSON, permission denied. Installer never reports success without a successful pong.

### 5.3 Wire protocol

Length-prefixed JSON (Chrome native messaging spec). Documented asymmetric size limits:

- **Browser → host**: up to 4 GB per message (`sink.chunk` is capped at 1 MB for progress granularity, not protocol)
- **Host → browser**: 1 MB per message (small JSON acks only; no raw segment bytes flow back)

```typescript
type HostRequest =
  | { type: "ping";           nonce: string; version: string }
  | { type: "download.ytdlp"; nonce: string; url: string; quality: QualityHint; outputDir: string }
  | { type: "sink.open";      nonce: string; filename: string; expectedSize: number | null }
  | { type: "sink.chunk";     nonce: string; sinkId: string; dataB64: string; offset: number }
  | { type: "sink.close";     nonce: string; sinkId: string; finalChecksum: string }
  | { type: "sink.abort";     nonce: string; sinkId: string }
  | { type: "probe";          nonce: string; url: string };

type HostResponse =
  | { type: "pong";        nonce: string; host: string; version: string; capabilities: HostCapability[] }
  | { type: "progress";    nonce: string; bytesWritten: number; bytesTotal: number | null; phase: ProgressPhase }
  | { type: "complete";    nonce: string; outputPath: string; bytesWritten: number; checksum: string }
  | { type: "sink.opened"; nonce: string; sinkId: string }
  | { type: "sink.ack";    nonce: string; sinkId: string; bytesAcked: number }
  | { type: "sink.aborted"; nonce: string; sinkId: string; partialBytesDiscarded: number }
  | { type: "error";       nonce: string; code: HostErrorCode; detail: string };
```

### 5.4 Streaming sink (> 2 GB path)

`sink.open` → host opens `~/Downloads/<filename>.tmp` for write. Engine streams 1 MB chunks via `sink.chunk` (base64). Host fsyncs every 64 MB. `sink.close` triggers final fsync + rename `.tmp` → final. Checksum mismatch or abort → `.tmp` deleted.

### 5.5 Security

- Runs as unprivileged user
- No `shell=True`; explicit argv only
- JSON shape validated before dispatch
- Filenames sanitised (`/`, `..`, null-byte removal)
- Subprocess timeboxed
- Logs at `~/Downloads/save-media/host.log` with URL-hash redaction (full URLs only under `SAVEMEDIA_DEBUG_URLS=1`)

## 6. Engine orchestration

### 6.1 Job dispatch (pure function)

`dispatch(descriptor: StreamDescriptor, choice: UserChoice) → JobPlan | DispatchRefusal` produces a step list without I/O. Plan kinds:

- `direct` — progressive HTTP source with `capabilities.directDownload === true` and `outputMode === Original`. No engine work.
- `hls-plain` — HLS source without encryption.
- `hls-aes` — HLS source with `METHOD=AES-128` and reachable key URI. Same as `hls-plain` plus SubtleCrypto AES-CBC decrypt per segment.
- `dash` — DASH source.
- `remux` — progressive HTTP source where the container must change (e.g., MKV → MP4) but codecs are compatible with the target.
- `transcode` — codecs must change. Engine lazy-loads ffmpeg.wasm and re-encodes (or escalates to native ffmpeg via host).

DRM-blocked descriptors produce `DispatchRefusal` with the reason code.

### 6.2 Memory model

Worker holds at most ~16 MB resident. Source `ArrayBuffer`s are transferred (zero-copy) via `postMessage`. Output chunks (1 MB) stream out to coordinator. Above 2 GB total size: forwarded to native streaming sink.

### 6.3 Verify-before-finalize

`VerifiedOutput` is a branded type with a private `unique symbol`. `verify()` is the only function that can construct one. `finalize()` takes `VerifiedOutput` only. Forgetting to verify is a compile error. Verification runs four checks: segment count vs manifest, duration tolerance (±1 frame), byte-checksum (SHA-256), container validity via mp4box probe. Any failure → partial file deleted, job state = `failed-verification`.

### 6.4 Cancellation

`AbortController` propagated three levels: coordinator → in-flight `fetch()` → worker. Worker pauses input, flushes muxer, discards buffer. Coordinator cancels any started `chrome.downloads.download` and sends `sink.abort { sinkId }` to native host.

### 6.5 Progress reporting

Worker posts three event granularities (`segment-complete`, `phase-change`, `throughput`). Coordinator throttles to UI at most 1 event / 250 ms / job. UI shows smoothed progress with 1-second moving-average ETA.

## 7. Error taxonomy

Closed discriminated union `JobError` in `src/errors/taxonomy.ts`. Severity is binary: `terminal` (no retry button) or `recoverable` (one auto-retry; manual retry button after).

Error families:

- **DRM / CDM-bound encryption**: `encrypted_media_detected`, `cdm_required`, `clear_segments_unavailable`, `license_bound_stream`, `clearkey_deferred` — all terminal.
- **Source availability**: `live_window_expired`, `manifest_404`, `manifest_malformed` — terminal.
- **Track availability**: `missing_video_track`, `missing_audio_track`, `no_variant_meets_minimum` — terminal.
- **Codec compatibility**: `unsupported_codec`, `no_remux_path`, `no_transcode_path` — terminal, surfaced before processing.
- **Network**: `segment_fetch_failed` (recoverable), `segment_budget_exhausted` (terminal at > 5 % failure ratio or 10 consecutive failures), `manifest_refresh_failed` (recoverable).
- **Browser security**: `cors_blocked`, `mixed_content_blocked` — terminal.
- **Verification**: `verification_segment_count`, `verification_duration`, `verification_checksum`, `verification_container` — terminal, partial file deleted.
- **Engine**: `mediabunny_demux_failed`, `ffmpeg_wasm_load_failed`, `ffmpeg_transcode_failed`, `engine_oom`.
- **Native host**: `native_host_not_registered`, `native_host_dependency`, `native_host_timeout`, `native_host_protocol`, `native_sink_io_error`.
- **User**: `user_cancelled` — terminal, partial file deleted.

Every variant has a paired `userMessage()` mapping. Adding a new variant without a UI message is a TypeScript exhaustiveness compile error.

### Retry policy

```typescript
RETRY_POLICY = {
  segment:           { maxAttempts: 5, baseMs: 250, maxBackoffMs: 4000, jitterFraction: 0.2, retryableStatuses: [408, 425, 429, 500, 502, 503, 504] },
  job:               { maxFailedSegmentRatio: 0.05, maxConsecutiveFailures: 10 },
  manifest:          { maxAttempts: 3, baseMs: 500, maxBackoffMs: 4000, jitterFraction: 0.2 },
  ffmpegWasmLoad:    { maxAttempts: 3, baseMs: 2000, maxBackoffMs: 2000, jitterFraction: 0.1 },
  nativeHost: {
    ytdlpTimeoutSeconds:        3600,
    streamingSinkTimeoutSeconds: 14400,
    probeTimeoutSeconds:           30,
    maxConsecutiveTimeouts:         2,
  },
};
```

### Telemetry

Zero remote telemetry. All logs are local files. The manifest requests no `host_permissions` for third-party analytics domains.

## 8. UI / UX

### 8.1 Toolbar icon state machine

Five states encoded by badge text + colour on a single icon file: idle (grey) / detected (blue, count) / downloading (blue, percent) / completed (green, ✓ for 5 s) / error (red, !).

### 8.2 Popup (380 × 540 px default, auto-grows to 800 × 600)

- Header: extension name, settings gear (opens full-tab options page)
- Body: list of detected items (compact cards by default, expanded view reveals every field)
- In-progress card: phase + ETA + throughput + progress bar + Cancel
- DRM-blocked card: terminal — no retry button, "Dismiss" only
- Native-host-not-installed card: "Install native host" CTA

### 8.3 Detected-item card (expanded)

Shows: title (editable), source type, resolution, frame rate, video codec (RFC 6381 + friendly), audio codec, container, stream type, bitrate, estimated size, output action (direct / remux / transcode), status. Quality picker filters per § 4.4. Output mode selector: Original / MP4 Compatible / Best Quality / Small File (≥ 720p) / Manual.

### 8.4 Sub-720p source handling

Card greyed with `⚠ Source below minimum quality` label. "Download anyway at N p" is the explicit override.

### 8.5 Settings (separate full-tab page, ~720 px wide)

Sections: Downloads (subfolder under browser Downloads dir, conflict policy, min-quality toggle), Engine (Mediabunny locked primary, browser-only remux limits, worker memory cap), Privacy (telemetry off-by-default, diagnostic URL logging toggle), Diagnostics (job log viewer, version).

## 9. Testing strategy

| Tier | Tool | Speed | When |
|---|---|---|---|
| Unit | Vitest (Node) | ~2 s | Every save |
| Integration | Vitest + fixture server | ~30 s | Pre-commit |
| E2E | Playwright (real Chrome + Firefox) | ~5 min | Pre-PR + CI |
| Native host | pytest | ~5 s | Pre-commit |

Real-world M3U8 and MPD manifests are committed to `e2e/fixtures/`, each paired with an expected `StreamDescriptor` JSON. Parser tests compare actual vs expected; updating expected output is a deliberate `git diff` review.

Cross-browser CI matrix: `unit` (Ubuntu), `integration` (Ubuntu), `e2e` (Chrome / Edge / Firefox × macOS / Ubuntu / Windows), `python` (Ubuntu), `pyinstaller-build` (macOS-arm64 / macOS-x64 / Ubuntu-x64 / Windows-x64).

## 10. Acceptance criteria

| # | Criterion |
|---|---|
| 1 | Detects direct video files. |
| 2 | Detects progressive video downloads. |
| 3 | Detects HLS `.m3u8` playlists. |
| 4 | Detects DASH `.mpd` manifests. |
| 5 | Does not classify `.html / .jpg / .png / .gif / .css / .js` or standalone audio as video. |
| 6 | Parses available video qualities, variants, tracks, codecs, containers. |
| 7 | Exposes 2160p / 1440p / 1080p / 720p variants when available. |
| 8 | Does not expose 480p or lower as normal selectable quality. |
| 9 | Supports segmented HLS downloads. |
| 10 | Supports segmented DASH downloads. |
| 11 | Supports MP4, WebM, MKV, MOV, MPEG-TS, fMP4/CMAF. |
| 12 | Supports audio tracks only as part of complete video output. |
| 13 | Does not provide sound-only or audio-extraction output modes. |
| 14 | Preserves source quality by default. |
| 15 | Shows output action: direct / remux / transcode. |
| 16 | Retries failed segments and verifies final completeness. |
| 17 | Marks incomplete or corrupted outputs clearly. |
| 18 | Detects CDM-bound protected streams (Widevine / PlayReady / FairPlay / SAMPLE-AES) and ClearKey/CENC as unsupported in v1. Does not block reachable-key HLS AES-128. |
| 19 | Labels unsupported streams with a specific technical reason. ClearKey gets `clearkey_deferred` distinct from CDM-block codes. |

## 11. Deferred to v2

- Side panel UI on Chromium (`chrome.sidePanel`) and Firefox (`sidebar_action`)
- Subtitle / caption extraction (HLS WebVTT + DASH `<AdaptationSet contentType="text">`)
- ClearKey / CENC sample-encryption decryption (detection in v1, full CENC `senc`/`saio`/`saiz` parsing + AES-CTR sample decryptor in v2)
- Browser-Sync / cross-device download history
- Self-hosted aggregated error-code telemetry endpoint (opt-in)
- Mobile browser support
- Chrome Web Store / Edge Add-ons / AMO submission

## 12. Known risks

1. **Mediabunny MKV demuxer maturity** — MKV → MP4 remux depends on Mediabunny's MKV support landing in a stable release; ffmpeg.wasm fallback covers the gap.
2. **Firefox Android** — lacks WebCodecs; explicitly documented as unsupported.
3. **ffmpeg.wasm core size pressure on extension bundle** — lite core bundled (~7 MB) per Chrome Web Store remote-hosted-code policy. Combined with React + parsers + UI, unpacked extension is ~12 MB.
4. **`yt-dlp` API drift** — major releases can change argument grammar. Lock `yt-dlp` to a known-good version in the installer's dependency check.
