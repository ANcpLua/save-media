# savemedia

Browser extension for saving browser-visible video when the extension can prove
it is a complete video and can produce one playable final file.

There is one support contract. A path is either supported, refused with a clear
reason, or not claimed. savemedia is not a DRM bypass tool and does not use a
native host, yt-dlp, ffmpeg.wasm, local ffmpeg, or hidden remote services.

## Supported

The release gates cover these paths with real media fixtures:

- Direct progressive `.mp4`, `.webm`, and `.mkv` files after headers or magic
  bytes confirm the container. A matching URL extension alone is only a hint.
- Plain HLS VOD with MPEG-TS segments, remuxed to one playable MP4.
- Plain HLS VOD with clear fMP4/CMAF init + media fragments, assembled to one
  playable MP4 after MP4 box validation.
- DRM, ClearKey/CENC, DASH, encrypted HLS, malformed fMP4/CMAF, and live HLS
  detection as refusal cases.
- Negative filtering for `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.css`,
  `.js`, `.html`, standalone audio files, orphan `.ts`, orphan `.m4s`, init
  segments, and numbered chunk URLs.
- `Alt+S` command registration and best-download routing.
- Firefox Desktop runtime smoke coverage for the direct, HLS, command, and
  refusal paths listed in the browser evidence table.

The engine aborts partial in-memory output when a required segment fails. It
must not save random chunks, fake `.mp4` HTML responses, or mislabeled `.ts`
bytes as final video.

## Refused

- DASH downloads.
- Standalone audio downloads.
- HLS AES-128, SAMPLE-AES, SAMPLE-AES-CTR, ClearKey/CENC, Widevine, PlayReady,
  FairPlay, and other protected media paths.
- HLS Live/DVR or any playlist without `EXT-X-ENDLIST`.
- HLS fMP4/CMAF playlists whose init or media fragments fail MP4 box validation.
- Direct `.mov`, `.avi`, `.wmv`, `.flv`, `.m4v` as independent support claims.
  `m4v` may be accepted only when bytes prove it is normal MP4.
- Transcoding, size-reduction modes, arbitrary container conversion, and
  browser-native downloads above the in-memory safety limit.
- Unknown protocol or URL-only "best effort" downloads.

## Browser Evidence

| Browser target | Current evidence | Claim level |
| --- | --- | --- |
| Chrome | Automated unpacked-extension Playwright suite, including direct, HLS MPEG-TS, and HLS fMP4/CMAF downloads verified with `ffprobe`. | Claimed after the Chrome gate passes for the release commit. |
| Edge | Edge zip builds; `smoke:edge` launches Microsoft Edge, opens the popup, checks `Alt+S`, downloads direct MP4, remuxes HLS MPEG-TS VOD, downloads clear HLS fMP4/CMAF, and verifies refusal fixtures. | Claimed after the Edge smoke gate passes for the release commit. |
| Firefox | Firefox zip builds for Firefox Desktop 140+; `smoke:firefox` temporarily installs `dist-firefox`, opens the popup, checks `Alt+S`, downloads direct MP4, remuxes HLS MPEG-TS VOD, downloads clear HLS fMP4/CMAF, and verifies refusal fixtures. | Claimed after Firefox lint and smoke gates pass for the release commit. |

Store-readiness drafts live in `docs/privacy-policy.md` and
`docs/store-submission.md`. Any store listing must match the browser evidence
above and must not imply DRM, paywall, login, protected-stream, or universal
download bypass.

## Architecture

- `packages/core`: classification, DASH/DRM/HLS parsing for descriptors,
  dispatch decisions, retry policy, and user-facing error taxonomy.
- `packages/extension`: MV3 extension, popup UI, background router, passive
  content detection, Chromium offscreen engine host, direct downloads, and
  plain-HLS jobs.
- `packages/extension/tests/e2e/media-fixtures`: real tiny downloadable media
  fixtures used by Playwright and `ffprobe`.

Chrome execution path:

1. MAIN-world content script passively observes resource timing, media elements,
   MediaSource encryption probes, and EME requests. It does not monkey-patch
   page `fetch` or `XMLHttpRequest`.
2. ISOLATED bridge relays tagged messages to the service worker.
3. The service worker also watches network entry requests, classifies
   descriptors, dedupes noisy segment URLs, and starts either a direct browser
   download or an HLS engine job.
4. The offscreen engine fetches the selected HLS media playlist and segments,
   refuses unsupported layouts/encryption, remuxes MPEG-TS to MP4 or assembles
   validated fMP4/CMAF fragments, verifies the MP4 structure, and hands a Blob
   URL to `chrome.downloads.download`.

## Development

```sh
pnpm install
pnpm --filter @savemedia/core build
pnpm -r typecheck
pnpm -r test
pnpm --filter @savemedia/extension build:chrome
pnpm --filter @savemedia/extension test:e2e
pnpm --filter @savemedia/extension smoke:edge
pnpm --filter @savemedia/extension smoke:firefox
pnpm --filter @savemedia/extension zip
```

`pnpm verify` runs typecheck, unit tests, production Chrome and Firefox builds,
and the Chromium Playwright suite against the unpacked Chrome extension.
Install `ffmpeg`/`ffprobe` before running media-download e2e or smoke tests.

## Loading Locally

Build and load Chrome from:

```sh
pnpm --filter @savemedia/extension build:chrome
```

Then load `packages/extension/dist-chrome` as an unpacked extension.

Release zips are created by:

```sh
pnpm --filter @savemedia/extension zip
```

The zip task creates Chrome, Edge, Firefox, and source packages. Generated
packages include `LICENSE` and `NOTICE`; do not upload stale local zips after a
source or license change.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.

## Support

Use GitHub Issues for reproducible bugs and store-review questions. Do not post
credentials, cookies, private media URLs, license keys, or other secrets.
