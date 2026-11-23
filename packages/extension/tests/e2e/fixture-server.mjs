#!/usr/bin/env bun
/**
 * Minimal HTTP fixture server for Playwright e2e tests.
 *
 * Serves:
 *   /direct/clip.mp4 .webm .mkv  — tiny real progressive files (generate-base-fixtures.mjs)
 *   /file/31 and /file/32 — QuickTime originals with changing destinations
 *   /page/linked-31.html, /page/download-32.html — named file pages that declare
 *     their file link (a download attribute, or a plain link whose path is the
 *     named file), next to site controls savemedia must never operate
 *   /hls/master.m3u8 + media.m3u8 + segNNN.ts — real clear HLS VOD
 *   /hls-fmp4/master.m3u8 + media.m3u8 + EXT-X-MAP init + m4s fragments — clear fMP4
 *   /hls-fmp4-mp4/* .mp4-named init/fragments — verifies chunk suppression
 *   /hls-packed-audio/master.m3u8          — demuxed HLS, transport stream video and a packed
 *                                            audio rendition (bare AAC frames, an ID3 tag on each segment)
 *   /av-merge/master.m3u8 + EXT-X-MEDIA audio group + video/audio playlists
 *     + per-track init/m4s fragments — demuxed HLS for the a/v merge engine
 *   /hls-aes/key + master + media + ciphertext segments — AES-128 in the clear
 *   /hls-fairplay/*, /hls-sample-aes/*     — key tags a CDM owns, refused
 *   /hls-multi/, /hls-aes-multi/, /hls-fmp4-multi/ — three distinct one-second
 *     segments each, from EXT-X-MEDIA-SEQUENCE:7, the AES one without an IV
 *     attribute; the saved file is compared with these segments' frames
 *   /hls-single-file-fmp4/, /hls-single-file-ts/: one media file each, its
 *     three segments listed as byte ranges (EXT-X-BYTERANGE) that cover it
 *     from its first byte to its last; the file is requested once
 *   /dash/clip.mpd                         — clear DASH whose byte ranges leave a gap, refused
 *   /dash-clear/clip.mpd + init/chunks     — real clear DASH video+audio, downloads
 *   /dash-video-only/clip.mpd + init/chunks — real clear DASH with no audio, downloads
 *   /dash-single-file/clip.mpd, on-demand.mpd + one file per representation —
 *     real clear DASH kept in single files, described by byte ranges and by
 *     an index range; both download
 *   /dash-muxed/clip.mpd                   — clear DASH, one representation with video and audio together, downloads
 *   /direct/clip-dash-brand.mp4            — one fragmented MP4 under the "dash" brand
 *   /drm/widevine.mpd                      — DASH with Widevine ContentProtection
 *   /drm/clearkey.mpd                      — DASH with ClearKey refusal
 *   /low/clip.mp4                            — sub-720p video
 *   /negative/page.html, /negative/asset.{jpg,html,css,js,gif,png,mp3,m4a}
 *   /page/<scenario>.html                    — fixture HTML that links to the right asset
 *
 * Downloadable media bytes are intentionally tiny, but they are real
 * ffmpeg-generated containers so download e2e can verify playable output.
 */
import http from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.SAVEMEDIA_FIXTURE_PORT ?? 5174);
const here = dirname(fileURLToPath(import.meta.url));
const mediaRoot = join(here, "media-fixtures");

// A clear manifest the browser engine cannot assemble: its segments are byte
// ranges of one file that leave a gap, so they do not say what the whole
// file is and there is no address to fetch them one by one. Detection and
// the plain refusal only: the file itself is not served.
const DASH_MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4S" minBufferTime="PT1S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v1080" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028">
        <BaseURL>video.mp4</BaseURL>
        <SegmentList timescale="1" duration="2">
          <Initialization range="0-799"/>
          <SegmentURL mediaRange="800-49999"/>
          <SegmentURL mediaRange="60000-99999"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

// One representation that holds video and audio together, kept in one file:
// the manifest has no audio AdaptationSet, and the sound is in the video
// track's own bytes. The ranges are those of direct/clip-dash-brand.mp4,
// whose first index box follows its header (ftyp, moov) at byte 1249.
const DASH_MUXED_MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" mediaPresentationDuration="PT2S" minBufferTime="PT1S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="av" bandwidth="140000" width="320" height="180" codecs="avc1.42c00c,mp4a.40.2">
        <BaseURL>../direct/clip-dash-brand.mp4</BaseURL>
        <SegmentBase indexRange="1249-1300">
          <Initialization range="0-1248"/>
        </SegmentBase>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const WIDEVINE_MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <Representation id="v1080" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028"/>
    </AdaptationSet>
  </Period>
</MPD>`;

const CLEARKEY_MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e"/>
      <Representation id="v1080" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028"/>
    </AdaptationSet>
  </Period>
</MPD>`;

const HLS_FMP4_MP4_MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
media.m3u8
`;

const HLS_FMP4_MP4_MEDIA = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="title-init.mp4"
#EXTINF:2.000,
title-part-1.mp4
#EXTINF:2.000,
title-part-2.mp4
#EXT-X-ENDLIST
`;

function html(scenario, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><title>${scenario}</title></head><body>${body}</body></html>`;
}

function fixture(rel) {
  return readFileSync(join(mediaRoot, rel));
}

// A packager's one-file layout under HLS: each track is one fragmented MP4, and its playlist names the
// header and the parts by byte range and leaves the file's index (the sidx box between them) out. The
// files are the DASH single-file fixture's, where an on-demand manifest describes the same bytes.
const HLS_GAPS_MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Main",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="1",URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=143184,RESOLUTION=320x180,CODECS="avc1.42c00c,mp4a.40.2",AUDIO="audio"
video.m3u8
`;

const HLS_GAPS_VIDEO = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:1
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="/dash-single-file/clip-stream0.mp4",BYTERANGE="810@0"
#EXTINF:1.000,
#EXT-X-BYTERANGE:13605@874
/dash-single-file/clip-stream0.mp4
#EXTINF:1.000,
#EXT-X-BYTERANGE:13381
/dash-single-file/clip-stream0.mp4
#EXT-X-ENDLIST
`;

const HLS_GAPS_AUDIO = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:1
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="/dash-single-file/clip-stream1.mp4",BYTERANGE="768@0"
#EXTINF:1.000,
#EXT-X-BYTERANGE:4395@832
/dash-single-file/clip-stream1.mp4
#EXTINF:1.000,
#EXT-X-BYTERANGE:4498
/dash-single-file/clip-stream1.mp4
#EXT-X-ENDLIST
`;

// A clip joined in on the server before the video (EXT-X-DISCONTINUITY): the clock starts again at the joint.
// Both stretches are the three segments of the hls-multi fixture.
const HLS_DISCONTINUITY_MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=320x180,CODECS="avc1.42c00c,mp4a.40.2"
media.m3u8
`;

const HLS_DISCONTINUITY_MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-PLAYLIST-TYPE:VOD
${["", "#EXT-X-DISCONTINUITY\n"].map(joint => `${joint}${[7, 8, 9].map(n => `#EXTINF:1.000000,\n/hls-multi/seg00${n}.ts\n`).join("")}`).join("")}#EXT-X-ENDLIST
`;

// The three segments of the hls-multi fixture behind a server whose connection is gone for a while when the
// second segment is asked for: longer than a segment's own quick retries last.
const HLS_OUTAGE_MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-PLAYLIST-TYPE:VOD
${[7, 8, 9].map(n => `#EXTINF:1.000000,\n/hls-outage/seg00${n}.ts\n`).join("")}#EXT-X-ENDLIST
`;
/** Requests for the second segment that get no answer, counted since the request log was last cleared. */
const HLS_OUTAGE_REQUESTS = 7;

const HLS_FAIRPLAY_MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
media.m3u8
`;

// METHOD says AES-128, KEYFORMAT says the URI answers with a FairPlay
// licence. Not a key in the clear, so not ours to fetch.
const HLS_FAIRPLAY_MEDIA = `#EXTM3U
#EXT-X-VERSION:5
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-KEY:METHOD=AES-128,URI="skd://keys.test/fairplay",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"
#EXTINF:2.000000,
seg000.ts
#EXT-X-ENDLIST
`;

const HLS_SAMPLE_AES_MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
media.m3u8
`;

const HLS_SAMPLE_AES_MEDIA = `#EXTM3U
#EXT-X-VERSION:5
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://keys.test/sample",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:2.000000,
seg000.ts
#EXT-X-ENDLIST
`;

const TYPES = { mpd: "application/dash+xml", m3u8: "application/vnd.apple.mpegurl", ts: "video/mp2t", m4s: "video/iso.segment",
  mp4: "video/mp4", aac: "audio/aac", bin: "application/octet-stream" };

/**
 * A fixture that is a whole generated packaging (a manifest or playlist plus
 * its init and segment files) is served from its directory instead of being
 * listed file by file. The generators are scripts/generate-dash-fixtures.mjs
 * scripts/generate-hls-multi-fixtures.mjs and
 * scripts/generate-packed-audio-fixtures.mjs.
 */
function directoryRoutes(name) {
  return Object.fromEntries(
    readdirSync(join(mediaRoot, name))
      .filter(file => !file.startsWith("."))
      .map(file => [`/${name}/${file}`, { type: TYPES[file.split(".").pop()] ?? "application/octet-stream", body: fixture(`${name}/${file}`) }]),
  );
}

const routes = {
  // Direct files
  "/direct/clip.mp4":  { type: "video/mp4", body: fixture("direct/clip.mp4") },
  "/direct/clip.webm": { type: "video/webm", body: fixture("direct/clip.webm") },
  "/direct/clip.mkv":  { type: "video/x-matroska", body: fixture("direct/clip.mkv") },
  // One fragmented MP4 file under the "dash" brand. Regenerate with `bun scripts/generate-dash-fixtures.mjs brand-file`.
  "/direct/clip-dash-brand.mp4": { type: "video/mp4", body: fixture("direct/clip-dash-brand.mp4") },
  "/low/clip.mp4":     { type: "video/mp4", body: fixture("low/clip.mp4") },
  // WebM clips the main-video suite plays: the headless browser has no H.264
  // decoder. Regenerate with `bun scripts/generate-webm-fixtures.mjs`.
  "/low/clip.webm":    { type: "video/webm", body: fixture("low/clip.webm") },
  "/ads/creative.webm": { type: "video/webm", body: fixture("ads/creative.webm") },
  "/mse/clip.webm":    { type: "video/webm", body: fixture("mse/clip.webm") },
  // An inline VAST 4 response (page "preroll") and a VMAP that carries one (page "preroll-vmap"). The VMAP's
  // second break names a wrapper tag: that address is never to be requested, by the page or by savemedia.
  "/ads/vast.xml":     { type: "text/xml", body: Buffer.from(`<?xml version="1.0"?><VAST version="4.2"><Ad id="1"><InLine><AdSystem>fixture</AdSystem>
    <Creatives><Creative><Linear><Duration>00:00:02</Duration><MediaFiles>
      <MediaFile delivery="progressive" type="video/webm" width="160" height="90"><![CDATA[/ads/creative.webm]]></MediaFile>
    </MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>`) },
  "/ads/vmap.xml":     { type: "application/xml", body: Buffer.from(`<?xml version="1.0"?><vmap:VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap" version="1.0">
    <vmap:AdBreak timeOffset="start" breakType="linear"><vmap:AdSource><vmap:VASTAdData><VAST version="3.0"><Ad><InLine><Creatives><Creative><Linear>
      <MediaFiles><MediaFile type="video/webm"><![CDATA[/ads/creative.webm]]></MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>
    </vmap:VASTAdData></vmap:AdSource></vmap:AdBreak>
    <vmap:AdBreak timeOffset="end"><vmap:AdSource><vmap:AdTagURI><![CDATA[/ads/never-requested.xml]]></vmap:AdTagURI></vmap:AdSource></vmap:AdBreak></vmap:VMAP>`) },
  // An ad response that names the page's own main video as its media file.
  "/ads/names-main.xml": { type: "text/xml", body: Buffer.from(`<?xml version="1.0"?><VAST version="4.2"><Ad id="2"><InLine><AdSystem>fixture</AdSystem>
    <Creatives><Creative><Linear><Duration>00:00:02</Duration><MediaFiles>
      <MediaFile delivery="progressive" type="video/webm" width="640" height="360"><![CDATA[/direct/clip.webm]]></MediaFile>
    </MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>`) },
  // An HLS interstitial: the content playlist schedules an ad asset.
  "/hls-interstitial/media.m3u8": { type: "application/vnd.apple.mpegurl", body: Buffer.from(`#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:2
#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00Z
#EXT-X-DATERANGE:ID="ad1",CLASS="com.apple.hls.interstitial",START-DATE="2026-01-01T00:00:01Z",X-ASSET-URI="/ads/asset/media.m3u8",X-RESUME-OFFSET=0
#EXTINF:2.0,
/hls/seg000.ts
#EXT-X-ENDLIST
`) },
  "/ads/asset/media.m3u8": { type: "application/vnd.apple.mpegurl", body: Buffer.from("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\n/hls/seg000.ts\n#EXT-X-ENDLIST\n") },
  // Three feed posts whose playlists state 4, 8 and 12 seconds in two-second segments:
  // further apart than one segment, which is how exactly a player's duration can match.
  ...Object.fromEntries([1, 2, 3].map(n => [`/feed/${n}/media.m3u8`, { type: "application/vnd.apple.mpegurl",
    body: Buffer.from("#EXTM3U\n#EXT-X-TARGETDURATION:2\n" + "#EXTINF:2.0,\n/hls/seg000.ts\n".repeat(2 * n) + "#EXT-X-ENDLIST\n") }])),
  // Bytes that are not what their type says: nothing of these may reach the Downloads folder.
  "/pointer/fake.png":     { type: "image/png", body: Buffer.from("<!doctype html><html><body><h1>Sign in to continue</h1></body></html>") },
  "/pointer/setup.jpg":    { type: "image/jpeg", body: Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0, 0, 0, 0x04, 0, 0, 0, 0xff, 0xff]), Buffer.alloc(50), Buffer.from("PE\0\0")]) },
  "/pointer/archive.webp": { type: "image/webp", body: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0]), Buffer.alloc(40)]) },
  "/pointer/active.svg":   { type: "image/svg+xml", body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="teal"/><script>window.x=1</script></svg>') },
  "/pointer/plain.svg":    { type: "image/svg+xml", body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="teal"/></svg>') },
  "/file-exe.mov":         { type: "video/quicktime", body: Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(4096)]) },
  // A 1x1 PNG test card for the Alt+S pointer scenario.
  "/pointer/card.png": { type: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") },

  // HLS clear
  "/hls/master.m3u8":  { type: "application/vnd.apple.mpegurl", body: fixture("hls/master.m3u8") },
  "/hls/media.m3u8":   { type: "application/vnd.apple.mpegurl", body: fixture("hls/media.m3u8") },
  "/hls/seg000.ts":    { type: "video/mp2t", body: fixture("hls/seg000.ts") },
  "/transport/timed-id3.ts": { type: "video/mp2t", body: fixture("transport/timed-id3.ts") },
  "/transport/master.m3u8": { type: "application/vnd.apple.mpegurl", body: fixture("hls/master.m3u8") },
  "/transport/media.m3u8": { type: "application/vnd.apple.mpegurl",
    body: Buffer.from("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1.0,\ntimed-id3.ts\n#EXT-X-ENDLIST\n") },

  // HLS live/sliding-window refusal
  "/hls-live/master.m3u8": { type: "application/vnd.apple.mpegurl", body: Buffer.from(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
media.m3u8
`) },
  "/hls-live/media.m3u8": { type: "application/vnd.apple.mpegurl", body: Buffer.from(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:4.000,
seg000.ts
`) },
  "/hls-live/seg000.ts": { type: "video/mp2t", body: fixture("hls/seg000.ts") },

  // HLS fMP4
  "/hls-fmp4/master.m3u8": { type: "application/vnd.apple.mpegurl", body: fixture("hls-fmp4/master.m3u8") },
  "/hls-fmp4/media.m3u8":  { type: "application/vnd.apple.mpegurl", body: fixture("hls-fmp4/media.m3u8") },
  "/hls-fmp4/init.mp4":    { type: "video/mp4", body: fixture("hls-fmp4/init.mp4") },
  "/hls-fmp4/seg000.m4s":  { type: "video/iso.segment", body: fixture("hls-fmp4/seg000.m4s") },

  // HLS fMP4 with segment URLs that look like standalone .mp4 files.
  "/hls-fmp4-mp4/master.m3u8":    { type: "application/vnd.apple.mpegurl", body: Buffer.from(HLS_FMP4_MP4_MASTER) },
  "/hls-fmp4-mp4/media.m3u8":     { type: "application/vnd.apple.mpegurl", body: Buffer.from(HLS_FMP4_MP4_MEDIA) },
  // Two different parts of one stream, so a repeated, dropped or swapped part shows in the saved file.
  "/hls-fmp4-mp4/title-init.mp4":  { type: "video/mp4", body: fixture("hls-fmp4-multi/init.mp4") },
  "/hls-fmp4-mp4/title-part-1.mp4": { type: "video/mp4", body: fixture("hls-fmp4-multi/seg007.m4s") },
  "/hls-fmp4-mp4/title-part-2.mp4": { type: "video/mp4", body: fixture("hls-fmp4-multi/seg008.m4s") },

  // Demuxed HLS: video-only variant + EXT-X-MEDIA audio rendition
  "/av-merge/master.m3u8":     { type: "application/vnd.apple.mpegurl", body: fixture("av-merge/master.m3u8") },
  "/av-merge/video.m3u8":      { type: "application/vnd.apple.mpegurl", body: fixture("av-merge/video.m3u8") },
  "/av-merge/audio.m3u8":      { type: "application/vnd.apple.mpegurl", body: fixture("av-merge/audio.m3u8") },
  "/av-merge/video-init.mp4":  { type: "video/mp4", body: fixture("av-merge/video-init.mp4") },
  "/av-merge/audio-init.mp4":  { type: "video/mp4", body: fixture("av-merge/audio-init.mp4") },
  "/av-merge/video-seg000.m4s": { type: "video/iso.segment", body: fixture("av-merge/video-seg000.m4s") },
  "/av-merge/video-seg001.m4s": { type: "video/iso.segment", body: fixture("av-merge/video-seg001.m4s") },
  "/av-merge/audio-seg000.m4s": { type: "video/iso.segment", body: fixture("av-merge/audio-seg000.m4s") },
  "/av-merge/audio-seg001.m4s": { type: "video/iso.segment", body: fixture("av-merge/audio-seg001.m4s") },

  // HLS AES-128
  "/hls-aes/master.m3u8": { type: "application/vnd.apple.mpegurl", body: fixture("hls-aes/master.m3u8") },
  "/hls-aes/media.m3u8":  { type: "application/vnd.apple.mpegurl", body: fixture("hls-aes/media.m3u8") },
  "/hls-aes/key.bin":     { type: "application/octet-stream", body: fixture("hls-aes/key.bin") },
  "/hls-aes/seg000.ts":   { type: "video/mp2t", body: fixture("hls-aes/seg000.ts") },

  // Same ciphertext, but the key tags say a CDM holds the key. Both must be
  // refused as cdm_required, never fetched, never "decrypted".
  "/hls-fairplay/master.m3u8": { type: "application/vnd.apple.mpegurl", body: Buffer.from(HLS_FAIRPLAY_MASTER) },
  "/hls-fairplay/media.m3u8":  { type: "application/vnd.apple.mpegurl", body: Buffer.from(HLS_FAIRPLAY_MEDIA) },
  "/hls-fairplay/seg000.ts":   { type: "video/mp2t", body: fixture("hls-aes/seg000.ts") },
  "/hls-sample-aes/master.m3u8": { type: "application/vnd.apple.mpegurl", body: Buffer.from(HLS_SAMPLE_AES_MASTER) },
  "/hls-sample-aes/media.m3u8":  { type: "application/vnd.apple.mpegurl", body: Buffer.from(HLS_SAMPLE_AES_MEDIA) },
  "/hls-sample-aes/seg000.ts":   { type: "video/mp2t", body: fixture("hls-aes/seg000.ts") },

  // Multi-segment HLS and real DASH packagings.
  ...directoryRoutes("hls-multi"),
  ...directoryRoutes("hls-aes-multi"),
  ...directoryRoutes("hls-fmp4-multi"),
  ...directoryRoutes("hls-single-file-fmp4"),
  ...directoryRoutes("hls-single-file-ts"),
  // Demuxed HLS whose audio rendition is packed audio: bare AAC frames, each segment opening with an ID3 tag.
  ...directoryRoutes("hls-packed-audio"),
  ...directoryRoutes("dash-clear"),
  ...directoryRoutes("dash-video-only"),
  ...directoryRoutes("dash-single-file"),
  "/hls-outage/master.m3u8": { type: "application/vnd.apple.mpegurl", body: Buffer.from(HLS_DISCONTINUITY_MASTER) },
  "/hls-outage/media.m3u8":  { type: "application/vnd.apple.mpegurl", body: Buffer.from(HLS_OUTAGE_MEDIA) },
  "/hls-discontinuity/master.m3u8": { type: "application/vnd.apple.mpegurl", body: Buffer.from(HLS_DISCONTINUITY_MASTER) },
  "/hls-discontinuity/media.m3u8":  { type: "application/vnd.apple.mpegurl", body: Buffer.from(HLS_DISCONTINUITY_MEDIA) },
  // The same two files under HLS playlists whose byte ranges leave each file's index out.
  "/hls-single-file-gaps/master.m3u8": { type: "application/vnd.apple.mpegurl", body: Buffer.from(HLS_GAPS_MASTER) },
  "/hls-single-file-gaps/video.m3u8":  { type: "application/vnd.apple.mpegurl", body: Buffer.from(HLS_GAPS_VIDEO) },
  "/hls-single-file-gaps/audio.m3u8":  { type: "application/vnd.apple.mpegurl", body: Buffer.from(HLS_GAPS_AUDIO) },

  // DASH detection and refusal only: byte ranges with a gap. The file it names is not served.
  "/dash/clip.mpd":     { type: "application/dash+xml", body: Buffer.from(DASH_MPD) },
  // A representation with video and audio together, in the one file /direct/clip-dash-brand.mp4.
  "/dash-muxed/clip.mpd": { type: "application/dash+xml", body: Buffer.from(DASH_MUXED_MPD) },

  // DRM
  "/drm/widevine.mpd":  { type: "application/dash+xml", body: Buffer.from(WIDEVINE_MPD) },
  "/drm/clearkey.mpd":  { type: "application/dash+xml", body: Buffer.from(CLEARKEY_MPD) },

  // Negative
  "/negative/page.html":  { type: "text/html",        body: Buffer.from("<p>hi</p>") },
  "/negative/asset.jpg":  { type: "image/jpeg",       body: Buffer.alloc(64, 0xFF) },
  "/negative/asset.jpeg": { type: "image/jpeg",       body: Buffer.alloc(64, 0xFF) },
  "/negative/asset.png":  { type: "image/png",        body: Buffer.alloc(64, 0xFF) },
  "/negative/asset.gif":  { type: "image/gif",        body: Buffer.alloc(64, 0xFF) },
  "/negative/asset.css":  { type: "text/css",         body: Buffer.from("body { color: red; }") },
  "/negative/asset.js":   { type: "application/javascript", body: Buffer.from("// noop") },
  "/negative/asset.mp3":  { type: "audio/mpeg",       body: Buffer.alloc(64, 0x00) },
  "/negative/asset.m4a":  { type: "audio/mp4",        body: Buffer.alloc(64, 0x00) },
};

const quickTimeFiles = new Map([
  ["31", { body: fixture("direct/test-pattern.mov"), name: "Test pattern 31.mov", generation: 0 }],
  ["32", { body: fixture("direct/color-bars.mov"), name: "Färbige Balken 32.mov", generation: 0 }],
]);

function serveFilePageMedia(req, res, path) {
  if (path === "/file-info/31") {
    const { generation } = quickTimeFiles.get("31");
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      .end(JSON.stringify({ url: `/signed-movie.mov?file=31&token=${generation}` }));
    return true;
  }
  // A trailing segment names the file; it reaches the same changing destination.
  const entry = /^\/file\/(31|32)(?:\/[^/]+)?$/.exec(path)?.[1];
  if (entry) {
    const item = quickTimeFiles.get(entry);
    if (req.method === "POST") {
      item.generation++;
      res.writeHead(204).end();
    } else {
      res.writeHead(302, {
        Location: `/file-media/${entry}/${item.generation}`,
        "Cache-Control": "no-store",
      }).end();
    }
    return true;
  }
  const redirectTarget = /^\/file-media\/(31|32)\/(\d+)$/.exec(path);
  const signed = path === "/signed-movie.mov" ? new URL(req.url, "http://localhost").searchParams : null;
  const id = redirectTarget?.[1] ?? signed?.get("file");
  const version = redirectTarget?.[2] ?? signed?.get("token");
  const item = quickTimeFiles.get(id);
  if (item) {
    if (String(item.generation) !== version) {
      res.writeHead(403).end();
    } else {
      // Full response with no range validator. The URL has no file suffix.
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": id === "32"
          ? `attachment; filename*=UTF-8'en'${encodeURIComponent(item.name)}`
          : "attachment; filename=\"\"; filename*=UTF-8''",
        "Content-Length": item.body.length,
        "Cache-Control": "no-store",
      }).end(item.body);
    }
    return true;
  }
  if (path === "/file-warning.mov" || path === "/file-data.mov") {
    if (req.headers.range) {
      // A valid partial probe without a validator forces a whole-file request.
      const file = quickTimeFiles.get("31").body;
      const prefix = file.subarray(0, 4096);
      res.writeHead(206, { "Content-Type": "video/quicktime",
        "Content-Range": `bytes 0-${prefix.length - 1}/${file.length}` }).end(prefix);
      return true;
    }
    const body = path === "/file-warning.mov"
      ? '<?xml version="1.0"?><html><body>Network access warning</body></html>'
      : JSON.stringify({ message: "Preparing the file" }).padEnd(69);
    // Both substitutes deliberately claim to be a video.
    res.writeHead(200, { "Content-Type": "video/quicktime", "Cache-Control": "no-store" }).end(body);
    return true;
  }
  return false;
}

// Each named page declares its file: linked-31 with a download attribute,
// download-32 with a plain link whose path is the named file. The labelled
// controls beside them count clicks: savemedia must never press them.
const siteControls = `<script>
  window.siteControlClicks = 0;
  for (const control of document.querySelectorAll("[data-site-control]")) {
    control.addEventListener("click", event => { event.preventDefault(); window.siteControlClicks++; location.href = "/file/32"; });
  }
</script>`;
const pages = {
  "linked-31": html("Test pattern", `<main><h1>${quickTimeFiles.get("31").name}</h1>
    <video src="/page/file-data.html" controls></video>
    <a href="/file/31" download>Download</a></main>
    <aside><a href="/page/download-32.html" data-site-control>Download</a></aside>${siteControls}`),
  "download-32": html(quickTimeFiles.get("32").name, `<h1>${quickTimeFiles.get("32").name}</h1>
    <button type="button" data-site-control>Download</button><a href="#" data-site-control>Download</a>
    <a href="/file/32/${encodeURIComponent(quickTimeFiles.get("32").name)}">Save the original file</a>${siteControls}`),
  "file-31": html("Test pattern", `<h1>Test pattern 31.mov</h1><script>
    fetch("/file-info/31").then(response => response.json()).then(({ url }) => {
      const player = document.createElement("video");
      player.controls = true;
      player.src = url;
      document.body.append(player);
    });
  </script>`),
  "file-32": html("Color bars", `<video controls></video><script>
    fetch("/file/32").then(response => response.blob())
      .then(blob => document.querySelector("video").src = URL.createObjectURL(blob))
  </script>`),
  "file-warning": html("Warning response", '<video controls src="/file-warning.mov"></video>'),
  "file-data": html("Nonvideo response", '<video controls src="/file-data.mov"></video>'),
  direct: html("direct", `<video src="/direct/clip.mp4" controls width="640"></video>`),
  "direct-mkv": html("direct-mkv", `<video src="/direct/clip.mkv" controls width="640"></video>`),
  hls: html("hls", `<script>fetch("/hls/master.m3u8");</script><p>hls fixture</p>`),
  "hls-live": html("hls-live", `<script>fetch("/hls-live/master.m3u8");</script><p>hls live fixture</p>`),
  "hls-fmp4": html("hls-fmp4", `<script>
    fetch("/hls-fmp4/master.m3u8");
    fetch("/hls-fmp4/init.mp4").catch(() => {});
    fetch("/hls-fmp4/seg000.m4s").catch(() => {});
  </script><p>hls fmp4 fixture</p>`),
  "hls-fmp4-mp4": html("hls-fmp4-mp4", `<script>
    fetch("/hls-fmp4-mp4/master.m3u8");
    fetch("/hls-fmp4-mp4/media.m3u8");
    fetch("/hls-fmp4-mp4/title-init.mp4").catch(() => {});
    fetch("/hls-fmp4-mp4/title-part-1.mp4").catch(() => {});
    fetch("/hls-fmp4-mp4/title-part-2.mp4").catch(() => {});
  </script><p>hls fmp4 mp4-named fragment fixture</p>`),
  "hls-packed-audio": html("hls-packed-audio", `<script>fetch("/hls-packed-audio/master.m3u8");</script><p>demuxed hls fixture, packed audio rendition</p>`),
  "av-merge": html("av-merge", `<script>fetch("/av-merge/master.m3u8");</script><p>demuxed hls av-merge fixture</p>`),
  "embedded-hls": html("embedded-hls", `<script>
    window.__savemediaFixture = {"stream":{"url":"\\/hls\\/master.m3u8","urls":{"1080p":"\\/hls-fmp4\\/master.m3u8"}}};
  </script><p>embedded hls fixture</p>`),
  "main-player-qualities": html("main-player-qualities", `<script type="application/json">
    {"sources":[{"src":"/low/clip.mp4","label":"480p"},{"src":"/direct/clip.mp4","label":"720p"}]}
  </script>${Array.from({ length: 20 }, (_, n) =>
    `<video hidden preload="none" src="/direct/clip.mp4?preview=${n}"></video><a href="/direct/clip.mp4?linked=${n}">Preview</a>`).join("")}`),
  "hls-aes": html("hls-aes", `<script>fetch("/hls-aes/master.m3u8");</script><p>hls-aes fixture</p>`),
  "hls-fairplay": html("hls-fairplay", `<script>fetch("/hls-fairplay/master.m3u8");fetch("/hls-fairplay/media.m3u8");</script><p>hls fairplay fixture</p>`),
  "hls-sample-aes": html("hls-sample-aes", `<script>fetch("/hls-sample-aes/master.m3u8");fetch("/hls-sample-aes/media.m3u8");</script><p>hls sample-aes fixture</p>`),
  "hls-multi": html("hls-multi", `<script>fetch("/hls-multi/master.m3u8");</script><p>three-segment hls fixture</p>`),
  "hls-aes-multi": html("hls-aes-multi", `<script>fetch("/hls-aes-multi/master.m3u8");</script><p>three-segment hls-aes fixture</p>`),
  "hls-fmp4-multi": html("hls-fmp4-multi", `<script>fetch("/hls-fmp4-multi/master.m3u8");</script><p>three-segment hls fmp4 fixture</p>`),
  "hls-single-file-fmp4": html("hls-single-file-fmp4", `<script>fetch("/hls-single-file-fmp4/master.m3u8");</script><p>hls fixture, one fmp4 file listed as byte ranges</p>`),
  "hls-single-file-ts": html("hls-single-file-ts", `<script>fetch("/hls-single-file-ts/master.m3u8");</script><p>hls fixture, one transport stream file listed as byte ranges</p>`),
  dash: html("dash", `<script>fetch("/dash/clip.mpd");</script><p>byte-range dash fixture</p>`),
  "dash-video-only": html("dash-video-only", `<script>fetch("/dash-video-only/clip.mpd");</script><p>clear dash fixture without audio</p>`),
  "dash-clear": html("dash-clear", `<script>fetch("/dash-clear/clip.mpd");</script><p>clear dash video+audio fixture</p>`),
  "hls-outage": html("hls-outage", `<script>fetch("/hls-outage/master.m3u8");</script><p>hls fixture, the connection is gone for a while at the second segment</p>`),
  "hls-discontinuity": html("hls-discontinuity", `<script>fetch("/hls-discontinuity/master.m3u8");</script><p>hls fixture, a clip joined in before the video: the clock starts again</p>`),
  "hls-single-file-gaps": html("hls-single-file-gaps", `<script>fetch("/hls-single-file-gaps/master.m3u8");</script><p>demuxed hls fixture, one fmp4 file per track, byte ranges that leave the index out</p>`),
  "dash-single-file": html("dash-single-file", `<script>fetch("/dash-single-file/clip.mpd");</script><p>clear dash fixture, one file per track, listed as byte ranges</p>`),
  "dash-on-demand": html("dash-on-demand", `<script>fetch("/dash-single-file/on-demand.mpd");</script><p>clear dash fixture, one file per track, with an index range</p>`),
  "dash-muxed": html("dash-muxed", `<script>fetch("/dash-muxed/clip.mpd");</script><p>clear dash fixture, one representation with video and audio together</p>`),
  "dash-brand-file": html("dash-brand-file", `<video src="/direct/clip-dash-brand.mp4" controls width="640"></video>`),
  widevine: html("widevine", `<script>fetch("/drm/widevine.mpd");</script><p>widevine fixture</p>`),
  clearkey: html("clearkey", `<script>fetch("/drm/clearkey.mpd");</script><p>clearkey fixture</p>`),
  negative: html("negative", `<img src="/negative/asset.jpg"><img src="/negative/asset.jpeg"><img src="/negative/asset.png"><iframe src="/negative/page.html"></iframe><link rel="stylesheet" href="/negative/asset.css"><script src="/negative/asset.js"></script><audio src="/negative/asset.mp3" controls></audio><a href="/negative/asset.m4a">audio</a>`),
  low: html("low", `<video src="/low/clip.mp4" controls></video>`),
  // Two players and an image. The second player's video ignores the pointer
  // under a controls layer with a poster and a play button image, as many
  // players arrange it.
  pointer: html("pointer", `<style>
    .tile { position: relative; display: inline-block; width: 320px; height: 180px; margin: 8px; }
    .tile video, .tile img { display: block; width: 320px; height: 180px; }
    .controls { position: absolute; inset: 0; background: url("/pointer/card.png") center / cover; }
    .controls img { position: absolute; left: 128px; top: 58px; width: 64px; height: 64px; }
  </style>
  <div class="tile"><video src="/direct/clip.mp4" muted></video></div>
  <div class="tile"><video src="/low/clip.mp4" muted style="pointer-events: none"></video><div class="controls"><img src="/pointer/card.png" alt="Play"></div></div>
  <div class="tile"><img id="card" src="/pointer/card.png" alt="Test card"></div>`),
};

// ---- Main-video and hard-layout fixtures ----
// The pages observe themselves: clicks no user made, and media events no test caused.
const instrument = `<script>
  window.__untrusted = 0; window.__mediaEvents = [];
  document.addEventListener("click", event => { if (!event.isTrusted) window.__untrusted++; }, true);
  for (const type of ["play", "pause", "volumechange", "seeking", "ratechange"]) {
    document.addEventListener(type, () => window.__mediaEvents.push(type), true);
  }
</script>`;
const bare = `<style>html, body { margin: 0; } video, canvas, iframe { display: block; }</style>`;
const local = `http://localhost:${port}`;
const loopback = `http://127.0.0.1:${port}`;
/** Fetch an ad document (VAST, or a VMAP that carries one) as a player does, then play its first creative in the given element. */
const playAd = (id, wait = 400, tag = "/ads/vast.xml") => `<script>
  fetch("${tag}", { headers: { "x-fixture-page": "ad" } }).then(response => response.text()).then(text => {
    const file = new DOMParser().parseFromString(text, "text/xml").querySelector("MediaFile").textContent.trim();
    setTimeout(() => { const video = document.getElementById("${id}"); video.src = file; video.play().catch(() => {}); window.__adStarted = true; }, ${wait});
  });
</script>`;
const drawTo = (canvas, video) => `(function draw() { const c = ${canvas}; try { c.getContext("2d").drawImage(${video}, 0, 0, c.width, c.height); } catch {} requestAnimationFrame(draw); })();`;

Object.assign(pages, {
  "player-webm": html("player", `${bare}<video id="v" controls src="/direct/clip.webm" width="640" height="360"></video>`),
  "banner": html("banner", `${bare}<img src="/pointer/card.png" style="width:640px;height:90px;display:block" alt="Banner">`),
  "webm": html("webm", `${bare}${instrument}<video id="v" controls src="/direct/clip.webm" width="640" height="360"></video>
    <script>window.__keys = []; addEventListener("keydown", event => setTimeout(() => window.__keys.push({ code: event.code, ctrl: event.ctrlKey, alt: event.altKey, prevented: event.defaultPrevented })));</script>`),
  // Pre-roll: the content player plays the ad first; its own data declares the content.
  "preroll": html("preroll", `${bare}${instrument}<div id="player" data-setup='{"sources":[{"src":"/hls/master.m3u8","type":"application/x-mpegURL"}]}'>
    <video id="v" muted loop playsinline width="640" height="360"></video></div>${playAd("v")}`),
  // The same pre-roll announced by a VMAP: its first break carries the VAST, its second names a wrapper tag
  // (/ads/never-requested.xml) that the page never follows. Nobody may request that address.
  "preroll-vmap": html("preroll-vmap", `${bare}${instrument}<div id="player" data-setup='{"sources":[{"src":"/hls/master.m3u8","type":"application/x-mpegURL"}]}'>
    <video id="v" muted loop playsinline width="640" height="360"></video></div>${playAd("v", 400, "/ads/vmap.xml")}`),
  // The page's only video, which an ad response of the page names as its media file before the page plays it.
  "ad-names-main": html("ad-names-main", `${bare}${instrument}<video id="v" muted loop playsinline width="640" height="360"></video>
    <script>
      fetch("/ads/names-main.xml", { headers: { "x-fixture-page": "ad" } }).then(response => response.text()).then(() => setTimeout(() => {
        const video = document.getElementById("v"); video.src = "/direct/clip.webm"; video.play().catch(() => {}); window.__adStarted = true;
      }, 400));
    </script>`),
  // A small ad video on the page, and the real player in a frame of another origin.
  "outstream-frame": html("outstream-frame", `${bare}<video id="ad" muted loop playsinline width="160" height="90"></video>
    <iframe id="player" width="640" height="360" style="border:0" src="${local}/page/player-webm.html"></iframe>${playAd("ad")}`),
  // A banner frame of another origin lies over the bottom of the player.
  "ad-overlay-frame": html("ad-overlay-frame", `${bare}<div style="position:relative;width:640px;height:360px">
    <video id="v" src="/direct/clip.webm" width="640" height="360"></video>
    <iframe id="banner" src="${local}/page/banner.html" style="position:absolute;left:0;top:270px;width:640px;height:90px;border:0"></iframe></div>`),
  // The mirror image: the page's own banner image lies over the bottom of a player in a frame of another origin.
  "banner-over-frame": html("banner-over-frame", `${bare}<div style="position:relative;width:640px;height:360px">
    <iframe id="player" src="${local}/page/player-webm.html" width="640" height="360" style="border:0"></iframe>
    <img id="banner" src="/pointer/card.png" alt="Banner" style="position:absolute;left:0;top:270px;width:640px;height:90px"></div>`),
  // A frame of another origin with a video of its own that dispatches pointer events on a timer, as an ad
  // frame could to draw Alt+S to itself. The user's pointer is over the page's video.
  "forged-pointer-frame": html("forged-pointer-frame", `${bare}<video id="other" controls src="/low/clip.webm" width="320" height="180"></video>
    <script>
      window.__forged = 0;
      setInterval(() => {
        for (const type of ["pointerover", "pointermove"]) {
          const event = new PointerEvent(type, { clientX: 100, clientY: 90, bubbles: true });
          window.dispatchEvent(event);
          document.getElementById("other").dispatchEvent(new PointerEvent(type, { clientX: 100, clientY: 90, bubbles: true }));
        }
        window.__forged += 1;
      }, 30);
    </script>`),
  "forged-pointer": html("forged-pointer", `${bare}<video id="v" controls src="/direct/clip.webm" width="640" height="360"></video>
    <iframe id="other" width="320" height="180" style="border:0" src="${local}/page/forged-pointer-frame.html"></iframe>`),
  // A page that plays nothing and tells savemedia's bridge that it does, as any page or frame can.
  "forged-capture": html("forged-capture", `${bare}<p>Nothing plays here.</p>
    <script>
      const forged = [location.origin + "/low/clip.webm?forged=1", "${local}/direct/clip.webm?forged=2"];
      for (const url of forged) window.postMessage({ __savemedia: true, kind: "media-source", url, pageUrl: location.href }, "*");
      window.__forged = forged.length;
    </script>`),
  "canvas-mirror": html("canvas-mirror", `${bare}<div id="player"><video id="src" src="/direct/clip.webm" muted loop playsinline style="display:none"></video>
    <canvas id="c" width="320" height="180"></canvas></div>
    <script>const v = document.getElementById("src"); v.play().catch(() => {}); ${drawTo('document.getElementById("c")', "v")}</script>`),
  "canvas-child": html("canvas-child", `${bare}<canvas id="c" width="320" height="180"><video id="src" src="/low/clip.webm" muted loop playsinline></video></canvas>
    <script>const v = document.getElementById("src"); v.play().catch(() => {}); ${drawTo('document.getElementById("c")', "v")}</script>`),
  // The video is never attached to the document: only its requests show it.
  "canvas-unattached": html("canvas-unattached", `${bare}<canvas id="c" width="320" height="180"></canvas>
    <script>const v = document.createElement("video"); v.muted = true; v.loop = true; v.src = "/direct/clip.webm"; v.play().catch(() => {});
      ${drawTo('document.getElementById("c")', "v")}</script>`),
  // The same player with its controls above the canvas: a play button drawn as a background image, and a logo.
  "canvas-unattached-control": html("canvas-unattached-control", `${bare}<div style="position:relative;width:320px;height:180px">
    <canvas id="c" width="320" height="180"></canvas>
    <button id="play" type="button" aria-label="Play" style="position:absolute;left:40px;top:50px;width:80px;height:80px;border:0;background:url(/pointer/card.png) center / cover"></button>
    <img id="logo" alt="" src="/pointer/card.png" style="position:absolute;left:200px;top:50px;width:80px;height:80px"></div>
    <script>const v = document.createElement("video"); v.muted = true; v.loop = true; v.src = "/direct/clip.webm"; v.play().catch(() => {});
      ${drawTo('document.getElementById("c")', "v")}</script>`),
  // A page that names a Matroska file and plays a short MP4 preview of it. The file itself is behind a script-only button.
  "named-preview": html("Holiday.Trip.2024.1080p.mkv", `${bare}<video id="v" src="/direct/clip.mp4" muted autoplay loop playsinline width="640" height="360"></video>
    <h1>Holiday.Trip.2024.1080p.mkv</h1><button id="get" type="button">Download</button>`),
  // A canvas that draws a video the page never attaches, and a muted teaser playing in a video element next to it.
  "canvas-unattached-teaser": html("canvas-unattached-teaser", `${bare}<canvas id="c" width="320" height="180"></canvas>
    <video id="teaser" src="/low/clip.webm" muted autoplay loop playsinline width="320" height="180" style="margin-top:20px"></video>
    <script>const v = document.createElement("video"); v.muted = true; v.loop = true; v.src = "/direct/clip.webm"; v.play().catch(() => {});
      ${drawTo('document.getElementById("c")', "v")}</script>`),
  "canvas-two": html("canvas-two", `${bare}<div id="one"><video src="/direct/clip.webm" muted loop playsinline style="display:none"></video><canvas width="320" height="180"></canvas></div>
    <div id="two" style="margin-top:20px"><video src="/low/clip.webm" muted loop playsinline style="display:none"></video><canvas width="320" height="180"></canvas></div>
    <script>for (const player of document.querySelectorAll("div")) { const v = player.querySelector("video"); v.play().catch(() => {});
      ${drawTo('player.querySelector("canvas")', "v")} }</script>`),
  // A chart drawn over a photo: the canvas is what the user sees, the photo is not the target.
  "canvas-chart": html("canvas-chart", `${bare}<div style="position:relative;width:320px;height:180px"><img id="photo" src="/pointer/card.png" width="320" height="180" alt="Photo">
    <canvas id="chart" width="320" height="180" style="position:absolute;left:0;top:0"></canvas></div>
    <script>const g = document.getElementById("chart").getContext("2d"); g.fillStyle = "rgba(200,0,0,.5)"; g.fillRect(20, 20, 120, 90);</script>`),
  "image-verify": html("image-verify", `<style>img { display: block; margin: 4px; }</style>
    <img id="fake" src="/pointer/fake.png" width="100" height="100" alt="Fake"><img id="setup" src="/pointer/setup.jpg" width="100" height="100" alt="Setup">
    <img id="archive" src="/pointer/archive.webp" width="100" height="100" alt="Archive"><img id="active" src="/pointer/active.svg" width="100" height="100" alt="Active">
    <img id="plain" src="/pointer/plain.svg" width="100" height="100" alt="Plain">`),
  "file-exe": html("file-exe", `<video controls src="/file-exe.mov" width="640" height="360"></video>`),
  // The source is assigned only after the user's own click.
  "gate": html("gate", `${bare}${instrument}<video id="v" controls preload="none" width="640" height="360"></video>
    <button id="start" type="button">Play</button><script>document.getElementById("start").onclick = () => { document.getElementById("v").src = "/direct/clip.webm"; };</script>`),
  // The same gate, in a player container whose data names a playlist its server no longer answers (522).
  "gate-stale": html("gate-stale", `${bare}${instrument}<div id="player" data-config='{"sources":[{"src":"/unavailable/master.m3u8","type":"application/x-mpegURL"}]}'>
    <video id="v" controls preload="none" width="640" height="360"></video></div>
    <button id="start" type="button">Play</button><script>document.getElementById("start").onclick = () => { document.getElementById("v").src = "/direct/clip.webm"; };</script>`),
  // A fake paywall over a video whose source is already set.
  "paywall": html("paywall", `${bare}${instrument}<div style="position:relative;width:640px;height:360px">
    <video id="v" src="/direct/clip.webm" width="640" height="360"></video>
    <div id="wall" style="position:absolute;inset:0;backdrop-filter:blur(8px);background:rgba(0,0,0,.6)">
      <button id="unlock" type="button">Click 3 times to unlock</button></div></div>
    <script>window.__unlockClicks = 0; document.getElementById("unlock").onclick = () => { window.__unlockClicks++; };</script>`),
  "named-no-link": html("named-no-link", `<h1>Talk 7.mov</h1><button type="button">Download</button>`),
  // A route change inside the page swaps the player's file.
  "spa": html("spa", `${bare}<video id="v" controls muted playsinline width="640" height="360" src="/direct/clip.webm"></video>
    <script>
      const v = document.getElementById("v");
      window.go = n => { history.pushState({}, "", "?v=" + n); v.src = "/low/clip.webm"; };
      window.navigateTo = n => {
        navigation.addEventListener("navigate", event => event.intercept({ handler: async () => { v.src = "/direct/clip.webm"; } }), { once: true });
        return navigation.navigate("?v=" + n).finished;
      };
    </script>`),
  "shadow-open": html("shadow-open", `${bare}<x-player mode="open"></x-player>`),
  "shadow-closed": html("shadow-closed", `${bare}<x-player mode="closed"></x-player>`),
  "srcdoc-player": html("srcdoc-player", `${bare}<iframe id="f" width="640" height="360" style="border:0"
    srcdoc='<body style="margin:0"><video controls src="${loopback}/direct/clip.webm" width="640" height="360" style="display:block"></video></body>'></iframe>`),
  "about-blank-player": html("about-blank-player", `${bare}<iframe id="f" width="640" height="360" style="border:0"></iframe>
    <script>const d = document.getElementById("f").contentDocument; d.open();
      d.write('<body style="margin:0"><video controls src="${loopback}/low/clip.webm" width="640" height="360" style="display:block"></video></body>'); d.close();</script>`),
  "nested-frames": html("nested-frames", `${bare}<iframe id="mid" width="700" height="420" style="border:0" src="${local}/page/nested-mid.html"></iframe>`),
  "nested-mid": html("nested-mid", `${bare}<iframe id="inner" width="640" height="360" style="border:0;margin:20px" src="${loopback}/page/player-webm.html"></iframe>`),
  // Asking what the browser could play is no proof of protected media.
  "eme-probe": html("eme-probe", `${bare}<video id="v" controls src="/direct/clip.webm" width="640" height="360"></video>
    <script>const config = [{ initDataTypes: ["webm"], videoCapabilities: [{ contentType: 'video/webm; codecs="vp8"' }] }];
      Promise.allSettled([navigator.requestMediaKeySystemAccess("com.widevine.alpha", config), navigator.requestMediaKeySystemAccess("org.w3.clearkey", config)])
        .then(() => { window.__probed = true; });</script>`),
  // Keys attached to a clear video: still no proof.
  "eme-attached": html("eme-attached", `${bare}<video id="v" controls src="/direct/clip.webm" width="640" height="360"></video>
    <script>navigator.requestMediaKeySystemAccess("org.w3.clearkey", [{ initDataTypes: ["webm"], videoCapabilities: [{ contentType: 'video/webm; codecs="vp8"' }] }])
      .then(access => access.createMediaKeys()).then(keys => document.getElementById("v").setMediaKeys(keys)).then(() => { window.__attached = true; }, error => { window.__emeError = String(error); });</script>`),
  // A licence request through the element's keys: that is key use.
  "eme-keyed": html("eme-keyed", `${bare}<video id="v" controls src="/direct/clip.webm" width="640" height="360"></video>
    <script>navigator.requestMediaKeySystemAccess("org.w3.clearkey", [{ initDataTypes: ["keyids", "webm"], videoCapabilities: [{ contentType: 'video/webm; codecs="vp8"' }] }])
      .then(access => access.createMediaKeys()).then(async keys => {
        await document.getElementById("v").setMediaKeys(keys);
        await keys.createSession().generateRequest("keyids", new TextEncoder().encode('{"kids":["LwVHf8JLtPrv2GUXFW2v_A"]}'));
        window.__requested = true;
      }).catch(error => { window.__emeError = String(error); });</script>`),
  // A player that makes its video element only on the user's click. Until then the page shows a poster, which
  // its metadata declares as the still of a video that it names by an embed page.
  // A player page: it declares itself a video (og:type), names an embed page as its og:video, and its poster as og:image.
  "lazy-poster": `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><title>lazy-poster</title>
    <meta property="og:type" content="video.other">
    <meta property="og:video" content="${loopback}/page/player-webm.html"><meta property="og:video:type" content="text/html">
    <meta property="og:image" content="${loopback}/pointer/card.png"></head>
    <body>${bare}${instrument}<div id="player" style="position:relative;width:640px;height:360px">
      <img id="poster" src="/pointer/card.png" alt="Poster" style="display:block;width:640px;height:360px">
      <button id="start" type="button" style="position:absolute;left:290px;top:160px">Play</button></div>
    <script>document.getElementById("start").onclick = () => {
      const video = document.createElement("video");
      video.id = "v"; video.controls = true; video.width = 640; video.height = 360;
      video.src = "/direct/clip.webm";
      document.getElementById("player").replaceChildren(video);
    };</script></body></html>`,
  // An article with a video further down: the same og:video and og:image as a player page, and the og:image is its lead photo.
  "article-embed": `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><title>article-embed</title>
    <meta property="og:type" content="article">
    <meta property="og:video" content="${loopback}/page/player-webm.html"><meta property="og:video:type" content="text/html">
    <meta property="og:image" content="${loopback}/pointer/card.png"></head>
    <body>${bare}<article><img id="hero" src="/pointer/card.png" alt="Lead photo" style="display:block;width:640px;height:360px">
      <p style="height:900px">An article with a video further down.</p>
      <iframe id="player" width="640" height="360" style="border:0" src="${local}/page/player-webm.html"></iframe></article></body></html>`,
  // Metadata that names an embed page as the video, next to a working player in a frame.
  "og-embed": `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><title>og-embed</title>
    <meta property="og:video" content="${loopback}/page/player-webm.html"><meta property="og:video:type" content="video/mp4"></head>
    <body>${bare}<iframe id="player" width="640" height="360" style="border:0" src="${local}/page/player-webm.html"></iframe></body></html>`,
  "live-and-vod": html("live-and-vod", `${bare}<video id="v" controls src="/direct/clip.webm" width="640" height="360"></video>
    <script>fetch("/hls-live/master.m3u8").then(() => fetch("/hls-live/media.m3u8")).then(() => { window.__liveFetched = true; });</script>`),
  // A page that fetches a whole video file with a script and plays it from memory. The answer has a video type
  // and no attachment header, and the player's own address is a blob: address.
  "fetch-blob": html("fetch-blob", `${bare}<video id="v" muted loop playsinline width="640" height="360"></video><script>
    fetch("/direct/clip.mp4", { headers: { "x-fixture-page": "fetch-blob" } }).then(response => response.blob()).then(blob => {
      const video = document.getElementById("v");
      video.src = URL.createObjectURL(blob);
      return video.play();
    }).catch(() => {});
  </script>`),
  // A player that is fed piece by piece, with no playlist: its init section and fragments are fetched as video/mp4.
  "mse-pieces": html("mse-pieces", `${bare}<video id="v" muted playsinline width="640" height="360"></video><script>
    document.getElementById("v").src = URL.createObjectURL(new MediaSource());
    Promise.all(["title-init.mp4", "title-part-1.mp4", "title-part-2.mp4"].map(name =>
      fetch("/hls-fmp4-mp4/" + name, { headers: { "x-fixture-page": "pieces" } }).then(response => response.arrayBuffer())))
      .then(() => { window.__piecesFetched = true; });
  </script>`),
  // Three posts, each played through MediaSource and each with a playlist of its own.
  "mse-feed": html("mse-feed", `${bare}<style>video { margin-bottom: 700px; }</style>
    ${[1, 2, 3].map(n => `<video id="p${n}" muted playsinline width="640" height="360"></video>`).join("")}
    <script>
      window.__mse = typeof MediaSource === "function" && MediaSource.isTypeSupported('video/webm; codecs="vp8"');
      async function post(n) {
        const video = document.getElementById("p" + n);
        const source = new MediaSource();
        video.src = URL.createObjectURL(source);
        await new Promise(resolve => source.addEventListener("sourceopen", resolve, { once: true }));
        const buffer = source.addSourceBuffer('video/webm; codecs="vp8"');
        buffer.appendBuffer(await (await fetch("/mse/clip.webm", { headers: { "x-fixture-page": "mse" } })).arrayBuffer());
        await new Promise(resolve => buffer.addEventListener("updateend", resolve, { once: true }));
        source.duration = 4 * n;
        await fetch("/feed/" + n + "/media.m3u8", { headers: { "x-fixture-page": "mse" } });
      }
      if (window.__mse) Promise.all([1, 2, 3].map(post)).then(() => { window.__feedReady = true; }, error => { window.__feedError = String(error); });
    </script>`),
  "hls-interstitial": html("hls-interstitial", `<p>interstitial fixture</p><script>
    fetch("/hls-interstitial/media.m3u8", { headers: { "x-fixture-page": "player" } }).then(response => response.text())
      .then(() => new Promise(resolve => setTimeout(resolve, 500)))
      .then(() => fetch("/ads/asset/media.m3u8", { headers: { "x-fixture-page": "player" } })).then(() => { window.__assetFetched = true; });
  </script>`),
});
const shadowPlayer = `<script>customElements.define("x-player", class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: this.getAttribute("mode") });
    root.innerHTML = '<video controls muted autoplay loop playsinline src="/direct/clip.webm" width="640" height="360" style="display:block"></video>';
  }
});</script>`;
pages["shadow-open"] = pages["shadow-open"].replace("</body>", shadowPlayer + "</body>");
pages["shadow-closed"] = pages["shadow-closed"].replace("</body>", shadowPlayer + "</body>");

pages["transport"] = html("transport", '<video controls preload="none" src="/transport/timed-id3.ts"></video>');
pages["hls-id3"] = html("hls-id3", '<video controls preload="none" src="/entry/master.m3u8"></video>');
pages["origin-timeout"] = html("origin-timeout", '<video controls preload="none" src="/unavailable/master.m3u8"></video>');
pages["interrupted-hls"] = html("interrupted-hls", '<video controls preload="none" src="/interrupted-hls/media.m3u8"></video>');
const hlsRequests = {playlists: 0, segments: 0};

// What was requested, by whom: a page's own fetch calls carry x-fixture-page,
// a media element's requests state their destination, and savemedia's
// requests carry neither.
const requestLog = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname === "/__requests") {
    if (req.method === "POST") requestLog.length = 0;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(requestLog));
    return;
  }
  if (!url.pathname.startsWith("/page/")) {
    requestLog.push({ path: url.pathname + url.search, dest: req.headers["sec-fetch-dest"] ?? "", page: req.headers["x-fixture-page"] ?? "",
      host: req.headers.host ?? "" });
    if (requestLog.length > 2000) requestLog.shift();
  }
  if (url.pathname === "/interrupted-hls/counts") {
    if (req.method === "POST") { hlsRequests.playlists = 0; hlsRequests.segments = 0; }
    res.writeHead(200, {"content-type": "application/json", "cache-control": "no-store"}).end(JSON.stringify(hlsRequests));
    return;
  }
  if (url.pathname === "/interrupted-hls/media.m3u8") {
    hlsRequests.playlists++;
    res.writeHead(200, {"content-type": "application/vnd.apple.mpegurl", "cache-control": "private, max-age=120"})
      .end("#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\nclip.ts\n#EXT-X-ENDLIST\n");
    return;
  }
  if (url.pathname === "/interrupted-hls/clip.ts") {
    const bytes = routes["/transport/timed-id3.ts"].body;
    res.writeHead(200, {"content-type": "video/mp2t", "content-length": bytes.length, "cache-control": "no-store"});
    if (++hlsRequests.segments === 1) {
      res.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
      setTimeout(() => res.destroy(), 100);
    } else res.end(bytes);
    return;
  }
  const outageSegment = /^\/hls-outage\/(seg00[789]\.ts)$/.exec(url.pathname)?.[1];
  if (outageSegment) {
    // No answer: the connection is closed without a response, as when the network is gone.
    if (outageSegment === "seg008.ts" && requestLog.filter(entry => entry.path === url.pathname).length <= HLS_OUTAGE_REQUESTS) {
      req.socket.destroy();
      return;
    }
    const bytes = routes[`/hls-multi/${outageSegment}`].body;
    res.writeHead(200, { "content-type": "video/mp2t", "content-length": bytes.length, "cache-control": "no-store" }).end(bytes);
    return;
  }
  if (url.pathname === "/unavailable/master.m3u8") {
    res.writeHead(522, { "Retry-After": "60" }).end("Origin connection timed out");
    return;
  }
  if (url.pathname === "/entry/master.m3u8") {
    res.writeHead(302, { Location: "/nested/master.m3u8" }).end();
    return;
  }
  if (url.pathname === "/nested/media.m3u8") {
    res.writeHead(302, { Location: "/transport/media.m3u8" }).end();
    return;
  }
  if (url.pathname.startsWith("/page/")) {
    const scenario = url.pathname.split("/")[2]?.replace(".html", "") ?? "";
    const body = pages[scenario];
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
    return;
  }
  if (serveFilePageMedia(req, res, url.pathname)) return;
  const route = routes[url.pathname === "/nested/master.m3u8" ? "/transport/master.m3u8" : url.pathname];
  if (!route) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": route.type,
    "Content-Length": String(route.body.length),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(route.body);
});

server.listen(port, "127.0.0.1", () => {
  const address = `http://127.0.0.1:${server.address().port}`;
  console.log(`[fixture-server] listening on ${address}`);
  process.send?.({ address });
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
