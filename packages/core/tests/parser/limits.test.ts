import { describe, expect, it } from "vitest";
import { parse as parseMpd } from "mpd-parser";
import { addressBudget, checkManifestSize, hlsSegmentLines, isoDurationSeconds, MAX_MANIFEST_ADDRESS_BYTES, MAX_MANIFEST_BYTES } from "../../src/parser/limits";
import { dashAddressEstimate, dashSegmentEstimate } from "../../src/parser/dash/bounded";
import { parseDash } from "../../src/parser/dash/adapter";
import { parseHlsMaster, parseHlsMediaPlaylist } from "../../src/parser/hls/adapter";
import { classify } from "../../src/classifier/classify";
import { inheritAttributes, stringToMpdXml } from "mpd-parser";

const mpd = (attributes: string, body: string) =>
  `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" ${attributes}><Period>${body}</Period></MPD>`;

describe("manifest limits", () => {
  it("reads ISO 8601 durations", () => {
    expect(isoDurationSeconds("PT4S")).toBe(4);
    expect(isoDurationSeconds("PT1H30M2.5S")).toBe(5402.5);
    expect(isoDurationSeconds("P1DT1S")).toBe(86401);
    expect(isoDurationSeconds("4")).toBeNull();
    expect(isoDurationSeconds(null)).toBeNull();
  });

  it("counts HLS segment lines without tags, comments or blank lines", () => {
    expect(hlsSegmentLines("#EXTM3U\n#EXTINF:4,\nseg0.ts\n\n  \r\n#EXTINF:4,\nseg1.ts\n#EXT-X-ENDLIST")).toBe(2);
  });

  const URL = "https://a.test/x.mpd";
  const tooLarge = expect.objectContaining({ code: "manifest_too_large", limit: "segments" });
  const rep = '<Representation id="v" bandwidth="1" width="1" height="1" codecs="avc1.4d401e"/>';
  /** What mpd-parser really builds: the estimate must never be below it. */
  const built = (xml: string, now?: number) => {
    const parsed = parseMpd(xml, { manifestUri: URL, ...(now === undefined ? {} : { NOW: now }) } as { manifestUri: string });
    const counts = [...(parsed.playlists ?? []), ...Object.values(parsed.mediaGroups?.AUDIO ?? {}).flatMap(group =>
      Object.values(group).flatMap(rendition => rendition.playlists ?? []))].map(playlist => playlist.segments?.length ?? 0);
    return { perTrack: Math.max(0, ...counts), total: counts.reduce((sum, count) => sum + count, 0) };
  };

  it("refuses a 359-byte MPD that declares millions of segments without expanding it", () => {
    const bomb = mpd('type="static" mediaPresentationDuration="PT3H"',
      '<AdaptationSet mimeType="video/mp4"><SegmentTemplate duration="1" timescale="1000" media="s$Number$.m4s"/><Representation id="v" bandwidth="1"/></AdaptationSet>');
    expect(dashSegmentEstimate(bomb).perTrack).toBe(10_800_000);
    expect(() => parseDash(bomb, URL)).toThrowError(tooLarge);
  });

  it("counts what the parser builds: shared templates, timelines, lists and an end number", () => {
    const shared = mpd('type="static" mediaPresentationDuration="PT100S"',
      `<AdaptationSet mimeType="video/mp4"><SegmentTemplate duration="2" timescale="1" media="$RepresentationID$-$Number$.m4s"/>${rep.replace('"v"', '"a"')}${rep.replace('"v"', '"b"')}${rep.replace('"v"', '"c"')}</AdaptationSet>`);
    expect(dashSegmentEstimate(shared)).toEqual({ perTrack: 50, total: 150 });
    expect(built(shared)).toEqual({ perTrack: 50, total: 150 });

    const timeline = mpd('type="static" mediaPresentationDuration="PT60S"',
      '<AdaptationSet mimeType="video/mp4"><Representation id="a" bandwidth="1" width="1" height="1" codecs="avc1.4d401e"><SegmentTemplate timescale="1000" media="a-$Time$.m4s"><SegmentTimeline><S t="0" d="2000" r="9"/><S d="1000"/><S d="2000" r="-1"/></SegmentTimeline></SegmentTemplate></Representation>'
      + '<Representation id="b" bandwidth="2" width="2" height="2" codecs="avc1.4d401e"><SegmentList duration="10"><SegmentURL media="1.m4s"/><SegmentURL media="2.m4s"/></SegmentList></Representation>'
      + '<Representation id="c" bandwidth="3" width="3" height="3" codecs="avc1.4d401e"><SegmentTemplate duration="1" timescale="1000" endNumber="5" media="c-$Number$.m4s"/></Representation></AdaptationSet>');
    // The list's time line is expanded to six entries before it is matched to its two addresses.
    expect(dashSegmentEstimate(timeline)).toEqual({ perTrack: 31, total: 31 + 6 + 5 });
    expect(built(timeline)).toEqual({ perTrack: 31, total: 31 + 2 + 5 });
  });

  it("bounds a live manifest by its time shift buffer, or by its availability start", () => {
    const now = Date.parse("2026-01-02T00:00:00Z");
    const windowed = mpd('type="dynamic" availabilityStartTime="2020-01-01T00:00:00Z" timeShiftBufferDepth="PT60S"',
      `<AdaptationSet mimeType="video/mp4"><SegmentTemplate duration="2" media="s$Number$.m4s"/>${rep}</AdaptationSet>`);
    expect(dashSegmentEstimate(windowed, now).perTrack).toBe(30);
    expect(built(windowed, now).perTrack).toBe(30);
    const unbounded = mpd('type="dynamic" availabilityStartTime="2026-01-01T00:00:00Z"',
      `<AdaptationSet mimeType="video/mp4"><SegmentTemplate duration="1" timescale="1000" media="s$Number$.m4s"/>${rep}</AdaptationSet>`);
    expect(dashSegmentEstimate(unbounded, now).perTrack).toBe(86_400_000);
  });

  // Each of these made a count taken from the manifest's text come out far too low.
  const disguises: Record<string, (segments: number) => string> = {
    "a timescale inherited from an outer template": n => mpd(`type="static" mediaPresentationDuration="PT${n / 1000}S"`,
      `<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" media="s$Number$.m4s"/><Representation id="v" bandwidth="1" width="1" height="1" codecs="avc1.4d401e"><SegmentTemplate duration="1"/></Representation></AdaptationSet>`),
    "a > inside an attribute value": n => mpd(`type="static" mediaPresentationDuration="PT${n / 1000}S"`,
      `<AdaptationSet mimeType="video/mp4"><SegmentTemplate media="s>$Number$.m4s" duration="1" timescale="1000"/>${rep}</AdaptationSet>`),
    "a duration written as a character reference": n => mpd(`type="static" mediaPresentationDuration="PT${n / 1000}S"`,
      `<AdaptationSet mimeType="video/mp4"><SegmentTemplate media="s$Number$.m4s" duration="&#49;" timescale="1000"/>${rep}</AdaptationSet>`),
    "a repeat count written as character references": n => mpd('type="static" mediaPresentationDuration="PT100S"',
      `<AdaptationSet mimeType="video/mp4"><SegmentTemplate media="s$Number$.m4s" timescale="1000"><SegmentTimeline><S t="0" d="1" r="${[...String(n - 1)].map(digit => `&#${digit.charCodeAt(0)};`).join("")}"/></SegmentTimeline></SegmentTemplate>${rep}</AdaptationSet>`),
    "an end number that ignores the duration": n => mpd('type="static" mediaPresentationDuration="PT1S"',
      `<AdaptationSet mimeType="video/mp4"><SegmentTemplate media="s$Number$.m4s" duration="1" endNumber="${n}"/>${rep}</AdaptationSet>`),
  };
  for (const [name, make] of Object.entries(disguises)) {
    it(`counts ${name} as the parser does, and refuses it when it is too large`, () => {
      const small = make(3000);
      expect(dashSegmentEstimate(small).perTrack).toBe(3000);
      expect(built(small).perTrack).toBe(3000);
      expect(() => parseDash(make(300_000), URL)).toThrowError(tooLarge);
    });
  }

  it("counts every BaseURL combination, and refuses a manifest that multiplies them", () => {
    const bases = (count: number) => Array.from({ length: count }, (_, index) => `<BaseURL>https://h${index}.test/</BaseURL>`).join("");
    const fanOut = (perLevel: number, seconds: number) => `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT${seconds}S">`
      + `${bases(perLevel)}<Period>${bases(perLevel)}<AdaptationSet mimeType="video/mp4">${bases(perLevel)}<SegmentTemplate media="s$Number$.m4s" duration="1"/>${rep}</AdaptationSet></Period></MPD>`;
    const small = fanOut(2, 10);
    expect(dashSegmentEstimate(small)).toEqual({ perTrack: 10, total: 80 });
    expect(built(small).total).toBeLessThanOrEqual(80);
    // 64 combinations of 90,000 segments each: every track is below its limit, the manifest is not.
    expect(() => parseDash(fanOut(4, 90_000), URL)).toThrowError(tooLarge);
    // The combinations alone, before any representation is read.
    const combinations = `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1S">`
      + `${bases(300)}<Period>${bases(300)}<AdaptationSet mimeType="video/mp4">${bases(300)}</AdaptationSet></Period></MPD>`;
    expect(() => parseDash(combinations, URL)).toThrowError(tooLarge);
  });

  it("treats a zero segment duration as one segment, as the parser does", () => {
    const zero = mpd('type="static" mediaPresentationDuration="PT1S"', `<AdaptationSet mimeType="video/mp4"><SegmentTemplate duration="0" media="s$Number$.m4s"/>${rep}</AdaptationSet>`);
    expect(dashSegmentEstimate(zero)).toEqual(built(zero));
  });

  it("accepts ordinary manifests and refuses oversize text and playlists", () => {
    const ordinary = mpd('type="static" mediaPresentationDuration="PT2H"',
      '<AdaptationSet mimeType="video/mp4"><SegmentTemplate duration="2" media="$RepresentationID$-$Number$.m4s"/>'
      + Array.from({ length: 8 }, (_, index) => rep.replace('"v"', `"r${index}"`)).join("") + '</AdaptationSet>');
    expect(() => parseDash(ordinary, URL)).not.toThrow();
    expect(() => checkManifestSize("hls", "#EXTM3U\n" + "#EXTINF:1,\ns.ts\n".repeat(10), "https://a.test/a.m3u8")).not.toThrow();
    expect(() => checkManifestSize("hls", "#EXTM3U\n" + "s.ts\n".repeat(100_001), "https://a.test/a.m3u8"))
      .toThrowError(expect.objectContaining({ code: "manifest_too_large", limit: "segments" }));
    expect(() => checkManifestSize("hls", "#".repeat(MAX_MANIFEST_BYTES + 1), "https://a.test/a.m3u8"))
      .toThrowError(expect.objectContaining({ code: "manifest_too_large", limit: "bytes" }));
    expect(() => checkManifestSize("dash", "<".repeat(MAX_MANIFEST_BYTES + 1), URL))
      .toThrowError(expect.objectContaining({ code: "manifest_too_large", limit: "bytes" }));
  });

  describe("address text a manifest resolves to", () => {
    /** The address text mpd-parser really builds for the segments. */
    const builtBytes = (xml: string, uri: string): number => {
      const parsed = parseMpd(xml, { manifestUri: uri });
      return [...(parsed.playlists ?? []), ...Object.values(parsed.mediaGroups?.AUDIO ?? {}).flatMap(group =>
        Object.values(group).flatMap(rendition => rendition.playlists ?? []))]
        .reduce((sum, playlist) => sum + (playlist.segments ?? []).reduce((bytes, segment) => bytes + segment.resolvedUri.length, 0), 0);
    };
    const estimated = (xml: string, uri: string): number =>
      dashAddressEstimate(inheritAttributes(stringToMpdXml(xml), { manifestUri: uri }).representationInfo);

    it("counts addresses and throws once the limit is passed", () => {
      const counted = addressBudget("https://a.test/a.m3u8", 10);
      expect(counted("12345")).toBe("12345");
      expect(counted("12345")).toBe("12345");
      expect(() => counted("1")).toThrowError(tooLarge);
    });

    it("never estimates a DASH manifest below what the parser builds", () => {
      const template = mpd('type="static" mediaPresentationDuration="PT600S"',
        `<AdaptationSet mimeType="video/mp4"><SegmentTemplate duration="2" media="v/$RepresentationID$/seg-$Number%05d$-$Bandwidth$.m4s" initialization="v/$RepresentationID$/init.mp4"/>${rep.replace('"v"', '"main-1080"')}</AdaptationSet>`);
      const listed = mpd('type="static" mediaPresentationDuration="PT20S"',
        '<AdaptationSet mimeType="video/mp4"><Representation id="b" bandwidth="2" width="2" height="2" codecs="avc1.4d401e"><BaseURL>https://cdn.test/deep/path/</BaseURL><SegmentList duration="10"><SegmentURL media="one-long-name.m4s"/><SegmentURL media="2.m4s"/></SegmentList></Representation></AdaptationSet>');
      for (const xml of [template, listed]) {
        const real = builtBytes(xml, URL);
        expect(real).toBeGreaterThan(0);
        expect(estimated(xml, URL)).toBeGreaterThanOrEqual(real);
        // Close enough that an ordinary manifest is never refused for the estimate alone.
        expect(estimated(xml, URL)).toBeLessThan(real * 3);
      }
    });

    it("refuses a small MPD under a long address before it builds the addresses", () => {
      // 3 representations of 48,600 segments: every count is within its limit, the text is not.
      const long = `https://a.test/${"p".repeat(700)}/x.mpd`;
      const bomb = mpd('type="static" mediaPresentationDuration="PT27H"',
        '<AdaptationSet mimeType="video/mp4"><SegmentTemplate duration="2" media="$RepresentationID$-$Number$.m4s"/>'
        + ["a", "b", "c"].map(id => rep.replace('"v"', `"${id}"`)).join("") + "</AdaptationSet>");
      expect(dashSegmentEstimate(bomb).perTrack).toBe(48_600);
      expect(estimated(bomb, long)).toBeGreaterThan(MAX_MANIFEST_ADDRESS_BYTES);
      expect(() => parseDash(bomb, long)).toThrowError(tooLarge);
      // The same manifest under an ordinary address is read.
      expect(() => parseDash(bomb, URL)).not.toThrow();
    });

    it("refuses a number format that makes every address huge", () => {
      const wide = mpd('type="static" mediaPresentationDuration="PT200S"',
        `<AdaptationSet mimeType="video/mp4"><SegmentTemplate duration="2" media="s$Number%0999999d$.m4s"/>${rep}</AdaptationSet>`);
      expect(() => parseDash(wide, URL)).toThrowError(tooLarge);
    });

    it("refuses an HLS playlist whose relative names resolve to too much text, and reads it under a short address", async () => {
      const playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n" + "#EXTINF:4,\ns.ts\n".repeat(20_000) + "#EXT-X-ENDLIST\n";
      const long = `https://a.test/${"p".repeat(4000)}/index.m3u8`;
      expect(() => parseHlsMediaPlaylist(playlist, long)).toThrowError(tooLarge);
      expect(parseHlsMediaPlaylist(playlist, "https://a.test/index.m3u8").segments).toHaveLength(20_000);
      // classify does not mistake the refusal for "not a media playlist".
      await expect(classify({ tabId: 1, pageUrl: "https://a.test/", url: long, headers: { "content-type": "application/vnd.apple.mpegurl" },
        bodyBytes: null, manifestText: playlist })).rejects.toMatchObject({ code: "manifest_too_large", limit: "segments" });
    });

    it("refuses an HLS master whose variants resolve to too much text", () => {
      const master = "#EXTM3U\n" + Array.from({ length: 5000 }, (_, index) => `#EXT-X-STREAM-INF:BANDWIDTH=${index + 1}\nv${index}.m3u8\n`).join("");
      expect(() => parseHlsMaster(master, `https://a.test/${"p".repeat(4000)}/master.m3u8`)).toThrowError(tooLarge);
      expect(parseHlsMaster(master, "https://a.test/master.m3u8").variants).toHaveLength(5000);
    });
  });
});
