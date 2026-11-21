# savemedia Privacy Policy

Effective date: 2026-11-21

savemedia is a browser extension that runs locally on the user's computer. It
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
verified direct video files and unprotected HLS and DASH streams when the
browser can fetch every required byte and produce one playable final file.
AES-128 HLS is decrypted locally with the browser's own WebCrypto, and only
when the server hands the key to the page in the clear; the key is used in
memory for that download and is never stored or transmitted.

## Repeat downloads

After the browser confirms a SaveMedia download, the extension keeps a local
fingerprint for the rest of that browser session. It uses this fingerprint to
ask before saving another copy. The receipt contains a hash and a success
flag. Closing the browser or reloading the extension clears it. SaveMedia
checks the status of its own download by ID. Duplicate detection requires
no folder scan, cookies or access to other downloads.

After a temporary transfer failure, SaveMedia can hold completed parts of one
file in browser memory for up to ten minutes so a retry can resume. Reloading
the extension or closing the browser clears these parts.

## Optional Local Downloader

The extension includes an optional feature that is off by default. When the
user switches it on, the browser asks for the `nativeMessaging` permission and
the extension may pass the current page URL and the user's quality preference
to a separate program the user installed on their own computer
(`packages/native-host`). That program runs the user's own copies of yt-dlp and
ffmpeg and writes files to the user's Downloads folder. This download mode sends the page address and selected settings. The program
may, at the user's explicit setting, read the browser's cookie store locally to
act with the user's own session; those cookies never leave the user's computer
and are never logged.

### Optional local connection

**Use local connection** enables a separate recovery option for file saves.
The standard extension requests Chrome’s native messaging permission when
this option is selected. The dedicated desktop preview declares it at install
time. Both require the user to enable the local connection before using it.
When a media connection fails, the extension can send the publisher-issued
HTTPS file address, the referring page’s origin and byte-range information to
that helper on the same computer. The address may include a temporary download
token. The helper sends the file hostname to Cloudflare’s DNS-over-HTTPS resolver.
It connects directly to the publisher’s server, verifies its TLS certificate and
returns bytes to Chrome for verification and saving. File contents and signed
links are kept out of DNS queries and diagnostic logs. This mode uses no browser
cookies and saves no list of file addresses. Turn it off in **Local downloader**.

The `storage` permission holds these local settings and the browser-session download receipts described above.

The `declarativeNetRequestWithHostAccess` permission lets the extension's own
requests for a detected video carry the page's origin as Referer, as the
browser does by default when the page loads that video. Many video servers
refuse requests without it. The rule applies only to requests the extension
itself makes, never to the user's own browsing, and ends with the browser
session.

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
license keys. A site’s own download control can issue a fresh link when its
previous link expires. The extension respects server access restrictions,
including sign-in, payment and geographic restrictions. If DRM, a key held by a protected media module, a
live or still-growing presentation, or DASH addressed by byte ranges is
detected, savemedia refuses the download instead of attempting a workaround.

## Browser Store Limited Use Statement

savemedia's use of information received from browser extension APIs adheres to
the Chrome Web Store User Data Policy, including the Limited Use requirements.
The extension uses data only for its disclosed single purpose and does not
transfer, sell, or use user data for unrelated purposes.

## Contact

For review, privacy, support, or security questions, use the browser store
developer contact or the repository support guidance:

https://github.com/ANcpLua/save-media
