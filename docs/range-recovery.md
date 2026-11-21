# Direct file discovery and recovery

SaveMedia looks at the page's media elements and ordinary browser requests.
A successful media response can reveal a file even when its URL has no
extension. When the browser follows a redirect to the file, SaveMedia keeps
the entry URL and remembers the observed destination for deduplication. A
save starts from the entry again so the site's own redirect can choose the
current destination. Query strings and numeric paths can identify different
files. Only explicit redirect evidence joins distinct URLs. The extension
uses the browser's normal access and network settings.

Discovery reads at most the first 4 KiB of a candidate and looks for a
supported container or playlist. Successful status codes, filenames, and
MIME types alone can also come from warning pages and status responses.
A direct-file row uses the filename from the verified response's
`Content-Disposition`, a file heading on a single-video page, or the media path.
An empty attachment filename counts as missing. When a page names a file
and its player is still initializing, discovery allows up to four seconds
for the page to supply a source. The popup shows the reason when discovery
fails and **Check page again** probes the current sources. Navigation cancels
probes from the previous page.

When a page names a file and exposes one Download control near its heading,
SaveMedia can use that control if the player supplies no usable source. The popup and
Alt+S run the site's own handler at save time, when it can generate a fresh
address. Chromium can read the same control on a linked download page in a
sandboxed frame. The extension passes the resulting navigation address to
the direct-file verifier and keeps the original tab open. Chrome follows the
HTTP redirects and applies its usual certificate checks.

Overlapping saves of a named file in the same tab share its link lookup.
Once the transfer starts, another click or shortcut on that file joins the
active job even if the site rotates its URL. After completion the user can
explicitly save another copy.

If Chrome reports a certificate rejection while probing a generated link,
SaveMedia asks the same named file's Download control for another link once.
It can probe an HTTPS destination with a different host and the same file
path and parameters, allowing the site's expiring signature to change.
The replacement goes through the normal certificate and media checks.

Both the popup and Alt+S use the same download job. A range response with a
strong ETag or Last-Modified selects four concurrent workers reading 4 MiB
chunks. Each chunk uses `If-Range` and checks its offsets, byte count, and
validator. Network errors and truncated chunks get bounded retries.
A server that serves a full response can instead be read as one stream.
Both paths enforce the browser's 2 GiB output limit, including when the server
omits a length. Cancellation discards the in-memory result.

If a freshly generated link with an expiring signature already returns HTTP
403 during its first probe, SaveMedia asks the same Download control for a
fresh link once. It requires the same resource path and file parameters.
If a previously verified direct URL returns HTTP 403 during a save,
SaveMedia can also retry once. A stable entry URL follows the site's redirect
again. For a single named file with an expiring URL, the extension lets
Chrome open the same file page in a temporary background tab. It retries
only when that page exposes one fresh address for the same resource path
and file parameters, with the same filename, container and byte count.
The original tab carries on and Chrome closes the temporary tab. The
extension relies on Chrome's ordinary session, resolver and TLS checks.

MP4 and QuickTime verification walks the top-level boxes and requires movie
metadata and media data. Modern QuickTime uses the `qt  ` file type. Legacy
QuickTime can use the same atom structure without a file-type box. WebM and
Matroska checks recognize the EBML header. These checks establish container
structure and check available lengths. They do not decode every frame.
See [Apple's QuickTime movie file specification](https://developer.apple.com/documentation/quicktime-file-format/quicktime_movie_files).

Only verified bytes reach the browser's download manager. SaveMedia waits
for the browser to report completion before showing **Saved** and releases
the temporary Blob URL after success or failure. Direct saves keep the
original filename and use the browser's normal conflict handling. Different
movies can have the same duration and similar thumbnail frames, so the
extension leaves existing downloads on disk.

## When the file page loads and the media request fails

The page and the video can use different hosts. When the browser supplies
a diagnostic during discovery, the popup shows a short reason such as
**Secure connection failed** and puts the host and browser error under **Technical
details**. Alt+S shows the short reason if no save can start. Available
downloads appear above the collapsed **Unavailable sources** section.

A failed save on a named file page stays visible next to the file when the
popup reopens, including after an Alt+S attempt. The tab holds the result
until a new save or page load. The named file row shows the reason and a
retry button.

Chrome uses its configured resolver for both the page and the extension's
requests. Chrome's Secure DNS setting can select an encrypted resolver on
devices where the browser permits that choice. The media request still
validates TLS for the original hostname. See [Chrome's Secure DNS documentation](https://support.google.com/chrome/answer/10468685).

The certificate error describes the connection the browser made. Two
resolvers can return different addresses for the same hostname, and those
addresses can present different certificates. To investigate a report,
compare the connected addresses and TLS verification results for the same
hostname from the same machine. The host root is sufficient for that check.
Keep signed links out of diagnostic reports.

## Verify locally

Install the workspace dependencies, Playwright Chromium and `ffprobe` to run
the focused check.

```sh
bun install --frozen-lockfile
(cd packages/extension && bunx playwright install chromium)
bun run build
bun run --filter @savemedia/extension test:e2e:chromium tests/e2e/classification.spec.ts -g 'site-generated download links|reports certificate failures'
bun run --filter @savemedia/extension test:e2e:chromium tests/e2e/classification.spec.ts -g 'after source rotation'
```

The redirect check opens a named file page with an unavailable player source.
It uses the popup to resolve the linked download page and renew its first
expired address, then Alt+S on a second page. The check compares both output
filenames and every byte. The certificate fixture checks that a named file's
save failure remains visible when the popup reopens.

The source-rotation check saves two distinct local movies in one tab using the popup
and then Alt+S. The first source appears after the popup opens and expires
after discovery. The second source changes its redirect destination. The
test checks the original filename, bytes and video track on disk. Separate failure
cases return HTML or a 69-byte JSON response during saving and check for
visible feedback and an empty download list. The movies come from FFmpeg's
test pattern and color bars with a generated tone. The color bars fixture's
first atom is tagged as free space to exercise legacy QuickTime while
keeping all offsets intact. The HTTPS fixture covers range recovery and retries.
The connection failure test uses an untrusted loopback certificate and an
HTTP 451 response. Both the popup and Alt+S report the failure, and Chromium
records zero downloads. The certificate check remains active in that test.

The range and top-level box checks were adapted from
`internal/rescue/downloader.go` and `internal/rescue/validate.go` in Video
Rescue at commit `09e855aa8172e7b83488e134a562f40bd197879d`. The MIT notice
is bundled at `packages/extension/public/licenses/video-rescue-MIT.txt`.
