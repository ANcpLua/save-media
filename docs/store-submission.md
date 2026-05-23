# Store Submission Notes

This file is the source draft for Chrome Web Store, Microsoft Edge Add-ons, and
addons.mozilla.org submission review. Claims here must stay tied to runtime
evidence in this repository.

Sources reviewed on 2026-05-23:

- [Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Chrome Web Store Developer Agreement](https://developer.chrome.com/docs/webstore/program-policies/terms)
- [Microsoft Edge Add-ons developer policies](https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies)
- [Firefox Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)
- [Firefox source code submission guidance](https://extensionworkshop.com/documentation/publish/source-code-submission/)
- [Firefox web-ext guidance](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/)
- [Firefox `browser_specific_settings` manifest guidance](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings)
- [Playwright Chrome extension guidance](https://playwright.dev/docs/chrome-extensions)

## Product Boundary

savemedia saves only browser-visible video that the extension can prove is a
complete supported file:

- verified direct MP4, WebM, or MKV;
- plain HLS VOD with MPEG-TS segments, remuxed locally to MP4.

savemedia refuses:

- DASH downloads;
- encrypted HLS, SAMPLE-AES, ClearKey/CENC, DRM, Widevine, PlayReady, FairPlay;
- live or DVR HLS;
- HLS fMP4/CMAF;
- orphan chunks, init segments, standalone audio, images, HTML, CSS, JS, and
  unknown protocols;
- URL-only guesses and mislabeled responses.

The extension does not bypass DRM, paywalls, login restrictions, geographic
restrictions, expired signed URLs, protected streams, or site access controls.
It does not include a native host, yt-dlp, local ffmpeg, ffmpeg.wasm,
transcoding, DASH assembly, AES decryption, or "download anything" behavior.

## Browser Support Matrix

| Browser target | Evidence | Submission status |
| --- | --- | --- |
| Chrome | `pnpm verify`; headed Chromium Playwright extension suite; direct and HLS downloads verified with `ffprobe`; refusal fixtures covered. | Ready for a Chrome Web Store submission package within the product boundary above. |
| Edge | `smoke:edge` launches Microsoft Edge with the unpacked Chromium build, opens the popup, checks `download-best` command registration, downloads direct MP4, remuxes plain HLS VOD, and checks DASH/encrypted-HLS/live-HLS/fMP4 refusals. | Ready for Microsoft Edge Add-ons submission within the product boundary above. |
| Firefox Desktop 140+ | `smoke:firefox` temporarily installs `dist-firefox` into Firefox, opens the popup, checks `download-best` command registration, downloads direct MP4, remuxes plain HLS VOD, and checks DASH/encrypted-HLS/live-HLS/fMP4 refusals. | Ready for AMO review within the product boundary above after `web-ext lint` and source/build notes are included with the upload. |

Chrome passing is not Edge or Firefox evidence. Firefox fixture-only Playwright
tests are not extension runtime evidence; only `smoke:firefox` counts for
Firefox runtime support.

## Permission Justification

| Manifest item | Used for | Store justification |
| --- | --- | --- |
| `downloads` | Save the final verified direct file or locally remuxed HLS output after a user action. | Required for the extension's single purpose. |
| `tabs` | Identify the active tab, list descriptors for that tab, and send content-discovery messages. | Required to attach detections to the correct tab and popup. |
| `webRequest` | Observe candidate media entry requests without monkey-patching page network APIs. | Required to detect browser-visible direct media and manifests accurately. |
| `host_permissions: <all_urls>` | Fetch candidate headers, first bytes, manifests, and HLS segments from the same sites the user is visiting. | Required because supported media may be hosted on arbitrary first-party or CDN origins. |
| `offscreen` | Chromium only: run the HLS engine in an offscreen document and create Blob URLs for the final MP4. | Required because Chromium MV3 service workers cannot own the DOM/Blob URL path used by the HLS engine. Removed from the Firefox build. |
| `commands.download-best` | Register `Alt+S` for the highest-quality supported candidate on the current tab. | User-initiated shortcut; does not broaden data access. |

Removed unused permissions during the store audit: `storage` and `scripting`.

## Store Listing Draft

Name: savemedia

Short description:

> Save verified direct video files and plain HLS VOD streams from pages you can
> already access.

Long description:

> savemedia is a narrow video-saving extension. It detects browser-visible
> video candidates, verifies that a candidate is a supported complete video, and
> saves only paths it can finish as one playable file.
>
> Supported: direct MP4, WebM, and MKV files verified by headers or bytes; plain
> HLS VOD with MPEG-TS segments remuxed locally to MP4.
>
> Refused: DASH, encrypted HLS, SAMPLE-AES, ClearKey/CENC, DRM-protected media,
> Widevine, PlayReady, FairPlay, live/DVR HLS, HLS fMP4/CMAF, orphan chunks,
> init segments, audio-only files, images, HTML/CSS/JS assets, unknown
> protocols, and URL-only guesses.
>
> savemedia does not bypass DRM, paywalls, login restrictions, geographic
> restrictions, expired signed URLs, protected streams, or website access
> controls. Use it only for media you have the right to save.

Category: Productivity or Accessibility/Tools, depending on the store taxonomy.

Privacy summary:

> Runs locally. No telemetry, ads, developer-operated server, data sale, or data
> broker sharing. Media URLs and headers are processed only in the browser to
> detect and save supported files.

Screenshot checklist:

- popup on a direct MP4 fixture with one detected item;
- popup on a plain HLS fixture with one detected item;
- refusal card for DASH or protected media;
- no screenshot should imply DRM, paywall, site-login bypass, or universal
  downloading.

## Reviewer And Build Notes

Build from source:

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm --filter @savemedia/extension smoke:firefox
pnpm --filter @savemedia/extension zip
```

Chrome package:

```sh
pnpm --filter @savemedia/extension build:chrome
```

Load `packages/extension/dist-chrome` as the unpacked extension or submit
`packages/extension/savemedia-chrome-0.0.1.zip`.

Firefox package:

```sh
pnpm --filter @savemedia/extension build:firefox
pnpm --filter @savemedia/extension lint:firefox
pnpm --filter @savemedia/extension smoke:firefox
```

Submit `packages/extension/savemedia-firefox-0.0.1.zip` plus the repository
source and these build commands to AMO because the extension is bundled with
Vite and reviewers need reproducible source instructions.

The Firefox build sets
`browser_specific_settings.gecko.data_collection_permissions.required` to
`["none"]` because savemedia does not collect or transmit personal data to the
developer or to a developer-operated service. The Firefox package requires
Firefox Desktop 140+ so AMO's built-in data-consent manifest key is supported.

Current `web-ext lint` warnings are React bundle `innerHTML` warnings in
`popup.js`; lint reports zero errors. Upload the source package and build notes
above so reviewers can inspect the React/Vite source behind the bundled popup.

Edge package and runtime smoke:

```sh
pnpm --filter @savemedia/extension smoke:edge
```

If Edge is not in a standard location, set:

```sh
SAVEMEDIA_EDGE_EXECUTABLE="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  pnpm --filter @savemedia/extension smoke:edge
```

The local verified Edge install was Microsoft Edge `148.0.3967.83`.

Manual Edge checklist if automation is unavailable in another environment:

```sh
pnpm --filter @savemedia/extension build:chrome
SAVEMEDIA_FIXTURE_PORT=5174 node packages/extension/tests/e2e/fixture-server.mjs
```

Then in Microsoft Edge:

1. Open `edge://extensions`, enable Developer mode, and load
   `packages/extension/dist-chrome` unpacked.
2. Visit `http://127.0.0.1:5174/page/direct.html`; the popup must show one
   direct MP4 candidate, and download must produce a playable MP4.
3. Visit `http://127.0.0.1:5174/page/hls.html`; the popup must show one HLS
   candidate, and download must produce a playable MP4.
4. Visit `dash.html`, `hls-aes.html`, `hls-live.html`, and `hls-fmp4.html`;
   each must show the matching refusal and must not write a media file.
5. `Alt+S` must invoke the registered best-download command on the active tab.

Record the Edge version, date, zip path, and result before changing the support
matrix.
