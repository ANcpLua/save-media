# savemedia Design

This document records the repository's single supported product contract. It
does not use roadmap labels: a behavior is supported, refused, or not claimed.

## Product Boundary

savemedia saves the videos and images the browser receives during normal
playback and browsing, when they are not DRM encrypted and the extension can
fetch every required byte and produce one verified file with tested code. The
policy behind this document is [`boundary-rules.md`](boundary-rules.md), which
overrides it.

The policy names one refusal on purpose:

- the media is protected: DRM, Clear Key or Common Encryption (CENC, cbcs),
  an HLS key only a protected media module can unwrap (any `KEYFORMAT` other
  than identity, SAMPLE-AES, SAMPLE-AES-CTR), a key address that answers as a
  licence server, or a scrambled transport stream.

The code also stops on purpose in two more cases. The policy lists them
under "Where the code differs from the policy today":

- a page on the internet names a server inside the user's local network that
  the browser itself was not answered from for that tab (not requested), or a
  public name leads to such a server (requested once, answer not used);
- a file requested over HTTPS is answered over plain HTTP after a redirect.

Everything else that is not saved is a limit of the code or of the server,
and the message says which:

- HLS that is live or still growing, malformed HLS fMP4/CMAF, or HLS byte
  ranges that do not add up to one whole clear file;
- DASH that is not fully addressed (a dynamic or live MPD, or byte ranges
  that do not cover one file from its start without a gap);
- the server denies access, limits requests, or is busy after retries;
- the user's network keeps the browser from the server;
- a required playlist or media part cannot be fetched;
- the address looks like media but its bytes are not a supported video.

Two paths save a file that savemedia does not verify itself: the browser's
own resume of an interrupted download, which savemedia cannot read and
accepts by the video type its server declared, and the optional Local
downloader, where yt-dlp writes the file and makes its own requests.

A price, a "premium" or "preview" label, an overlay or a click-through gate
decides nothing. The extension never saves a web page, a script, a program,
a random stream part or an init section as a video, and never saves bytes
that are not an image as an image.

## Supported Capabilities

| Capability | Status | Verification gate |
| --- | --- | --- |
| Direct verified `.mp4` and `.mov` download | Implemented | Chromium e2e checks original QuickTime filenames and bytes, video tracks with `ffprobe`, redirects, and refusals for nonvideo responses. |
| Direct verified `.webm` and `.mkv` download | Implemented | Chrome e2e saves the Matroska fixture byte for byte under the name the save asked for (`classification.spec.ts`) and WebM fixtures byte for byte (`main-video.spec.ts`). |
| Plain HLS VOD with MPEG-TS segments | Implemented | Chrome e2e remuxes a real TS fixture to playable MP4. |
| Plain HLS VOD with clear fMP4/CMAF segments | Implemented | Chrome e2e downloads a real `EXT-X-MAP` fixture to playable MP4 after init/fragment validation. |
| Clear HLS kept in one file (`EXT-X-BYTERANGE`) | Implemented | Chrome e2e saves an fMP4 file and a transport stream file whose playlists list three byte ranges that cover the file from its first byte to its last (`hls-single-file-fmp4`, `hls-single-file-ts`). The file is requested once; the fMP4 is saved byte for byte, the transport stream is remuxed and compared picture by picture. A fragmented MP4 whose ranges leave stretches out between them (a packager's index after the header) is one file too: once it is read, each stretch must hold only whole boxes without samples (`engine/file-gaps.ts`), else it is refused. Chrome e2e merges a demuxed pair of such files (`hls-single-file-gaps`). |
| Demuxed HLS (`EXT-X-MEDIA` audio group) → single merged MP4 | Implemented | Chrome e2e downloads a real demuxed fMP4 fixture (separate video/audio media playlists) and `ffprobe` verifies the output MP4 carries both an h264 video and an aac audio stream. A demuxed variant never falls back to the plain-HLS path, so a silent video-only file cannot be saved. |
| Demuxed HLS with a packed audio rendition (bare AAC or MP3 frames, an ID3 tag on each segment) | Implemented | `engine/packed-audio.ts` takes the tag off each segment, keeps the frames and places the sound at the time the first tag states. Chrome e2e saves a three-segment fixture (`hls-packed-audio`) and compares every decoded picture and audio sample with it, and the start and length of sound and picture; unit tests cover the frame walk and the job. A segment that holds anything else than tags and audio frames is refused, never saved short. Regenerate the fixture with `node scripts/generate-packed-audio-fixtures.mjs`. |
| Clear DASH video+audio → single merged MP4 | Implemented | Chrome e2e downloads a real ffmpeg DASH packaging (static MPD, SegmentTemplate addressing, H.264 video and AAC audio AdaptationSets, committed init and chunk bytes) and compares the saved MP4 with the fixture: every decoded picture, every audio packet and the length. `smoke:edge` and `smoke:firefox` save the same fixture and check that it plays. Core unit tests assert the same manifest text materializes both AdaptationSets and dispatches to av-merge. Regenerate the fixture with `node scripts/generate-dash-fixtures.mjs`. |
| Clear DASH that declares no audio → MP4 with the picture alone | Implemented | Chrome e2e saves a real video-only packaging (`dash-video-only`) from the popup and with Alt+S and compares every decoded picture with the fixture. |
| Clear DASH whose one representation holds video and audio together → MP4 with both | Implemented | The manifest then has no audio AdaptationSet, and the merge copies the audio track the video stream carries itself: the bytes decide, not the `codecs` attribute. Chrome e2e saves such a manifest (`dash-muxed`) and compares every decoded picture and audio packet with the file it names. |
| Clear DASH kept in one file per track | Implemented | Chrome e2e saves one pair of files under two manifests: a SegmentList of byte ranges that covers each file, and a SegmentBase with an index range (`dash-single-file`). Each file is requested once and the saved MP4 holds every picture and audio packet of both. |
| DASH refusal (encrypted, dynamic/live, several periods, or byte ranges with a gap) | Implemented | A SegmentList whose byte ranges leave a gap produces a descriptor and refuses with `dash_unsupported`, and nothing of it is requested; the dynamic-MPD fixture stays unmaterialized. A static manifest of several periods is refused the same way, whichever quality is asked for: its periods are never joined under one period's header, and its first period (often an ad) is never saved as the video (`packages/core/tests/parser/dash/multi-period.test.ts`). Encrypted MPDs refuse with `cdm_required` or `clearkey_deferred`. |
| HLS AES-128 with a key served in the clear | Implemented | Chrome e2e and `smoke:edge` download the AES-128 fixture and `ffprobe` verifies the output; a unit test decrypts the fixture ciphertext and asserts the job writes the plaintext byte for byte. Key fetch is one 16-byte request per key URI, cached across segments. |
| HLS key that a CDM owns → refusal | Implemented | FairPlay (`KEYFORMAT="com.apple.streamingkeydelivery"`) and SAMPLE-AES fixtures refuse with `cdm_required` without the key URI ever being requested, at detection when a media playlist or a master's `EXT-X-SESSION-KEY` declares them. The key request carries the user's cookies and the page's Referer like the player's; a key URI that still answers 401/402/403 refuses with `license_bound_stream`. A page, data or any other answer than 16 bytes is reported as `hls_key_unusable`, never as DRM. |
| HLS fMP4/CMAF internal-piece filtering | Implemented | Fixture verifies init/fragment URLs are not surfaced as standalone downloads. |
| DRM detection | Implemented | Widevine fixture is refused with `cdm_required`. |
| Clear Key and Common Encryption (CENC, cbcs) detection | Implemented | Clear Key fixture is refused with `clearkey_deferred`. Any DASH `ContentProtection` element marks the presentation as protected, whatever its scheme. MP4 and fMP4 that declare Common Encryption (`encv`/`enca`, `sinf`/`schm`, `tenc`, `pssh`, `senc`) are refused at detection, on HLS and DASH init segments and before a direct file is saved; so are WebM and Matroska tracks that declare `ContentEncryption`, and transport streams whose packets or PES headers are scrambled. |
| Site readers | Implemented, open owner decision | Three readers in `content/sites/*` run in the page's MAIN world on their own sites' pages and read the page's own player responses; the files they name are probed like any other candidate. They run next to the generic observers, not instead of them. Store packages (`bun run zip`, `SAVEMEDIA_STORE_BUILD=1`) carry two of them and leave out the reader whose site the Chrome Web Store does not accept; a store package offers none of that site's media in the browser by another way either: its hosts stay managed in `background/network-capture.ts` in every build, which keeps network capture and the page bridge off its pages, and a store package makes no check of the addresses such a page declares or its players hold (`onStoreExcludedSite`, applied in `background/index.ts`; unit tested, and outside store packages those addresses are checked like any page's). On a page of a site with a reader, the background tells the selector so (`managedSite`), and the selector answers `site-not-saved` in a store package on the site it leaves out ("savemedia does not save videos from this site.") and `reader-found-nothing` where the reader named nothing ("savemedia found no file it can save in this page's player data."), in place of "nothing found" or "start playback". The opt-in Local downloader has no such gate: with it turned on, Save this page with yt-dlp and the Alt+S fallback hand that site's pages to the user's own yt-dlp in store packages too (open owner decision; a store review risk). `scripts/package.mjs` refuses to pack a build that still carries the reader. Whether the readers stay is an open owner decision. Unit tests cover the readers with fixtures. |
| `Alt+S` under the pointer | Implemented | Saves the video or image under the pointer, or the page's main video. Automated tests check command registration and press Alt+S on pages in Chromium (`tests/e2e/main-video.spec.ts`, `popup-ux.spec.ts`). A second press on a running save starts nothing and says "Already in progress". |
| Alt+S image save | Implemented | The image is fetched once, its bytes are checked, and only those bytes are saved; a web page, a script or a program is refused with a plain message (`tests/e2e/main-video.spec.ts`). |
| Plain-language failures | Implemented | One text per `JobError` in `packages/core/src/errors/messages.ts` and `network-block.ts`, one renderer in the popup, codes and HTTP details only under Technical details. A wording test covers every error code (`packages/core/tests/errors/messages.test.ts`) and every catalogue string (`packages/extension/tests/unit/ui/text.test.ts`). |
| Network-block explanation | Implemented | `packages/core/src/errors/network-block.ts` explains a private address for a public host, certificate errors, name lookup failures and redirects to a block page from what the browser reported about savemedia's own requests (`tests/e2e/network-block.spec.ts`). Nothing is reached another way. |
| Local downloader (opt-in) | Implemented | Optional `nativeMessaging` permission requested from the popup. Background hands only the page URL to `packages/native-host` (user-installed yt-dlp and ffmpeg) when the user asks, or as the Alt+S fallback when the in-browser engine has nothing to save or refuses for a non-DRM reason (`DELEGABLE_ERROR_CODES` allowlist, which holds no protection code). **Save this page with yt-dlp** in the popup hands over the page address whatever savemedia found on the page; there yt-dlp's own format data decides, and a page whose every video format is DRM protected is reported as protected. Progress, completion and failures stream back to the popup. A job Alt+S started also ends with an in-page toast. See `docs/boundary-rules.md`. |
| Edge runtime | Release-gated | `smoke:edge` launches Edge with the unpacked Chromium build, opens the popup, checks runtime messaging/command registration, downloads direct MP4, remuxes HLS MPEG-TS VOD, downloads clear HLS fMP4/CMAF, decrypts AES-128 HLS, merges clear DASH, presses Alt+S, and verifies the refusal fixtures. |
| Firefox runtime | Release-gated | `smoke:firefox` temporarily installs the extension, opens the popup, checks runtime messaging/command registration, downloads direct MP4, remuxes HLS MPEG-TS VOD, downloads clear HLS fMP4/CMAF, decrypts AES-128 HLS, merges clear DASH, and verifies the refusal fixtures. Firefox 155 with selenium-webdriver 4.44 refuses to navigate to `moz-extension://` over classic WebDriver ("Navigation to … is not allowed in this context"), so this smoke needs a driver or Firefox version where that step works; the Chromium e2e and `smoke:edge` cover the same capabilities meanwhile. |

## Unsupported

- ffmpeg.wasm or browser-side transcoding.
- "Small file", "best quality transcode", manual output modes, or arbitrary MP4
  conversion modes.
- Dynamic or live DASH, and DASH whose byte ranges do not cover one file
  from its start without a gap (these keep the `dash_unsupported` message;
  the Local downloader may handle them).
- HLS byte ranges that lie in several files, are each encrypted with
  AES-128, leave a gap in a transport stream, or leave media out of a
  fragmented MP4, and fragmented MP4 HLS that names another header
  (`EXT-X-MAP`) part-way (these keep the `hls_layout_unsupported` message;
  the Local downloader may handle them).
- SAMPLE-AES or SAMPLE-AES-CTR, and AES-128 whose key is only available
  through a protected media module or as a licence response. These are
  protection and are never worked on.
- HLS Live/DVR recording.
- Direct `.avi`, `.wmv`, `.flv`, or media guessed from an address alone.
- Mobile browser support, side panel UI, subtitles, telemetry, or cross-device
  sync.

## Runtime Architecture

```text
Page MAIN world
  content-main.js
  proof of key use on media elements, the ad responses the page
  receives, and the player responses the site readers read
        |
        v
Page ISOLATED world
  content-bridge.js
  reports each frame's facts on request, the requests in the
  resource timeline and key use; passes on only ad addresses and
  resolver file addresses from the MAIN world
        |
        v
Background router
  observes media responses, classifies descriptors, owns job state
        |
        v
Chromium offscreen document
  engine host verifies direct files, HLS, and merged audio/video and returns Blob URLs
        |
        v
chrome.downloads.download, then completion feedback
```

Firefox has a separate build target. Its background event page hosts the HLS
engine in-process because Firefox has no `chrome.offscreen` API. Chrome passing
is not Firefox evidence; `smoke:firefox` is the Firefox runtime gate.

## State and lifetime

The browser stops an idle service worker and starts it again for the next
event. Nothing the user can see depends on the worker's memory.

- **What is kept.** The tab's detected media, failures, finished and running
  saves (with a note of how many bytes a failed save keeps for Retry save; the
  bytes themselves stay in the engine's memory), open "save another copy"
  questions, Chrome's own resumes, the Referer rules in use,
  which stream the page requested last, what the tab's frames last reported
  about their media elements, a notice on the tab's toolbar button and each
  tab's diagnostic journal are written to `chrome.storage.session` under the
  prefix `sm1:` (`background/state/records.ts`). What a tab lists is decided
  from this state alone, so a restarted worker lists what the worker before
  it listed. The browser holds this in
  memory, never on disk, and clears it when it quits and when the extension is
  updated, reloaded or turned off. A closed tab's records are deleted.
  savemedia cannot be turned on in private windows (`"incognito":
  "not_allowed"` in `manifest.json`): shared with the normal windows, its own
  requests would carry their cookies and its saves would land in their
  download list. The code that keeps a private tab's diagnostic journal in
  worker memory only stays for the day private windows get their own
  instance (`"split"`).
- **How it is written.** Memory is the source of truth. Changes are queued and
  written in batches (`background/state/session-store.ts`): the changes of one
  task are one write, and changes made during a write are exactly one more. No
  timer paces it. A save's record is stored before the engine hears of the
  job, and before the browser is asked to write the file.
- **A worker start.** `background/index.ts` creates everything in one
  synchronous pass and registers every listener at once. Each listener waits
  for the stored state to be read back (`background/state/rehydrate.ts`), so
  no event is handled on empty state. The state is read once and only fills
  empty memory, so nothing is applied twice.
- **Ids.** A row's id is derived from its tab and its source
  (`util/content-id.ts`), so the same source has the same id in every worker
  instance. A popup that still holds an id from before a restart addresses the
  same row; a row that is gone is answered as `listing-expired` and the popup
  looks at the page again.
- **The engine.** On Chromium the engine document and the background are
  connected by one port (`background/engine-channel.ts`,
  `engine/background-link.ts`). The port carries every engine message and is
  the liveness signal: a disconnect the background did not ask for means the
  engine document is gone, and its saves fail with `engine_stopped` so they
  can be saved again. The engine keeps a result until the background
  acknowledged it and reports it again when a new worker connects. The
  background closes the engine document when the engine is idle and no save
  needs it, and creates it again for the next job. Chrome 114 and 115 have no
  `runtime.getContexts`; there the document is found among the extension's
  window clients.
- **Messages.** Every message has a type and a schema in `types/messages.ts`.
  One dispatcher (`background/dispatch.ts`) decides by the sender what a
  message may be: the popup's requests are taken only from the popup page and
  always get one reply, a page's messages only from that page's content
  script, and engine messages only over the engine port from the engine
  document.
- **Pages savemedia cannot read.** When a tab's content script does not
  answer, `util/page-reach.ts` names why from structure alone: the address
  scheme, the tab's load state, the user's permissions and whether this worker
  saw the tab load. A tab that was open before the install or an update says
  "Reload this page so savemedia can see it." and nothing is saved from it by
  Alt+S, because the pointer target, ad signals and key use are unknown there.
  A tab whose last top-level navigation failed shows the browser's own error
  page: `webNavigation.onErrorOccurred` for the top frame (a navigation the
  browser dropped, `net::ERR_ABORTED`, is not one) marks the tab, what the
  page before it had loaded is dropped, and the popup and Alt+S say "This page
  did not load. Reload it, then try again." with the Reload page button. The
  next document that commits clears the mark. A page the browser blocks for
  extensions loads without an error and keeps "Your browser does not let
  extensions read this page."
- **Local network.** For a page with a public name, a server inside the
  user's network is requested only when the browser itself was answered from
  that origin (scheme, host and port) at a local address, in the same tab.
  `background/network-capture.ts` notes such an origin from the browser's own
  request events (`webRequest.onResponseStarted` and `onBeforeRedirect` for
  media element requests and fetch/XHR, which name the server address), before
  the response is looked at; nothing savemedia requested is ever noted. The
  tab's own documents count the same way: a second pair of listeners, for
  `main_frame` and `sub_frame` only and without headers, notes the origin of a
  page or frame the browser was answered for from a local address, and reads
  nothing else of them. The page's own origin waits until the tab shows the
  new document, because showing it clears what the tab knew
  (`createTopDocumentAnswers`). A page with a public name that the browser
  reached at a local address lives on an intranet or is seen through a proxy
  inside the network, which the browser then reports as the address of every
  server. For such a tab the reported server address decides nothing
  (`reachedLocallyByName` in `util/address-space.ts`): no answer is dropped
  for it and no failure is explained as "a public name at a local address".
  An address that is itself local still waits until the browser was answered
  from it. The
  origins are kept per document (`localOrigins` in `util/tab-media-state.ts`),
  given back to a page restored from the back-forward cache, and handed to a
  save when it starts, so the engine applies the same rule to a playlist's
  keys and segments (`engine/runner.ts`). `util/address-space.ts` holds the
  rule and reads IP addresses with core's parser (`net/address.ts`). A check's
  own request is judged step by step: `background/request-outcomes.ts` records
  for each redirect hop the address asked for and the server address that
  answered, and an answer from a local server the browser was not at is
  dropped. When the browser is answered from a new local origin, a source that
  was refused because the page only named that server is checked again when it
  is next seen. Image requests are not among the noted ones. For Alt+S on an
  image, the picture the page shows stands in for them: the content script
  reads in its own world that the `img` element under the pointer has loaded
  (`complete` and a natural width, `content/pointer-media.ts`), and
  `background/image-save.ts` then counts the image's origin as answered, for
  that one save. A broken image and a background image open nothing.
- **Ads.** An address a page's ad response names (a VAST or VMAP media file,
  an HLS interstitial asset) is never the main video, is in none of the pools
  Alt+S or Save choose from, and is never requested by savemedia on its own.
  When the browser itself loaded it, `background/capture.ts` lists it from the
  headers of the browser's own answer, as a row marked `unchecked`, and stops
  a check of it that was under way. The selector returns such rows apart
  (`ads` in `selection/main-video.ts`); the popup shows them last in a closed
  "Ads (n)" group, and the toolbar count leaves them out. Save on such a row
  is the user's request: only then is the address checked like any other, and
  the checked row is what is saved. A mark never removes a row, and a video
  that is playing an ad keeps the answer "An ad is playing". An ad that is
  paused, has ended or never started promises no video and gets the page's
  own answer.
- **Route changes inside a page.** A frame that changes its route without a
  new document gets a new route generation (`background/frames.ts`). What a
  look at the page found its players holding is noted with the generation it
  was read on (`background/page-facts.ts`): stored facts of an earlier route
  are not used for the toolbar count or the list. While a popup shows the
  tab, the page is read once more after each route change, so that popup
  follows what the players hold now (`createRouteFollower`). With no popup
  open nothing is read, because a page may change its address every second
  while it plays; the count then follows what the browser received, and the
  user's next look reads the new route. Every list the popup is sent names the top frame's
  address, and the popup follows it. Save on a card that is still this tab's
  saves that card when the page changed its own address meanwhile; a Save
  that cannot start says why in the popup.
- **The pointer.** Only the user's own pointer events are recorded (trusted
  events, `content/bridge.ts`). A page script, in any frame, can dispatch
  pointer events, and the newest record among the frames decides where Alt+S
  looks, so a script must not be able to write one.
- **A still under the pointer.** A picture the page declares as its video's
  still stands for the page's video and is never saved as a picture: an
  element's `poster`, a schema.org `thumbnailUrl`, and `og:image` on a page
  that declares an `og:video` of any type, an embed page included
  (`content/video-metadata.ts`). When nothing of a video has reached the
  browser, as on a player that makes its video element only on Play, Alt+S
  on the still answers "The page has not loaded the video yet. Start
  playback, then try again." (`selection/pointer-target.ts`,
  `selection/main-video.ts`).
- **A canvas under the pointer.** A canvas stands for the video element that
  feeds it. When no element does (a player that draws a video it never
  attached to the document), the one stream that the canvas's own document
  loaded and that belongs to no video element is the canvas's. With none or
  several, the page's main video is the answer.
- **Rows have a bounded size.** A listed row never carries a stream's whole
  segment list (`util/thin-descriptor.ts`): it keeps an even sample of at
  most 240 segment addresses, enough to recognise the page's later requests
  as that stream's. A save reads the HLS playlist or the DASH manifest again
  when it starts (`engine/jobs/hls.ts`, `engine/parsers/dash.ts`), as the
  page's player does, and what the manifest declares then, protection
  included, is what counts. When the server refuses the playlist at that
  moment, the failure carries `atSaveStart` and the message says that the
  playlist answered when the video was found and no longer does, and to play
  the video on the page again, then save. No reason is guessed. A manifest may resolve to at most 32 MiB of
  address text (`MAX_MANIFEST_ADDRESS_BYTES` in core, refused before the
  addresses are built), a media address longer than 8192 characters is not
  checked, a row larger than 512 KiB after thinning is not listed, and a
  tab's rows hold at most 4 MiB together.
- **Bounds.** A tab keeps at most 200 rows (the oldest row that is neither
  saving nor the main video goes). It runs at most 6 checks of what the page
  loaded at a time, at most 4 of them for one frame, with a bounded queue
  that serves the frames in turn; the checks the user asked for (the popup,
  Alt+S) have 4 places of their own and never wait behind the others. A
  playlist is read whole only while it arrives at 256 KiB per stall window or
  faster. The tab's list is sent only to popups that show that tab.
- **Referer rules.** The browser holds at most 64 idle rules, each for one
  exact host. A save holds the rules of every host it requests, a direct
  file's host included, until it ends, and a check holds its rules until it
  ends: a held rule is never switched or dropped. A save sends the Referer
  its check sent, which is the frame that loaded the media, not the tab's
  page. One save holds at most 64 rules and all saves together 256; requests
  to further hosts go out without the page's Referer. When a check needs a
  host that a running save holds for another page, the check goes out with
  the save's Referer.
- **When the store is full.** A refused write drops expendable groups one at
  a time, the one that takes the most room first: a tab that filled the store
  loses its own stored state before any other tab does. Jobs, questions,
  resumes and receipts are never dropped, and what still does not fit is
  written value by value, so one value never takes the others with it.
- **Saved settings.** `chrome.storage.local` is restricted to the extension's
  own pages and worker (`setAccessLevel`), so a page's content script cannot
  read or change the local downloader's opt-in.

## Classification Rules

Three questions are kept apart, and a name answers only the first:

1. **Is a check worth a request?** (`worthProbing` in `util/media-url.ts`.)
   The request type and the MIME type decide. A media element's own request
   is checked when its type is a video type, a playlist type, missing or
   `application/octet-stream`. An answer to a script's fetch or XHR is
   checked only when its type is a playlist type or it carries an attachment
   header. An address the page declares is checked when the page states a
   media type for it. A name only opens this gate: a `.m3u8` or `.mpd` name,
   or a declared address with a file name such as `.mp4` or `.webm`. A
   transport stream name (`.ts`) opens it for no declared address: such a
   file is checked as a media element's source or with its MIME type.
2. **What is it?** The first bytes decide. Parsing a playlist or manifest
   confirms HLS or DASH, its variants and its protection signals. A direct
   file needs a recognizable MP4, QuickTime, WebM or Matroska container in
   the response bytes, or MPEG transport stream packets. The address and the
   headers only give a first guess (`classifyByUrl` and `classifyByHeaders`
   in core, confidence "guessed"), which the bytes replace.
3. **Is it a video of its own?** Segments and init sections are left out for
   one of three reasons, none of them a name:
   - a known playlist lists them (`hlsCoveredDirectUrls` in
     `background/router.ts`);
   - their request type and MIME type make them not worth a check: a player
     fetches its pieces with fetch or XHR, and `video/iso.segment` names no
     file;
   - their bytes are a fragment or an init section without media. A
     fragmented MP4 under a DASH or CMAF brand counts as MP4 when media
     follows its movie box; an init section alone does not.

No rule reads a segment-like name (`.m4s`, `init.mp4`, a numbered part): a
file named `segment-03-interview.mp4` or `part-2.mp4` that a media element
loads is checked like any other file.
See [direct file discovery and recovery](range-recovery.md).

A video that a page's script fetches (fetch or XHR) is checked at once only
when its answer is a playlist or carries an attachment header: a player that
is fed piece by piece fetches its init sections and fragments the same way,
and a check of each would be a request per piece. A full answer (status 200)
with a video type is noted instead, with the frame and document that asked
and the server that answered (`mayBeFetchedFile` in `util/media-url.ts`,
`fetched` in `util/tab-media-state.ts`). An address of a stream savemedia
already knows is a part of that stream and is not noted. A tab keeps 64
notes in memory and stores its first eight, as many as one look asks about,
so a player fed piece by piece costs no stored change per piece; after a
restart of the service worker the stored notes are the ones known. When the user opens the popup or presses Alt+S
and a player of that document plays from a `blob:` address with nothing else
known as its video, the selector asks for a check of up to eight of those
answers, newest first (`fetchedProbes` in `selection/main-video.ts`). The
first bytes then tell a whole file from a part of a stream
(`beginsWholeMediaFile` in `packages/core/src/classifier/whole-file.ts`): a
whole file is listed as the document's own request and becomes the player's
video; a part, anything that is no video, and a check that ends for good
(a server that refuses savemedia's request, a file that is gone) is let go
without a failure and is not asked about again. A check that ends for a
reason that may not repeat (a lost connection, or a status the retry policy
calls transient, such as 503 or 429) lists and explains nothing either, but
keeps the address, so the next look asks again. A transport stream is never noted this way,
because a browser plays none from memory.

A file name the page shows (a heading or its title) is given to a file only
when the file's own bytes are of the kind the name says (`nameFitsContainer`
in `util/media-url.ts`). A page that names `Movie.mkv` and plays an MP4
preview of it has not sent `Movie.mkv`: the preview keeps its own name, and
the popup and the Alt+S toast say that the named file has not reached the
browser. A preview in the same format as the named file cannot be told from
the file this way.

## Download Jobs

### Direct

The engine fetches the current response and verifies the completed file
before handing its Blob to `chrome.downloads.download`. It preserves the
container and original filename for direct files.

### Memory

No job holds a whole file as byte arrays in the engine document. Bytes are
folded into Blobs as they arrive, each time 16 MiB have gathered
(`engine/blob-parts.ts`), so the document holds one segment or a few chunks
of a file at a time; the browser keeps a Blob's data outside the document
and can move it to disk. The remux and the merge read their inputs
from Blobs in slices and write the MP4 into Blobs again, with its index at
the end (`engine/remux/mp4-output.ts`), so the muxer keeps a few 4 MiB chunks
and the sample tables, not the samples. A checksum the server states is
computed over 4 MiB windows of the finished Blob (`engine/crypto/sha256.ts`).
A save has no size limit of its own: no size, stated or estimated, refuses
a save, and no count of received bytes stops one. A size worked out from a
bit rate over the stream's length is an estimate that leans high (HLS
`BANDWIDTH` is the peak rate) and is only shown. What bounds a save is the
browser's Blob storage: a merge or a remux holds its input and its output as
Blobs at the same time, and a save that outgrows that storage fails like any
other engine failure. Very large saves are not covered by a test.

### HLS

The engine fetches the selected media playlist, not just the master playlist.
Runtime playlist parsing is authoritative because `EXT-X-KEY`, `EXT-X-MAP`, and
`EXT-X-ENDLIST` live on the media playlist.

Supported:

- clear MPEG-TS HLS VOD -> MP4 remux;
- clear fMP4/CMAF HLS VOD -> MP4 assembly after validating `ftyp`/`moov` init
  boxes and `moof`/`mdat` media-fragment boxes;
- clear HLS VOD whose parts are byte ranges (`EXT-X-BYTERANGE`) of one file,
  from its first byte and in order -> the file is read once, whole, up to
  where the ranges end; a fragmented MP4 is saved as it is after the checks
  a direct file gets, a transport stream is remuxed like any other. A
  transport stream's ranges leave nothing out. A fragmented MP4's may leave
  out stretches that hold only boxes without samples (the index a packager
  keeps after the header), which is checked once the file is read;
- a transport stream whose clock starts again part-way (decoding times that
  step back: a clip joined in on the server, `EXT-X-DISCONTINUITY`) -> every
  packet is kept, as a `.ts` file. One MP4 track written by copying packets
  cannot carry a clock that starts again, and a remux the muxer does not
  finish for another reason ends the same way, never in a failed save;
- demuxed HLS VOD (`EXT-X-MEDIA TYPE=AUDIO` group) -> both media playlists
  are materialized to concrete segment URLs and the key of every segment,
  each track is fetched, decrypted where a key covers it, inspected and
  concatenated, and the pair is muxed into one MP4 by the av-merge engine
  (copy-encoded-packets, no re-encode). A demuxed variant must never fall back
  to the plain path: if the audio track cannot be planned, the job refuses
  rather than saving silent video.

Decrypted: `EXT-X-KEY:METHOD=AES-128` with KEYFORMAT absent or `identity`,
in muxed and demuxed variants alike. The key is one 16-byte GET over the same
HTTP the player uses (the user's cookies, the page's Referer and Origin),
cached per key URI so rotation costs one fetch per key; the IV is the tag's
`IV` attribute or the media sequence number as a 128-bit big-endian integer
(RFC 8216 5.2); AES-CBC with the PKCS#7 padding WebCrypto removes. A key tag
before `EXT-X-MAP` covers the init section too: a section that opens with an
`ftyp` box is used as it is, any other is decrypted with that key.

Refused:

- missing `EXT-X-ENDLIST`;
- SAMPLE-AES, SAMPLE-AES-CTR, or AES-128 with a non-identity KEYFORMAT, in
  any key tag of the media playlist or in the master's `EXT-X-SESSION-KEY`;
- a key URI that answers the player-like request (the user's cookies, the
  page's Referer) with 401, 402 or 403;
- a key URI that answers with a page, data or any other than 16 bytes,
  reported as such, and a 16-byte key the segments do not decrypt with;
- byte ranges that lie in several files, carry an AES-128 key, leave a gap
  in a transport stream or leave media out of a fragmented MP4
  (`hls_layout_unsupported`): the engine reads whole files, not ranges;
- a fragmented MP4 playlist that names another header part-way
  (`hls_layout_unsupported`, layout `init-changes`): parts behind the first
  header would be saved as a file that stops playing at the change;
- a playlist address that sends a web page or other data when it is read
  again as the save starts (`unexpected_media_response` with `atSaveStart`),
  told as "The video's playlist no longer answers", never as a damaged or a
  live playlist;
- a ciphertext segment whose length is not whole AES blocks;
- a page or data document in place of a segment, reported as such;
- malformed `EXT-X-MAP` fMP4/CMAF playlists;
- unknown first-segment bytes.

### DASH

DASH manifests are parsed for descriptors, protected-media detection, and the
clear video AdaptationSet with the audio AdaptationSet that belongs to it. A
clear stream with fully addressed tracks dispatches to the av-merge engine
and saves one MP4. A manifest that declares no separate audio is saved as
its video track is: with the sound that track carries itself (one
representation can hold video and audio together), or with its picture
alone. A track is fully addressed when every
segment has its own address (SegmentTemplate, SegmentList), or when the
representation is kept in one file: SegmentBase, or a SegmentList of byte
ranges that covers the file from its first byte without a gap. Such a file
is read whole, once, and where the ranges state its end, only up to there.
Anything less (a dynamic or live MPD, a manifest of several periods, byte
ranges with a gap or in several files, a codec the MP4 muxer does not write,
or an audio track that exists but cannot be fetched) ends with
`dash_unsupported`. A manifest of several periods is not put together: each
period has its own header and timeline, and one of them is often an ad
placed before the video. Protection has its own
codes.

### Audio+video merge (av-merge)

The merge engine (`engine/remux/merge-av.ts` via `engine/jobs/av-merge.ts`,
mediabunny) copies encoded packets from a video input and an audio input
into one MP4; it never re-encodes. Without a separate audio input it copies
the audio track the video input carries itself. Each track arrives as init
segment + media segments concatenated in order. An HLS audio rendition of
bare audio frames (packed audio) is joined without the ID3 tag each of its
segments opens with, and its packets are placed from the time its first tag
states (`engine/packed-audio.ts`). Both tracks are rebased by one global timestamp
offset (`max(0, -min(firstVideoTs, firstAudioTs))`) because demuxed AAC starts
at a negative priming timestamp that the MP4 muxer rejects. A single shared
offset preserves A/V sync. Output is always MP4; a failed or aborted merge
discards its partial output.

## Failure Reasons

Every failure is a `JobError` with a code and structured fields
(`packages/core/src/errors/taxonomy.ts`). `userMessage` in
`packages/core/src/errors/messages.ts` turns it into what the user reads: a
title, a body, a hint (what the user can do, or none when nothing helps),
rows for Technical details, a tone and an optional **Retry save**. Codes,
HTTP statuses, hosts and byte counts appear only in the rows. The card's
button reads **Retry save** only when the message offers it or the failed
save kept bytes; otherwise the user follows the hint first and the button is
the plain **Save**.

- Protection (`encrypted_media_detected`, `cdm_required`, `clearkey_deferred`,
  `license_bound_stream`): "Protected video", no hint, no retry, and neither
  the Alt+S fallback nor the offer under the failure hands it to the Local
  downloader.
- `rate_limited`: HTTP 429; the hint gives the wait from `Retry-After`.
- `server_busy`: HTTP 408, 425, or 5xx after retries.
- `access_denied`: HTTP 401, 402, 403 or 451. This covers a session, a
  purchase, an expired link or a legal restriction. It is never called
  protection.
- `http_error`: any other refusing status. On this code and on
  `access_denied`, `atSaveStart` marks a playlist or manifest that is refused
  when a save reads it again: "The video's playlist no longer answers".
- `network_unreachable`, `tls_certificate_rejected`: no answer arrived. With
  the browser's report attached, the text names what kept the request from
  the server (see below).
- `transfer_failed`: the server answered but its answer cannot become a
  verified file; the reason says whether the download stopped early, cannot
  continue, or the file changed.
- `unexpected_media_response`, `hls_key_unusable`, `verification_*`: what
  arrived is not the file.
- `dash_unsupported`, `hls_encryption_unsupported`, `hls_live_unsupported`,
  `hls_layout_unsupported`, `codec_unsupported`, `manifest_malformed`,
  `manifest_too_large`, `unsupported_output`: limits of what the browser
  engine can assemble. `codec_unsupported` is a track whose declared codec
  the MP4 file cannot hold (for example ALAC sound in a demuxed stream); it
  is decided from the manifest, before anything is fetched.
- `private_network_target`: a page on the internet names a server inside the
  user's local network that the browser itself was not answered from for that
  tab (not requested; the hint says to start playback, because what the
  browser itself loads is saved), or a public name led to such a server
  (requested once, answer not used; the text says so and offers no retry).
- `browser_download_failed`: the browser refused the final save.
- `engine_stopped`, `engine_job_failed`: the browser ended the engine
  document, the save did not survive a worker restart, or the engine met an
  unexpected error. The save can be started again.
- `user_cancelled`: the user stopped the save. It ends as the neutral job
  phase `cancelled`, with no error, and is never shown as a failure.

When the failure carries the browser's report about savemedia's own request
(`browserDiagnostic`: error code, server address, redirect), `networkBlock`
in `packages/core/src/errors/network-block.ts` replaces the text with one of
these explanations: a public name at a local address, an untrusted
certificate, a certificate for another name or outside its dates, a secure
connection that could not be set up, a name that was not found, a failed
lookup, offline, a proxy, a browser policy, another extension, a firewall, or
a redirect to a web page. A plain connection failure (refused, reset, timed
out) and a code the module does not know replace nothing: the failure keeps
its own text, such as what arrived before a drop, and the browser's code is
a row under Technical details. The report is recorded
by `background/request-outcomes.ts`, which only reads request events, and is
attached to a check's failure in `background/capture.ts` and to a job's
failure in `background/router.ts`. The codes choose wording only: they never
change a request or a retry, and nothing is reached another way.

Partial stream outputs are aborted and discarded on required-part failure.

## User-facing text and announcements

- **One home per kind of text.** `JobError` failures: core
  `errors/messages.ts` and `errors/network-block.ts`. Everything else,
  including Local downloader failures and image refusals: extension
  `ui/text.ts`, `ui/toast-text.ts` (toast labels; it imports nothing so the
  page bridge stays small) and `util/transfer-progress.ts` (progress stages).
  Each file starts with the wording rules. A hint that points at one of the
  popup's controls has a second wording for the toast (`toastHint`), which
  says to open savemedia first.
- **One renderer.** `popup/components/FailureMessage.tsx` shows every failure
  and refusal: title, body and hint always visible, rows behind the
  **Technical details** disclosure, each value in an element of its own. A
  listed item's own facts (format, codecs, server) are behind a second
  disclosure with its own name, **About this video**.
- **Live regions.** The popup mounts exactly two, empty: a polite one and an
  alert (`popup/components/Announcer.tsx`). Text reaches them only for things
  that happen while the popup is open: a look at the page ended, a save
  started, a stage worth hearing began, a save finished, was cancelled or
  failed. What the popup already shows when it opens is rendered, not
  announced. The in-page toast is built the same way: its host stays in the
  page with two empty regions, and the visible card is hidden from assistive
  technology.
- **The toast.** The label says the state, the detail says the object. It is
  a manual popover, so it stays above a fullscreen player.
- **The toolbar button.** Its badge is the number of cards the popup lists,
  from the same selection. Its title names a running save in words. The
  popup's footer states no count.
- **The conscience line.** "Save only what you have the right to keep." is
  shown once, as static text in the popup footer, and nowhere else in the UI.

## Verification Strategy

The project treats downloader correctness as a media problem, not a "file was
created" problem.

- Unit tests cover classification, dispatch, retry classification, routing,
  popup error rendering, HLS runner behavior, and parser edge cases.
- E2E fixture server serves real tiny downloadable media generated by ffmpeg.
- Chromium e2e loads the unpacked extension, triggers real downloads, and runs
  `ffprobe` on the resulting files.
- Firefox runtime smoke uses Selenium WebDriver with a temporary Firefox
  extension install because Playwright extension loading is Chromium-only.
- Firefox Playwright fixture tests exercise only the fixture server and must not
  be counted as Firefox extension runtime support.

Any advertised protocol/container path needs a golden fixture plus a
playback/`ffprobe` assertion.
