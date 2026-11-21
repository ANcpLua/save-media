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
`Content-Disposition`, a file heading on a single-video page, or the media path. The popup shows the
reason when discovery fails and **Check page again** probes the current
sources. Navigation cancels probes from the previous page.

Both the popup and Alt+S use the same download job. A range response with a
strong ETag or Last-Modified selects four concurrent workers reading 4 MiB
chunks. Each chunk uses `If-Range` and checks its offsets, byte count, and
validator. Network errors and truncated chunks get bounded retries.
A server that serves a full response can instead be read as one stream.
Both paths enforce the browser's 2 GiB output limit, including when the server
omits a length. Cancellation discards the in-memory result.

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
**Untrusted source** and puts the host and browser error under **Technical
details**. Alt+S shows the short reason if no save can start. Available
downloads appear above the collapsed **Unavailable sources** section.
The browser's error event is used for display only.

Support can diagnose the media host on the same network with TLS verification
enabled. A certificate issued by a DNS filter's block-page service means the
request reached that service. The network operator can review a suspected
false positive. SaveMedia needs a verified response from the media host
before it can offer the file. See [Whalebone's resolver troubleshooting](https://docs.whalebone.io/en/immunity/domain_resolution_analysis.html).

## Verify locally

Install the workspace dependencies, Playwright Chromium, `ffprobe` and
`openssl` to run the focused checks.

```sh
bun install --frozen-lockfile
(cd packages/extension && bunx playwright install chromium)
bun run build
bun run --filter @savemedia/extension test:e2e:chromium -g 'original MOV files|during a MOV save|range-only|untrusted and restricted'
```

The Chromium test saves two distinct local movies in one tab using the popup
and then Alt+S. It changes each media destination after discovery and checks
the original filename, bytes, and video track on disk. The separate failure
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
