# savemedia Design

This document records the repository's single supported product contract. It
does not use roadmap labels: a behavior is supported, refused, or not claimed.

## Product Boundary

savemedia saves browser-visible video when the extension can fetch every
required byte and produce one playable final file with tested code.

It refuses instead of guessing when any of these are true:

- the stream is protected by DRM or ClearKey/CENC sample encryption;
- the stream is DASH, encrypted HLS, HLS Live/DVR, or HLS fMP4/CMAF;
- the server denies access, rate-limits, or is busy after retries;
- a required manifest or media segment cannot be fetched;
- the output would exceed the browser in-memory Blob limit;
- the URL looks like media but headers/magic bytes do not confirm video.

The extension must not save `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.css`,
`.js`, `.html`, standalone audio, random segments, init segments, or mislabeled
files as video.

## Supported Capabilities

| Capability | Status | Verification |
| --- | --- | --- |
| Direct verified `.mp4` download | Works | Chrome e2e downloads a real fixture and verifies with `ffprobe`. |
| Direct verified `.webm` / `.mkv` detection | Works | Fixture server and classification tests cover descriptors. |
| Plain HLS VOD with MPEG-TS segments | Works | Chrome e2e remuxes a real TS fixture to playable MP4. |
| DASH detection/refusal | Works | DASH fixture produces a descriptor and download refuses with `dash_unsupported`. |
| HLS AES-128 detection/refusal | Works | AES fixture refuses with `hls_encryption_unsupported` before key/ciphertext download. |
| HLS fMP4/CMAF detection/refusal | Works | Fixture verifies init/fragment URLs are not surfaced as standalone downloads. |
| DRM detection | Works | Widevine fixture is refused with `cdm_required`. |
| ClearKey/CENC detection | Works | ClearKey fixture is refused with `clearkey_deferred`. |
| `Alt+S` best download command | Registered in Chrome, Edge, and Firefox | Automated tests check command registration; headed Playwright does not reliably fire extension shortcuts. |
| Edge runtime | Works on Microsoft Edge | `smoke:edge` launches Edge with the unpacked Chromium build, opens the popup, checks runtime messaging/command registration, downloads direct MP4, remuxes HLS VOD, and verifies refusal fixtures. |
| Firefox runtime | Works on Firefox Desktop | `smoke:firefox` temporarily installs the extension, opens the popup, checks runtime messaging/command registration, downloads direct MP4, remuxes HLS VOD, and verifies refusal fixtures. |

## Unsupported

- Native messaging host, yt-dlp integration, local ffmpeg integration, or
  browser-to-native streaming sinks.
- ffmpeg.wasm or browser-side transcoding.
- "Small file", "best quality transcode", manual output modes, or arbitrary MP4
  conversion modes.
- DASH downloads or MPD segment assembly.
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
  engine host runs plain-HLS jobs and returns Blob URLs
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

- clear MPEG-TS HLS VOD -> MP4 remux.

Refused:

- missing `EXT-X-ENDLIST`;
- AES-128, SAMPLE-AES, SAMPLE-AES-CTR, or any `EXT-X-KEY`;
- `EXT-X-MAP` fMP4/CMAF playlists;
- unknown first-segment bytes.

### DASH

DASH manifests are parsed for descriptor and protected-media detection only.
Download attempts refuse with `dash_unsupported`.

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
