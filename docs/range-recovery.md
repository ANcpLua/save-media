# Direct file discovery and recovery

savemedia looks at the page's media elements and ordinary browser requests.
A successful media response can reveal a file even when its URL has no
extension. When the browser follows a redirect to the file, savemedia keeps
the entry URL and remembers the observed destination for deduplication. A
save starts from the entry again so the site's own redirect can choose the
current destination. Query strings and numeric paths can identify different
files. Only explicit redirect evidence joins distinct URLs. Initial discovery uses the browser's normal access and network settings.

Discovery reads at most the first 4 KiB of a candidate and looks for a
supported container or playlist. Successful status codes, filenames, and
MIME types alone can also come from warning pages and status responses.
The media observer starts on the document as it is being created. Before
playback, the popup and Alt+S read what the page declares in its own data: a
video's attributes, JSON in attributes and script tags, schema.org and Open
Graph metadata, and file links. A value counts by what it is, an address
with a media name or next to a media type, never by the name of the key that
holds it, and every candidate is probed before it is offered. Every frame of
the tab reports its own players and declarations, and one selector in the
background decides which video is the page's main one. Scanning only reads:
it never starts, pauses or seeks a player. A player that publishes its first
address in response to Play becomes detectable when the address appears.
A direct-file row uses the filename from the verified response's
`Content-Disposition`, a file heading on a single-video page, or the media path.
An empty attachment filename counts as missing. Nothing waits on a clock for
a page to supply a source. When a player has no source yet, the popup and
Alt+S say so at once: "The page has not loaded the video yet. Start
playback, then try again." The popup shows the reason when discovery fails
and **Check page again** probes the current sources again. A save checks a
source that failed before only where that can change what is saved: when
nothing is ready, or when the failed source is listed next to the player's
own address as another quality. A player whose stream is already captured is
saved at once, and a stale address in its page data waits for **Check page
again**. Before the first check of a press is sent, the Alt+S toast says
"Checking". Navigation cancels probes from the previous page.

A visible HTML download link can carry the original name even when the
server address has no filename. A link counts when the page declares it in
its markup with a `download` attribute or a `video/*` type. On a page that
names a file, a plain link whose path ends in that same file name also
counts. A transport stream name (`.ts`, `.m2ts`, `.mpegts`) is the
exception everywhere, because `.ts` also names source code: in a heading, in
a `download` attribute or in a link's path it counts only on a link that
states the type `video/mp2t` itself. So a page about `utils.ts` with a
download link to that file, or to an archive, offers no file, and a
transport stream file page whose link states no type is not offered until
the browser loads the file. The link's text never matters. A file collection keeps each named
link separate. A named page with an explicit original link prefers that link
to a player preview. When a page names a file and lays out one link for it,
or exactly one in the section of the heading that names it, the popup and
Alt+S save that link under the page's name. A copy of the link that the page
does not lay out, such as one in a collapsed menu, does not compete. The link
is probed after its redirects, and only a response whose first bytes are a
video container goes to the verifier. The file name in the path is never
trusted alone. Chrome follows the HTTP redirects and applies its
usual certificate checks. savemedia never presses the site's buttons, runs
its download scripts, or loads the page in another tab or frame to obtain a
link. When a page names a file but links to none, the popup and Alt+S say:
"This file has not reached your browser yet. savemedia saves it once your
browser receives it." No text points at a site's own buttons.

Overlapping saves of a named file in the same tab share one start. Once the
transfer starts, another click or shortcut on that file joins the active job
even if the site rotates its URL. After completion the user can explicitly
save another copy.

A rejected certificate, an access refusal, or an HTTPS link that redirects
to plain HTTP ends the attempt, and the popup explains it, on a named file
page in the same words as on any other page. savemedia does not look for a
replacement link on its own.

The first bytes of every response decide what it is, before any length is
compared. A page or data document returned in place of the file, such as a
network warning page, is reported as what it is at once, whatever type or
length it declares. Nothing of it is kept and nothing is retried. Bytes are
kept for a resume only once they identify a media container.

When the server delivers less than it announced, the save continues only
through a byte range the server grants under the same file validator. When
the server refuses the range (HTTP 400, 416 or 501, wherever a range is asked
for) or cannot prove the file version, the save stops, keeps nothing, and the
popup says how much arrived of how much; Retry save starts from byte zero.
When the server stops early again, the save stops and keeps the identified
bytes, which Retry save can continue from, for example on a renewed link.
savemedia does not ask again in a loop. Only a network outage, where the
server gives no answer or the connection drops or stalls, waits and
reconnects while bytes are kept, also while a server replays the whole file.
The popup shows the wait. Closing the popup leaves the transfer running.
**Cancel** stops an active request or a pending reconnect. A partial HTTP 200
body and completed or partial ranges can all supply a checkpoint.

Within one job, a reconnect continues at the address and under the validator
that job read the held bytes from, including the destination of a redirect
and a Last-Modified date, without reading or comparing those bytes again.
Only a later job, Retry save, checks kept bytes against the server.

Reconnects after an outage back off for 1, 2, 4, 8 and 16 seconds. A longer
permitted `Retry-After` sets the minimum wait. The delay resets after 64 KiB
of new data have accumulated, or one fifth of the remaining bytes if that is
smaller. Five reconnects without that much progress end the automatic
attempt. An active job can resume up to the browser's output limit.
After a failed job, **Retry save** can reuse one interrupted file of up to
256 MiB for ten minutes in the same tab, and the popup shows the time left.
The engine keeps one such file. A running save holds its own bytes and never
takes another save's; a later failure that keeps bytes takes the place, and
the earlier save's popup stops offering them.
For a named file the publisher page and filename
identify the checkpoint even when the page's link points to another
server. savemedia verifies the saved prefix against the new resource or
checks a whole-file checksum before publishing the file. When the server
cannot continue from the kept bytes, Retry save starts the file again from
byte zero. Kept bytes that turn out not to belong to the current file,
because they differ from it, because the assembled file fails its checksum or
because it fails the container check, are dropped and the file is read once
more from byte zero. A second failure ends the save.
The completed file goes through the normal container check.
Reloading the extension releases the retained bytes. The engine document
closes when no save is running and no bytes are kept, and opens again for the
next save.
To reproduce a late HTTP 503 and a changed ETag with owned bytes, run
`bun x vitest run tests/unit/engine/jobs/direct.test.ts -t 'late 503'`
from `packages/extension`.

Chrome writes the verified file under the original name and confirms the save.
The popup shows connection, transfer, verification and disk-write stages.
The transfer bar counts the bytes held across attempts. An unknown total shows bytes received and an
indeterminate bar. Closing the popup leaves the job running. Reopening it
reads the background job state. The pinned icon on the file tab shows a
small filled bar for measured progress and a dotted strip for an unknown
total or a preparation step. Retrying uses amber. Hover over the icon to
read the stage. The original icon returns when the last save on that tab ends.

savemedia records a hashed file identity in browser-session storage only
after Chrome reports completion. The named file page and filename identify a
file even when its link changes. A direct file is identified by its origin,
path, declared length and strong ETag or Last-Modified date, so a renewed
signature on the same file keeps its identity. Query parameters are never
interpreted. For other media, the source and rendition identify the selection.
**Save another copy** in the popup saves at once: the click is the answer.
Alt+S on a file that was already saved asks once, in the popup, and saves
nothing by itself; while the question is open, the same press shows it again.
The answer applies to one save. The existing Downloads file may have been
moved or deleted since the first save.

**Cancel** is a neutral end. The card goes back to **Save** and shows
"Cancelled"; no error is recorded and nothing is offered for retry.

Both the popup and Alt+S use the same download job. If the server sends a whole file in response to the range probe, the job streams that response through verification and saves it. A server that declines range requests can serve the file with a regular GET. A range response with a
strong ETag or Last-Modified selects four concurrent workers reading 4 MiB
chunks. After a 429, a 503, or a connection retry with bytes already in hand,
outstanding parts finish and one worker requests the next parts. Each part
that started after that drop and completes adds a worker back, up to four;
parts that were already running when the server got busy add none.
Each versioned chunk uses `If-Range` and checks its offsets, byte count, and
validator. When a server caps a range, the worker requests the remaining
bytes from the next verified offset. If the length headers conflict, a
smaller declared length can guide a fresh request at the same offset.
The worker discards the conflicting response. An invalid length or one
larger than the requested span gets one retry at the same offset. If
that mismatch persists, savemedia requests the whole file. A complete-file
response that reuses no earlier byte is judged on what it states itself, its
length or a Content-Range covering the whole file, and its first bytes are
identified before any length is compared. Under the same validator its byte
count must match the original total; under a newer one it is the current
file.
If a file response breaks after delivering bytes, a known length and file
version let savemedia request the missing suffix over one connection.
If a matching HTTP 206 response breaks before delivering any bytes or
declares `Content-Length: 0` for a nonempty range, savemedia
requests up to 64 KiB at the same offset using the same file validator. Once
it receives those bytes, the next request uses the normal range size. Two
empty bodies at the same offset end the save, and the popup reports the
missing range. A fresh transfer with no saved bytes can still request a
complete response.
If the first response omitted the version, savemedia requests the first
missing byte. When that response identifies the file, savemedia checks
the entire saved prefix against that version. When it does not, the save
stops. For files up to 256 MiB a publisher’s SHA-256 `Repr-Digest` verifies
the entire assembled file, and any complete response that states one.
If the server replies to the range with a complete HTTP 200 body, savemedia
reads that response in place. Under a different validator, the server's
answer to `If-Range` for a changed file, it is the current file: the held
bytes are dropped and the response is saved. If the replacement also stops
early because the server ends it, the save stops and keeps the longer
matching prefix; a dropped connection counts as an outage. A shorter response
leaves the checkpoint in place.

The popup names each stage in plain words: checking the file, downloading,
trying again, resuming, checking the part saved earlier, checking the
finished file. A wait counts down. A failure says what happened and what to
do, and both lines are always visible. The status code, the byte counts, the
host and the error code appear under **Technical details**, one labelled row
each. The engine reports stages and reasons as data, never as text, and they
contain no signed URLs or validator values. The texts are written in
`packages/core/src/errors/messages.ts`, `packages/core/src/errors/network-block.ts` and
`packages/extension/src/util/transfer-progress.ts`.

When ranges keep losing their connection before any bytes are kept,
savemedia can make a separate complete-file request and verify it against the
known file.
Network errors and truncated chunks get bounded retries.
Transient HTTP responses use exponential backoff. A Retry-After of up to 30
seconds sets the minimum wait. A longer wait ends the attempt and lets the
user come back later.
A server that serves a full response can instead be read as one stream.
Both paths enforce the engine's 2 GiB output limit, including when the server
omits a length, and both fold the bytes into Blobs as they arrive, so the file
is never held whole in the engine's memory. Cancellation discards the result.

If a previously verified direct URL returns HTTP 403 during a save, the
save stops and the popup says so. Reloading the file page lets the site
issue its current link, which the next save uses. Direct saves use Chrome's
ordinary session, resolver and TLS checks.

MP4 and QuickTime verification walks the top-level boxes and requires movie
metadata and media data. Modern QuickTime uses the `qt  ` file type. Legacy
QuickTime can use the same atom structure without a file-type box. A movie
box that declares Common Encryption (a protected sample entry, a protection
scheme or a protection system box) ends the save as protected media; the same
check runs on the first bytes at detection and on HLS and DASH init segments.
WebM and Matroska checks recognize the EBML header. These checks establish container
structure and check available lengths. They do not decode every frame.
See [Apple's QuickTime movie file specification](https://developer.apple.com/documentation/quicktime-file-format/quicktime_movie_files).

Only verified bytes reach the browser's download manager from savemedia.
The one exception is the browser's own resume of an interrupted download
(below): savemedia cannot read that file and accepts it by the video type its
server declared, when the download began and again when it ends. A resume
that the server answers with a web page or other data is not kept: the file
is removed and the popup says what the server sent. savemedia waits
for the browser to report completion before showing **Saved** and releases
the temporary Blob URL after success or failure. Direct saves keep the
original filename and use the browser's normal conflict handling. Different
movies can have the same duration and similar thumbnail frames, so the
extension leaves existing downloads on disk.

## Diagnosing an interrupted save

An HTTP 206 response that supplies no usable bytes at the requested offset
produces `range_body_empty` after its confirmation request. Its details give
the range, the declared length, the last read outcome and the reconnect
count. A transfer the server answered but did not let finish produces
`transfer_failed` with a reason, such as `resume-refused`,
`resume-unverifiable`, `ended-early` or `file-changed`, and the byte counts.
No code alone establishes a provider policy.

Choose **Export diagnostic log** in the popup to save a timestamped JSON file
to Downloads. It includes this tab's discovery results, direct HTTP request
and response ranges, status, declared lengths, observed body byte counts,
job milestones and errors. A body event gives the reader's outcome. A
`range-rejected` event counts zero usable bytes because the response headers
failed validation before the body could be used.
The `source` field distinguishes a discovery probe from a transfer. Extension
HTTP elapsed time measures time to headers. For Chrome page-side body sizes
and timings, use the Network panel of Chrome DevTools on the media tab.
Export before navigating or reloading.

## When the file page loads and the media request fails

The page and the video can use different hosts. savemedia reads what the
browser reports about its own requests: the error code, the address of the
server that answered, and a redirect to another host
(`packages/extension/src/background/request-outcomes.ts`). The popup shows a
short reason such as **Secure connection not trusted**, what the user can
check, and puts the host, the address, the redirect and the browser's error
code under **Technical details**. Alt+S shows the reason and the hint if no
save can start. Available downloads on multi-source pages appear above the
collapsed **Unavailable sources** section. A named file page shows the
current save state in its own row. A rejected discovery route disappears when
the transfer starts.

## When the network blocks a server

A network filter, a parental control or a provider can keep the browser from
a media server. savemedia explains what the browser reported and stops. It
never reaches the server another way: it has no resolver of its own, changes
no proxy and skips no certificate check
(`packages/extension/tests/unit/policy/no-bypass.test.ts` fails on any of
those in the source). `networkBlock` in
`packages/core/src/errors/network-block.ts` decides the explanation, first
match first:

1. A request savemedia cancelled itself explains nothing.
2. A public host name answered from a local address (loopback, private,
   link-local, unique local), together with a browser error or a web page as
   the answer: "Blocked or redirected by your network". Addresses of
   carrier-grade NAT and of local proxies never count, and a plain refusal by
   HTTP status never does. Names that are not public, such as `.local`,
   `.test` or a bare host name, never count either. Where the browser
   reached the tab's own page under a public name at a local address (an
   intranet page, or any page behind a proxy inside the network), the
   address it reports is left out of the failure, so this rule never
   applies: the address would be the proxy's.
3. A certificate the browser refused: not trusted, for another name, outside
   its dates, or another certificate error. A secure connection that could
   not be set up is named separately.
4. A name that was not found, or a failed name lookup.
5. Offline, a proxy that could not connect, a browser policy, another
   extension, or a firewall on this computer.
6. A redirect to another host that answered with a web page.
7. Any other connection failure (refused, reset, timed out, a changed
   network) and a code savemedia does not know name no block. The failure
   keeps its own text, such as "The connection was lost" with what arrived
   before the drop, and the browser's code is a row under **Technical
   details**.

The browser's error codes choose wording only. They never change a request
or a retry. The address is shown on the device under **Technical details**;
the diagnostic export carries only its kind (`loopback`, `private`, `public`
and so on) and whether a redirect led elsewhere.

One limit: a page on the internet cannot make savemedia request a server
inside the user's local network that the browser itself has not loaded from
for that page. When the browser itself was answered from that server (the
same scheme, host and port) at a local address in the tab, what it received
is checked and saved like any other media. The browser's answer for the page
itself and for its frames counts too: a file that a page under an intranet
name offers on its own server is saved without playback. An address that only
names such a server is not requested. A public name that turns out to lead there is known
only from the address the browser reports for savemedia's one request; its
answer is not used, and the text says so and offers no retry. Both are listed
under **Unavailable sources** with the reason, and the first with the hint to
start playback on the page.

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
open **Technical details** on the failure: it shows the server's name and the
browser's error code. Chrome reports no server address for a connection whose
certificate it refused, so the Address row is missing there unless a redirect
on the way reported one. Look the hostname up from the same machine to see
which address the network gives it. The message itself names both usual
causes, a network filter that sends the server to its own block page and
software that inspects secure connections, and points at the filter and at
the browser's secure DNS setting. Keep signed links out of diagnostic
reports.

## Interrupted Chrome downloads

On a named file page, Save and Alt+S check for a matching interrupted Chrome
download with a positive byte count. A download matches when it came from
the page's declared link, or when it has the file's name and was started from
this page. When Chrome can resume it, savemedia asks Chrome to continue that
download and shows its progress. Otherwise the ordinary save starts.

A direct-file resume makes byte-range requests. An HLS save uses the
browser's HTTP cache when the publisher allows it, and requests the playlist,
its AES-128 key and its segments the way the page's player does: with the
user's cookies and the page's Referer. If a segment body drops mid-transfer,
the running job retries that segment and keeps the resolved playlist and
preceding segments. After an outage (no answer, a stalled connection or a
busy server, once the segment's own quick retries are spent) the job waits
and asks for the same segment again, with the waits of a direct file: 1, 2,
4, 8 and 16 seconds, or a longer permitted `Retry-After`. The popup shows
the wait, and each segment that arrives starts the count again. This holds
for HLS and for the segments of DASH and of separate audio and video tracks
(`packages/extension/src/engine/net/reconnect.ts`). A segment the server
refuses or does not have is not waited for. When the outage outlasts five
reconnects, the save ends as a lost connection and keeps nothing: Retry save
reads the stream again from its first segment. A server that refuses the
connection is given up after one to two minutes. A stalled segment, where the
server accepts the connection and then sends nothing for 45 seconds, is not
read again at once: each stall is one of the reconnects, so a server that
hangs holds the save for six stalls and the five waits between them, about
five minutes, and the progress stands still during each stall. A track or stream that is one
file is read again from its start when its body drops, and does not wait out
an outage. A transport stream becomes an MP4 when MP4 can carry its
audio and video (H.264 or HEVC with AAC, MPEG audio, AC-3 or E-AC-3),
leaving metadata such as timed ID3 out; it stays a `.ts`
file when the page offers the `.ts` file itself or when MP4 cannot carry a
stream. Only scrambling refuses a transport stream. Damage does not: a
packet marked as damaged in transit, a table with a wrong checksum and a
last packet that was cut short are passed over, as a player passes over
them (`packages/extension/src/engine/mpeg-ts.ts`).

## Verify locally

For a manual discovery check, embed an owned clip in a visible iframe with
`allowfullscreen` and a paused `<video preload="none" data-src="…">`.
Open the popup before pressing Play. The clip should appear, the player
should remain paused, and Alt+S should select the same file.

After building the extension, run the isolated Chrome recovery fixtures from
`packages/extension`.

```sh
bun x playwright test --project=chromium tests/e2e/range-recovery.spec.ts tests/e2e/interrupted-download.spec.ts
```

To reproduce the movable Chrome preview, run
`bun run --filter @savemedia/extension build:preview` after building core.
Load `packages/extension/dist-preview` in Chrome. The public key in
`manifest.preview.json` keeps the preview ID
`bcccjfmdffhkejbogpedfpbgolgglnok` when the folder moves. The store build
has its own identity and requests native messaging when the local downloader
is switched on. The dedicated desktop preview declares that permission at
installation. Register the preview ID with the native host to check the
local downloader. Use a temporary Chrome profile for automation.

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
bun run --filter @savemedia/extension test:e2e:chromium tests/e2e/classification.spec.ts -g 'file link a named page declares|reports certificate failures'
bun run --filter @savemedia/extension test:e2e:chromium tests/e2e/classification.spec.ts -g 'after rotation'
```

The declared-link check opens a named file page with an unavailable player
source and a redirecting download link, saves it from the popup, then saves
a second page with Alt+S. Both pages also carry labelled Download controls
that count their clicks, and the check requires zero clicks. It compares
both output filenames and every byte. The certificate fixture checks that a
named file's save failure remains visible when the popup reopens.

The source-rotation check saves two distinct local movies in one tab using the popup
and then Alt+S. The first source appears after the popup opens and expires
after discovery: the save reports the refusal, opens no other tab, and
succeeds after the page reloads with its new source. The second source
changes its redirect destination. The test checks the original filename,
bytes and video track on disk. Separate failure
cases return HTML or a 69-byte JSON response during saving and check for
visible feedback and an empty download list. The movies come from FFmpeg's
test pattern and color bars with a generated tone. The color bars fixture's
first atom is tagged as free space to exercise legacy QuickTime while
keeping all offsets intact. The HTTPS fixture covers range recovery and retries.
The connection failure test uses an untrusted loopback certificate and an
HTTP 451 response. Both the popup and Alt+S report the failure in the same
words, and Chromium records zero downloads. The certificate check remains
active in that test. `tests/e2e/network-block.spec.ts` covers a public name
answered from a local address, a name that does not resolve and a redirect to
a block page, with resolver rules that keep every request on this machine.

The range and top-level box checks were adapted from
`internal/rescue/downloader.go` and `internal/rescue/validate.go` in Video
Rescue at commit `09e855aa8172e7b83488e134a562f40bd197879d`. The MIT notice
is bundled at `packages/extension/public/licenses/video-rescue-MIT.txt`.
