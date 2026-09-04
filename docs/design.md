# savemedia Design

This document records the repository's single supported product contract. It
does not use roadmap labels: a behavior is supported, refused, or not claimed.

## Product Boundary

savemedia saves browser-visible video when the extension can fetch every
required byte and produce one playable final file with tested code.

It refuses instead of guessing when any of these are true:

- the stream is protected by DRM or ClearKey/CENC sample encryption;
- the stream is encrypted HLS, HLS Live/DVR, or malformed HLS fMP4/CMAF;
- the stream is DASH without a clear, fully addressed video+audio pair
  (dynamic/live MPD, byte-range addressing, or no audio AdaptationSet);
- the server denies access, rate-limits, or is busy after retries;
- a required manifest or media segment cannot be fetched;
- the output would exceed the browser in-memory Blob limit;
- the URL looks like media but headers/magic bytes do not confirm video.

The extension must not save `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.css`,
`.js`, `.html`, standalone audio, random segments, init segments, or mislabeled
files as video.

## Supported Capabilities

| Capability | Status | Verification gate |
| --- | --- | --- |
| Direct verified `.mp4` download | Implemented | Chrome e2e downloads a real fixture and verifies with `ffprobe`. |
| Direct verified `.webm` / `.mkv` detection | Implemented | Fixture server and classification tests cover descriptors. |
| Plain HLS VOD with MPEG-TS segments | Implemented | Chrome e2e remuxes a real TS fixture to playable MP4. |
| Plain HLS VOD with clear fMP4/CMAF segments | Implemented | Chrome e2e downloads a real `EXT-X-MAP` fixture to playable MP4 after init/fragment validation. |
| Demuxed HLS (`EXT-X-MEDIA` audio group) → single merged MP4 | Implemented | Chrome e2e downloads a real demuxed fMP4 fixture (separate video/audio media playlists) and `ffprobe` verifies the output MP4 carries both an h264 video and an aac audio stream. A demuxed variant never falls back to the plain-HLS path, so a silent video-only file cannot be saved. |
| Clear DASH video+audio → single merged MP4 | Implemented | DASH MPDs with a clear, fully addressed video+audio AdaptationSet pair dispatch to the same av-merge engine (dispatch unit tests); anything less refuses with `dash_unsupported`. The merge engine itself is gated by the demuxed-HLS e2e `ffprobe` spec. |
| DASH refusal (encrypted, dynamic/live, byte-range, or audio-less) | Implemented | DASH fixtures produce descriptors and download refuses with `dash_unsupported`; dynamic-MPD fixture stays unmaterialized. |
| YouTube adaptive H.264+AAC merge — unlisted builds only | Implemented | MAIN-world resolver reads the page's own InnerTube player response, picks an H.264 video itag (137/136/135/134) + AAC itag (140), and the pair merges to one MP4 via the av-merge engine; `googlevideo.com` is captured as an extractor-managed host. Unit tests cover the resolver (golden fixture), registry, and host capture. Chrome Web Store prohibits YouTube-download extensions, so this capability ships only in unlisted/personal builds. |
| HLS AES-128 detection/refusal | Implemented | AES fixture refuses with `hls_encryption_unsupported` before key/ciphertext download. |
| HLS fMP4/CMAF internal-piece filtering | Implemented | Fixture verifies init/fragment URLs are not surfaced as standalone downloads. |
| DRM detection | Implemented | Widevine fixture is refused with `cdm_required`. |
| ClearKey/CENC detection | Implemented | ClearKey fixture is refused with `clearkey_deferred`. |
| Twitter/X & Instagram progressive MP4 | Implemented | MAIN-world site resolvers (`content/sites/*`) read the page's own API responses and surface the muxed progressive MP4 as a verified direct download. Unit tests cover the resolvers (golden fixtures) and the fetch/XHR interceptor wiring; generic discovery is suppressed on these hosts so the demuxed video-only stream cannot outrank it. |
| `Alt+S` best download command | Implemented | Automated tests check command registration; headed Playwright does not reliably fire extension shortcuts. |
| Local downloader (opt-in) | Implemented | Optional `nativeMessaging` permission requested from the popup. Background hands only the page URL to `packages/native-host` (user-installed yt-dlp and ffmpeg) when the user asks, or as the Alt+S fallback when the in-browser engine has nothing to save or refuses for a non-DRM reason (`DELEGABLE_ERROR_CODES` allowlist). Protected media never reaches the host. Progress, completion, and failures stream back to the popup and to an in-page toast. See `docs/boundary-rules.md`. |
| Edge runtime | Release-gated | `smoke:edge` launches Edge with the unpacked Chromium build, opens the popup, checks runtime messaging/command registration, downloads direct MP4, remuxes HLS MPEG-TS VOD, downloads clear HLS fMP4/CMAF, and verifies refusal fixtures. |
| Firefox runtime | Release-gated | `smoke:firefox` temporarily installs the extension, opens the popup, checks runtime messaging/command registration, downloads direct MP4, remuxes HLS MPEG-TS VOD, downloads clear HLS fMP4/CMAF, and verifies refusal fixtures. |

## Unsupported

- Native messaging host, yt-dlp integration, local ffmpeg integration, or
  browser-to-native streaming sinks.
- ffmpeg.wasm or browser-side transcoding.
- "Small file", "best quality transcode", manual output modes, or arbitrary MP4
  conversion modes.
- Dynamic/live DASH, byte-range-addressed DASH, or DASH without a clear audio
  AdaptationSet (these keep the `dash_unsupported` refusal).
- YouTube above 1080p (VP9/AV1 itags would require WebM merge output) and any
  YouTube support in a store-listed build — listing and YouTube-download are
  mutually exclusive under Chrome Web Store policy.
- HLS AES-128/SAMPLE-AES download.
- HLS Live/DVR recording.
- Direct `.mov`, `.avi`, `.wmv`, `.flv`, or URL-only media guesses.
- Standalone audio downloads.
- Browser store submission beyond the current privacy policy, listing draft,
  permission justification, reviewer notes, package icons, and support matrix.
- Mobile browser support, side panel UI, subtitles, telemetry, or cross-device
  sync.

## Runtime Architecture

```text
Page MAIN world
  content-main.js
  passive resource timing, media-element, MediaSource, and EME observation
        |
        v
Page ISOLATED world
  content-bridge.js
  validates __savemedia messages and calls chrome.runtime.sendMessage
        |
        v
Background router
  classifies descriptors, dedupes noisy segment URLs, owns job state
        |
        +-- direct verified progressive URL -> chrome.downloads.download
        |
        v
Chromium offscreen document
  engine host runs plain-HLS and av-merge jobs and returns Blob URLs
        |
        v
chrome.downloads.download
```

Firefox has a separate build target. Its background event page hosts the HLS
engine in-process because Firefox has no `chrome.offscreen` API. Chrome passing
is not Firefox evidence; `smoke:firefox` is the Firefox runtime gate.

## Classification Rules

Classification is layered:

1. URL hints identify plausible media entry points.
2. HTTP headers refine container/content type.
3. HLS/DASH manifest parsing confirms protocols, variants, and protected-media
   signals.
4. Magic bytes confirm standalone direct containers.

The detector intentionally drops noisy internal pieces:

- HLS/DASH segment URLs (`.ts`, `.m4s`, numbered fragments);
- fMP4 init segments such as `init.mp4`;
- non-media web assets;
- repeated numeric direct-fragment families that are not a complete video.

Direct download is allowed only after headers or magic bytes confirm MP4, WebM,
or MKV. `.mp4` in a URL is a hint, not permission.

## Download Jobs

### Direct

Direct progressive files are handed to `chrome.downloads.download`. The
extension does not convert progressive containers. If the server provides MKV,
the saved file is MKV.

### HLS

The engine fetches the selected media playlist, not just the master playlist.
Runtime playlist parsing is authoritative because `EXT-X-KEY`, `EXT-X-MAP`, and
`EXT-X-ENDLIST` live on the media playlist.

Supported:

- clear MPEG-TS HLS VOD -> MP4 remux;
- clear fMP4/CMAF HLS VOD -> MP4 assembly after validating `ftyp`/`moov` init
  boxes and `moof`/`mdat` media-fragment boxes;
- clear demuxed HLS VOD (`EXT-X-MEDIA TYPE=AUDIO` group) -> both media
  playlists are materialized to concrete segment URLs, each track is fetched
  and concatenated, and the pair is muxed into one MP4 by the av-merge engine
  (copy-encoded-packets, no re-encode). A demuxed variant must never fall back
  to the plain path: if the audio track cannot be planned, the job refuses
  rather than saving silent video.

Refused:

- missing `EXT-X-ENDLIST`;
- AES-128, SAMPLE-AES, SAMPLE-AES-CTR, or any `EXT-X-KEY`;
- malformed `EXT-X-MAP` fMP4/CMAF playlists;
- unknown first-segment bytes.

### DASH

DASH manifests are parsed for descriptors, protected-media detection, and clear
video+audio AdaptationSet pairs. A clear pair with fully addressed segments
dispatches to the av-merge engine and saves one merged MP4. Anything less —
DRM, a dynamic/live MPD, byte-range addressing, unmaterialized segments, or no
audio AdaptationSet — refuses with `dash_unsupported` (DRM with its own code).

### Audio+video merge (av-merge)

The merge engine (`engine/remux/merge-av.ts` via `engine/jobs/av-merge.ts`,
mediabunny) copies encoded packets from a video-only and an audio-only input
into one MP4; it never re-encodes. Each track arrives as init segment + media
segments concatenated in order. Both tracks are rebased by one global timestamp
offset (`max(0, -min(firstVideoTs, firstAudioTs))`) because demuxed AAC starts
at a negative priming timestamp that the MP4 muxer rejects — a single shared
offset preserves A/V sync. Output is always MP4; a failed or aborted merge
discards its partial output.

## Failure Reasons

User-visible failures are categorized before surfacing:

- `rate_limited`: HTTP 429, includes `Retry-After` when present.
- `server_busy`: HTTP 408, 425, or 5xx after retries.
- `access_denied`: HTTP 401, 402, or 403. This covers login, entitlement,
  payment, expired signed URL, or site-side block. It is not called DRM unless
  an actual DRM signal was detected.
- `network_unreachable`: browser fetch failed before an HTTP response.
- `dash_unsupported`, `hls_encryption_unsupported`, `hls_live_unsupported`,
  `hls_layout_unsupported`: terminal product-boundary refusals.
- `output_too_large_for_browser`: estimated output exceeds the browser Blob
  path limit.
- `browser_download_failed`: Chrome/Firefox refused the final save.
- DRM/ClearKey codes: terminal, no retry action.

Partial stream outputs are aborted and discarded on required-segment failure.

## Verification Strategy

The project treats downloader correctness as a media problem, not a "file was
created" problem.

- Unit tests cover classification, dispatch, retry classification, routing,
  popup error rendering, HLS runner behavior, and parser edge cases.
- E2E fixture server serves real tiny downloadable media generated by ffmpeg.
- Chromium e2e loads the unpacked extension, triggers real downloads, and runs
  `ffprobe` on the resulting files.
- Firefox runtime smoke uses Selenium WebDriver with a temporary Firefox
  extension install because Playwright extension loading is Chromium-only.
- Firefox Playwright fixture tests exercise only the fixture server and must not
  be counted as Firefox extension runtime support.

Any advertised protocol/container path needs a golden fixture plus a
playback/`ffprobe` assertion.
