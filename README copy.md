# savemedia

Browser-extension video downloader for Chrome, Edge, and Firefox.

Detects browser-visible media — direct video files, HLS, DASH, progressive HTTP — classifies streams, lets the user pick quality and output mode, and saves complete verified video files. Does not bypass DRM.

## Supported

- **Browsers:** Chrome 114+, Edge 114+, Firefox 128+
- **Protocols:** progressive HTTP, HLS (M3U8), DASH (MPD)
- **Containers:** MP4, M4V, WebM, MKV, MOV, MPEG-TS, fMP4/CMAF (legacy: AVI, WMV, FLV)
- **Video codecs:** H.264, H.265, VP8, VP9, AV1
- **Audio codecs (muxed only):** AAC, MP3, Opus, Vorbis, FLAC, PCM
- **Encryption:** HLS AES-128 with reachable key (decrypted client-side). Widevine / PlayReady / FairPlay / SAMPLE-AES / ClearKey CENC are detected and refused.

## Architecture

- Content script (MAIN-world hooks + ISOLATED-world relay) detects media
- Service worker / event page coordinates jobs and classification
- Offscreen document (Chromium) / event-page DOM (Firefox) hosts a Web Worker running Mediabunny + WebCodecs for remux, with lazy-loaded ffmpeg.wasm for transcode
- Optional Python native messaging host (yt-dlp + ffmpeg) for cookie-bound CDNs and files larger than 2 GB

Full design in `docs/design.md`.

## Packages

- `packages/core` — `@savemedia/core`, the pure-logic library (types, classifier, dispatch, verify, error taxonomy, retry policy). Zero browser APIs. Consumable from Node.

## Development

```sh
pnpm install
pnpm -r test
pnpm -r typecheck
pnpm -r build
```
