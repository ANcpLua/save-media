# Store listing

Kept in the repo so the published copy has a reviewed source, and so the
policy in `docs/boundary-rules.md` applies to the listing the same way it
applies to the code.

Three traps this text must keep avoiding:

- **Forbidden wording.** The three words `store-publish lint` rejects (see
  `DEFAULT_FORBIDDEN` in the tool) must not appear, not even while saying the
  extension does not do it. An earlier AMO copy carried one of them in its
  *Not supported* line until 2026-09-12.
- **Keyword spam.** The Chrome Web Store rejects bare runs of format names as
  keyword bait. Formats belong in a sentence that says what they are for,
  never in a comma-separated row.
- **Claim only what a test covers.** Every capability sentence below maps to
  an end-to-end test in `packages/extension/tests/e2e` that saves the fixture
  and lets `ffprobe` read the result. No "any site" and no "all videos".

The text says what the extension does. It names no site and no brand.

## Chrome and Edge description

Both dashboards take this text by hand: neither store has an API for listing
text. Paste it into both when it changes.

savemedia saves the videos and images your browser receives while you watch
and browse, when they are not DRM encrypted. Every file savemedia downloads
itself is checked before it reaches your Downloads folder, so web pages and
broken files are not saved as video. When your browser already holds an
interrupted download of the same file, savemedia lets the browser finish it.
savemedia cannot read that file, so its content is not checked.

Press Alt+S to save the video or image under the pointer, or the page's main
video. Open the popup to see what the page offers, with quality and expected
size. When something can't be saved, savemedia explains why in plain words.

It saves direct video files, HLS streams and DASH streams with separate video
and audio, joined into one MP4 file. Standard HLS AES-128 encryption is
decrypted with the key the player receives. Not supported: live streams and
DRM-protected media.

An optional Local downloader can hand a page to yt-dlp and ffmpeg that you
install yourself. They make their own requests and write their own file.

Everything else runs in your browser. No account, no ads, no telemetry, no
developer server. Save only what you have the right to keep.

## Chrome and Edge summary

Saves videos and images that are not DRM encrypted, and checks each file it downloads itself before it reaches Downloads.

## AMO description

savemedia saves the videos and images your browser receives while you watch
and browse, when they are not DRM encrypted. Every file savemedia downloads
itself is checked before it reaches your Downloads folder.

Press Alt+S to save the video or image under the pointer, or the page's main
video. The popup shows what the page offers, with quality and expected size,
and explains in plain words when something can't be saved.

It saves direct video files, HLS streams and DASH streams with separate video
and audio, joined into one MP4 file. Standard HLS AES-128 encryption is
decrypted with the key the player receives. Not supported: live streams and
DRM-protected media.

An optional Local downloader can hand a page to yt-dlp and ffmpeg that you
install yourself. They make their own requests and write their own file.

Everything else runs in your browser. No account, no ads, no telemetry, no
developer server. Save only what you have the right to keep.

## AMO summary

Saves videos and images that are not DRM encrypted, and checks each file it downloads itself before it reaches Downloads.
