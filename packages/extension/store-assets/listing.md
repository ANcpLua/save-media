# Store listing

Kept in the repo so the published copy has a reviewed source, and so the rules
in `docs/boundary-rules.md` apply to the listing the same way they apply to the
code.

Two traps this text must keep avoiding:

- **R4, forbidden wording.** No "bypass", "unlock", or "circumvent", not even
  while saying the extension refuses to do it. The live AMO copy carried
  "paywalls, login bypass" in its *Not supported* line until 2026-09-12. The
  intent was right and the phrasing was exactly what the rule forbids.
- **Keyword spam.** The Chrome Web Store rejects bare runs of format names as
  keyword bait, and rejected Video Transcript for it in August. Formats belong
  in a sentence that says what they are for, never in a comma-separated row.

## Chrome and Edge description

Both dashboards take this text by hand, neither store has an API for listing
text. Entered in both on 2026-09-12 together with the corrected single purpose
statement and privacy policy URL (the URL had a typo in the account name).
Applied with the dashboards, not with a script.

savemedia saves the video you are watching as an MP4, WebM or MKV file in
your Downloads folder, when the browser already receives it unprotected. DRM,
encrypted streams, live streams and anything behind a paywall or sign-in are
refused, and it never leaves a half-downloaded file behind.

Press Alt+S to save the best supported video on the current page, or open the
popup to pick from everything detected. The popup shows for each item whether
savemedia can save it, and why not when it cannot.

Supported: direct MP4, WebM, and MKV files verified by headers or bytes; plain
HLS VOD with MPEG-TS segments remuxed locally to MP4; clear HLS fMP4/CMAF
streams assembled locally after MP4 box validation.

Not supported: encrypted HLS and DASH. When something cannot be saved, the
popup says so instead of writing a broken file.

Everything runs locally in the browser. No telemetry, ads, accounts, or
developer-operated server.

## Chrome and Edge summary

Video downloader for verified direct files and plain HLS streams.

## AMO description

savemedia saves the video you are watching as an MP4, WebM or MKV file in
your Downloads folder, when the browser already receives it unprotected. DRM,
encrypted streams, live streams and anything behind a paywall or sign-in are
refused, and it never leaves a half-downloaded file behind.

Supported: direct MP4, WebM, and MKV files; plain HLS VOD with MPEG-TS
segments; clear HLS fMP4/CMAF streams.

Not supported: encrypted HLS and DASH. When something cannot be saved, the
popup says so instead of writing a broken file.

Everything runs locally in the browser. No telemetry, ads, accounts, or
developer-operated server.

## AMO summary

Save verified direct video files and plain HLS streams.
