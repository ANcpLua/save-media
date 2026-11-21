# Direct file discovery and recovery

SaveMedia looks at the page's media elements and ordinary browser requests.
A successful media response can reveal a file even when its URL has no
extension. When the browser follows a redirect to the file, SaveMedia keeps
the entry URL and remembers the observed destination for deduplication. A
save starts from the entry again so the site's own redirect can choose the
current destination. Query strings and numeric paths can identify different
files. Only explicit redirect evidence joins distinct URLs. Initial discovery uses the browser's normal access and network settings.

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

A visible HTML download link can carry the original name even when the
server address has no filename. A file collection keeps each named link
separate. A named page with an explicit original link prefers that link to a
player preview. When a page names a file and exposes one Download control near its heading,
SaveMedia prefers the publisher’s original-file control to a player preview. The popup and
Alt+S run the site's own handler at save time, when it can generate a fresh
address. A normal link is probed after its redirects. A media response goes to the verifier. On Chromium, an HTML response can lead to a download control in a sandboxed frame at the final document address. The extension passes the resulting navigation address to
the direct-file verifier and keeps the original tab open. Chrome follows the
HTTP redirects and applies its usual certificate checks.

Overlapping saves of a named file in the same tab share its link lookup.
Once the transfer starts, another click or shortcut on that file joins the
active job even if the site rotates its URL. After completion the user can
explicitly save another copy.

If Chrome rejects a certificate while probing a generated link, SaveMedia
automatically runs the site's Download control in the background. It tries
a matching HTTPS link to a different host, or follows an entry that
previously redirected to the rejected host so the site can choose a new
destination. A repeated failed route, an unrelated file, or three link
renewals ends automatic recovery. A signed link returning HTTP 403 can also
be renewed. Explicit login, payment and HTTP 451 responses end the attempt.

After a temporary range failure, the engine can keep the completed parts of
one file in memory for up to ten minutes. This applies to direct file
transfers up to 256 MiB. Retry in the same tab. The engine probes again and
reuses parts only when the resource, exact length and strong ETag match.
A changed file starts from byte zero. The saved output still undergoes the
normal container and length checks. Reloading the extension releases the parts.
To reproduce a late HTTP 503 and a changed ETag with owned bytes, run
`bun x vitest run tests/unit/engine/jobs/direct.test.ts -t 'late 503'`
from `packages/extension`.

Chrome writes the verified file under the original name and confirms the save.
The popup shows connection, transfer, verification and disk-write stages.
The transfer bar uses bytes held from the current attempts. Retried ranges
discard their partial counts. An unknown total shows bytes received and an
indeterminate bar. Closing the popup leaves the job running. Reopening it
reads the background job state. The pinned icon on the file tab shows a
small filled bar for measured progress and a dotted strip for an unknown
total or a preparation step. Retrying uses amber. Hover over the icon to
read the stage. The original icon returns when the last save on that tab ends.

SaveMedia records a hashed file identity in browser-session storage only
after Chrome reports completion. The named file page identifies a file across
link renewal. For other media, the source and rendition
identify the selection. Repeating Download or Alt+S asks for confirmation.
The answer applies to one save. The existing Downloads file may have been
moved or deleted since the first save.

Both the popup and Alt+S use the same download job. If the server sends a whole file in response to the range probe, the job streams that response through verification and saves it. A server that declines range requests can serve the file with a regular GET. A range response with a
strong ETag or Last-Modified selects four concurrent workers reading 4 MiB
chunks. After a 429 or 503, outstanding parts finish and one worker requests the remaining parts. Each chunk uses `If-Range` and checks its offsets, byte count, and
validator. Network errors and truncated chunks get bounded retries.
Transient HTTP responses use exponential backoff. A Retry-After of up to 30
seconds sets the minimum wait. A longer wait ends the attempt and lets the
user come back later.
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
The original tab carries on and Chrome closes the temporary tab. This
direct retry uses Chrome's ordinary session, resolver and TLS checks.

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
downloads on multi-source pages appear above the collapsed **Unavailable
sources** section. A named file page shows the current save state in its
own row. A rejected discovery route disappears when the transfer starts.

A failed save on a named file page stays visible next to the file when the
popup reopens, including after an Alt+S attempt. The tab holds the result
until a new save or page load. The named file row shows the reason and a
retry button.

Chrome uses its configured resolver for the page and direct requests.
Chrome's Secure DNS setting can select an encrypted resolver on
devices where the browser permits that choice. The media request still
validates TLS for the original hostname. See [Chrome's Secure DNS documentation](https://support.google.com/chrome/answer/10468685).

The certificate error describes the connection the browser made. Two
resolvers can return different addresses for the same hostname, and those
addresses can present different certificates. To investigate a report,
compare the connected addresses and TLS verification results for the same
hostname from the same machine. The host root is sufficient for that check.
Keep signed links out of diagnostic reports.

## Optional desktop connection

On a Mac with the SaveMedia native host installed, **Use local connection**
grants Chrome’s native messaging permission and checks the host’s file-reading
capability. The setting applies to both **Save** and **Alt+S**. The extension
continues to use normal Chrome networking during page observation. During an
explicit save, a failed HTTPS connection may be retried through the installed
host. Chrome can also return a successful response whose final URL is HTTP.
SaveMedia discards that body and asks the enabled host for the original HTTPS
URL with the same range and validator. If the host also receives a redirect to
HTTP, it stops before requesting that destination. The host resolves each
public destination using verified DNS over HTTPS
and opens a direct TLS connection for the original hostname, including on
redirects. It supplies a bounded response stream to the same media verifier.
HTTP access refusals and protected keys keep their original behavior. The helper
requires system curl for this route. It does not require yt-dlp or ffmpeg.
The local opt-in is independent of the yt-dlp download setting. See
[the native host protocol](../packages/native-host/README.md).

## Verify locally

To reproduce the movable Chrome preview, run
`bun run --filter @savemedia/extension build:preview` after building core.
Load `packages/extension/dist-preview` in Chrome. The public key in
`manifest.preview.json` keeps the preview ID
`bcccjfmdffhkejbogpedfpbgolgglnok` when the folder moves. The store build
has its own identity and requests native messaging at first use. The dedicated
desktop preview declares that permission at installation. Its local file
connection stays off until the user chooses **Use local connection**.
Register the preview ID with the native host for a desktop-connection check. Use a temporary Chrome profile for automation.
On a connection that rejects the file host, click **Save**, then **Use local
connection**. In the standard build, accept Chrome’s permission prompt. Run **Alt+S** on the same
file, confirm the additional copy, and compare each on-disk file to a known
original. The local connection setting starts off in each new profile.

For a Chrome preview, run `bun run build` at the repository root and load
`packages/extension/dist-chrome` using **Load unpacked**. Subsequent builds
use the same directory. Use **Reload** on that extension and refresh the file
page to activate the new page scripts. Check a reported connection failure
with the same Chrome profile and network settings as the original report.
A save in a browser using a different resolver verifies that route only.

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
