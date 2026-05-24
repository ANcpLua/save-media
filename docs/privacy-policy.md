# savemedia Privacy Policy

Effective date: 2026-05-23

savemedia is a browser extension that runs locally in the user's browser. It
detects browser-visible video candidates, lets the user choose a supported
candidate, and asks the browser to save the resulting file.

## Data Handled Locally

savemedia may process the following data inside the browser:

- page URLs for tabs where the extension is active;
- candidate media request URLs;
- response headers for candidate media requests;
- manifest text for candidate HLS or DASH manifests;
- the first bytes of candidate direct media files, used only to verify the
  container before offering a download;
- temporary in-memory descriptors and job progress for the current browser
  session.

This data is used only to provide the extension's single purpose: saving
verified direct video files and plain HLS VOD streams when the browser can fetch
every required byte and produce one playable final file.

## Data Sharing

savemedia does not send browsing activity, media URLs, headers, manifests,
download history, analytics, telemetry, or personal data to the developer or to
any developer-operated server. It does not sell data, use data for advertising,
or share data with data brokers.

When the user starts a download, the browser may request media bytes from the
original website or media host that the page already referenced. For plain HLS
VOD, savemedia fetches the playlist and segments from those original URLs in the
browser, then remuxes clear MPEG-TS segments or assembles validated clear
fMP4/CMAF fragments locally.

## Credentials, Protected Media, and Access Control

savemedia does not collect usernames, passwords, payment details, cookies, or
license keys. It does not bypass DRM, paywalls, login restrictions, geographic
restrictions, expired signed URLs, or protected streams. If the browser or the
server denies access, or if DRM/encryption/live/DASH/fMP4-CMAF paths are
detected outside the supported clear-HLS boundary, savemedia refuses the
download instead of attempting a workaround.

## Browser Store Limited Use Statement

savemedia's use of information received from browser extension APIs adheres to
the Chrome Web Store User Data Policy, including the Limited Use requirements.
The extension uses data only for its disclosed single purpose and does not
transfer, sell, or use user data for unrelated purposes.

## Contact

For review, privacy, support, or security questions, use the browser store
developer contact or the repository support guidance:

https://github.com/O-ANcppLua/save-media
