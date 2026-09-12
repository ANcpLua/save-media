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

Both dashboards take this text by hand: neither store has an API for listing
text. Chrome Web Store: developer dashboard, Store listing tab. Edge: Partner
Center, Store listings, English. Applied to both on 2026-09-12; both
submissions are in review. The same day the single purpose statement and the
privacy policy URL in both dashboards were corrected as well (the URL had a
typo in the account name and was dead).

savemedia saves browser-visible video when it can verify and finish one
playable file.

Press Alt+S to save the best supported video on the current page, or open the
popup to pick from everything detected. The popup shows for each item whether
savemedia can save it, and why not when it cannot.

Supported: direct MP4, WebM, and MKV files verified by headers or bytes; plain
HLS VOD with MPEG-TS segments remuxed locally to MP4; clear HLS fMP4/CMAF
streams assembled locally after MP4 box validation.

Refused: DRM, encrypted HLS, DASH, live streams, and anything that is only
reachable behind a paywall or a sign-in. savemedia saves what the browser has
already received in the clear, and refuses rather than write a broken file.

Everything runs locally in the browser. No telemetry, ads, accounts, or
developer-operated server.

## Chrome and Edge summary

Video downloader for verified direct files and plain HLS streams.

## AMO description

savemedia saves browser-visible video when it can verify and finish one
playable file.

Supported: direct MP4, WebM, and MKV files; plain HLS VOD with MPEG-TS
segments; clear HLS fMP4/CMAF streams.

Refused: DRM, encrypted HLS, DASH, live streams, and anything that is only
reachable behind a paywall or a sign-in. savemedia saves what the browser has
already received in the clear, and refuses rather than write a broken file.

Everything runs locally in the browser. No telemetry, ads, accounts, or
developer-operated server.

## AMO summary

Save verified direct video files and plain HLS streams.
