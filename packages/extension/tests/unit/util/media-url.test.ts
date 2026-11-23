import { describe, expect, it } from "vitest";
import { isManifestMime, mayDeclareMedia, dispositionFileName, mediaFileName, mimeKind, normalizeMediaUrl, playlistIdentity, requestTypeOfTiming, urlKind, withoutHash, worthProbing, mayBeFetchedFile, nameFitsContainer } from "../../../src/util/media-url";

describe("media-url", () => {
  it("names kinds from the last path segment only", () => {
    expect(urlKind("https://a.test/x/master.m3u8?t=1")).toBe("manifest");
    expect(urlKind("https://a.test/x/clip.M4V")).toBe("file");
    expect(urlKind("https://a.test/x/seg.ts#f")).toBe("transport");
    expect(urlKind("https://a.test/clip.mp4/")).toBeNull();
    expect(urlKind("https://a.test/watch?file=clip.mp4")).toBeNull();
    expect(urlKind("https://a.test/.mp4")).toBeNull();
  });

  it("reads kinds from MIME types", () => {
    expect(mimeKind("application/vnd.apple.mpegurl")).toBe("manifest");
    expect(mimeKind("Application/X-MPEGURL; charset=utf-8")).toBe("manifest");
    expect(mimeKind("application/dash+xml")).toBe("manifest");
    expect(mimeKind("video/mp2t")).toBe("transport");
    expect(mimeKind("video/x-m4v")).toBe("file");
    expect(mimeKind("video/iso.segment")).toBeNull();
    expect(mimeKind("audio/mpeg")).toBeNull();
    expect(mimeKind("")).toBeNull();
  });

  it("normalizes addresses and compares them without the fragment", () => {
    expect(normalizeMediaUrl("/a.mp4#t=3", "https://a.test/page")).toBe("https://a.test/a.mp4");
    expect(normalizeMediaUrl("https://user:pw@a.test/a.mp4")).toBeNull();
    expect(normalizeMediaUrl("blob:https://a.test/1")).toBeNull();
    expect(withoutHash("https://a.test/a#b#c")).toBe("https://a.test/a");
  });

  it("always probes an element's own source, also a .ts file", () => {
    expect(worthProbing("https://a.test/part-2.mp4", { via: "element" })).toBe(true);
    expect(worthProbing("https://a.test/whole.ts", { via: "element" })).toBe(true);
    expect(worthProbing("https://a.test/opaque", { via: "element" })).toBe(true);
    expect(worthProbing("blob:https://a.test/1", { via: "element" })).toBe(false);
    expect(worthProbing("data:video/mp4;base64,AA", { via: "element" })).toBe(false);
  });

  it("probes declared sources by MIME or by a manifest or file name; .ts only with its MIME", () => {
    expect(worthProbing("https://a.test/v/1080", { via: "declared", mime: "video/mp4" })).toBe(true);
    expect(worthProbing("https://a.test/v/master", { via: "declared", mime: "application/x-mpegURL" })).toBe(true);
    expect(worthProbing("https://a.test/clip.webm", { via: "declared" })).toBe(true);
    expect(worthProbing("https://a.test/master.mpd", { via: "declared" })).toBe(true);
    expect(worthProbing("https://a.test/utils.ts", { via: "declared" })).toBe(false);
    expect(worthProbing("https://a.test/whole.ts", { via: "declared", mime: "video/mp2t" })).toBe(true);
    expect(worthProbing("https://a.test/poster.jpg", { via: "declared" })).toBe(false);
    expect(worthProbing("https://a.test/clip.mp4/", { via: "declared" })).toBe(false);
  });

  it("probes a request before its response only for a manifest name", () => {
    expect(worthProbing("https://a.test/live/index.m3u8", { via: "request", type: "xmlhttprequest" })).toBe(true);
    expect(worthProbing("https://a.test/clip.mp4", { via: "request", type: "media" })).toBe(false);
  });

  it("decides media requests by the response type", () => {
    const media = (mime: string) => ({ via: "request" as const, type: "media", mime });
    expect(worthProbing("https://a.test/part-2.mp4", media("video/mp4"))).toBe(true);
    expect(worthProbing("https://a.test/segment-03-interview.mp4", media("video/mp4"))).toBe(true);
    expect(worthProbing("https://a.test/get?id=4", media(""))).toBe(true);
    expect(worthProbing("https://a.test/get?id=4", media("application/octet-stream"))).toBe(true);
    expect(worthProbing("https://a.test/whole.ts", media("video/mp2t"))).toBe(true);
    expect(worthProbing("https://a.test/song.mp3", media("audio/mpeg"))).toBe(false);
    expect(worthProbing("https://a.test/a.png", media("image/png"))).toBe(false);
    expect(worthProbing("https://a.test/a", media("text/html"))).toBe(false);
    expect(worthProbing("https://a.test/a", media("application/json"))).toBe(false);
  });

  it("keeps fetched fragments out: an xhr file needs a manifest type or an attachment", () => {
    const xhr = (mime: string, disposition?: string) => ({ via: "request" as const, type: "xmlhttprequest", mime, disposition });
    expect(worthProbing("https://a.test/seg-1.mp4", xhr("video/mp4"))).toBe(false);
    expect(worthProbing("https://a.test/seg-1.m4s", xhr("video/iso.segment"))).toBe(false);
    expect(worthProbing("https://a.test/seg-1.ts", xhr("video/mp2t"))).toBe(false);
    expect(worthProbing("https://a.test/api/stream", xhr("application/vnd.apple.mpegurl"))).toBe(true);
    expect(worthProbing("https://a.test/get", xhr("video/mp4", "attachment; filename=\"a.mp4\""))).toBe(true);
    expect(worthProbing("https://a.test/get", xhr("application/octet-stream", "attachment; filename*=UTF-8''Talk%207.mov"))).toBe(true);
    expect(worthProbing("https://a.test/get", xhr("application/octet-stream", "attachment; filename=report.pdf"))).toBe(false);
    expect(worthProbing("https://a.test/get", xhr("application/json", "inline; filename=a.mp4"))).toBe(false);
  });

  it("never probes other request types", () => {
    expect(worthProbing("https://a.test/x.m3u8", { via: "request", type: "image", mime: "application/vnd.apple.mpegurl" })).toBe(false);
    expect(worthProbing("https://a.test/x.mp4", { via: "request", type: "script", mime: "video/mp4" })).toBe(false);
  });

  it("maps resource timing initiators to request types", () => {
    expect(requestTypeOfTiming("video")).toBe("media");
    expect(requestTypeOfTiming("audio")).toBe("media");
    expect(requestTypeOfTiming("fetch")).toBe("xmlhttprequest");
    expect(requestTypeOfTiming("xmlhttprequest")).toBe("xmlhttprequest");
    expect(requestTypeOfTiming("img")).toBeNull();
  });

  it("accepts media file names and reads them from Content-Disposition", () => {
    expect(mediaFileName(" Talk 7.mov ")).toBe("Talk 7.mov");
    expect(mediaFileName("a/b.mp4")).toBeUndefined();
    expect(mediaFileName("notes.txt")).toBeUndefined();
    expect(mediaFileName("x".repeat(240) + ".mp4")).toBeUndefined();
    expect(dispositionFileName("attachment; filename=\"a b.mp4\"")).toBe("a b.mp4");
    expect(dispositionFileName("attachment; filename*=UTF-8'en'F%C3%A4rbig.mov")).toBe("Färbig.mov");
    expect(dispositionFileName("attachment; filename=\"\"; filename*=UTF-8''")).toBeUndefined();
  });

  it("gives every reload of a playlist one identity by dropping only the HLS delivery directives", () => {
    expect(playlistIdentity("https://a.test/720p/playlist.m3u8?token=9&_HLS_msn=123&_HLS_part=2#x"))
      .toBe("https://a.test/720p/playlist.m3u8?token=9");
    expect(playlistIdentity("https://a.test/720p/playlist.m3u8?_HLS_skip=YES")).toBe("https://a.test/720p/playlist.m3u8");
    expect(playlistIdentity("https://a.test/a.m3u8?msn=1")).toBe("https://a.test/a.m3u8?msn=1");
  });

  it("notes a video a script fetched whole as a file the page may play from memory, and never checks it on the spot", () => {
    const fetched = (mime: string | undefined, status = 200, type = "xmlhttprequest") => ({ type, status, mime });
    // No attachment header, no telling name: the answer's type and its being a full answer are what is known.
    expect(mayBeFetchedFile("https://cdn.test/v/clip.mp4", fetched("video/mp4"))).toBe(true);
    expect(mayBeFetchedFile("https://cdn.test/get?id=9", fetched("video/webm; codecs=vp9"))).toBe(true);
    expect(mayBeFetchedFile("https://cdn.test/get?id=9", fetched("video/quicktime"))).toBe(true);
    // The passive rule stays as it was: nothing is requested for it when the answer arrives.
    expect(worthProbing("https://cdn.test/v/clip.mp4", { via: "request", type: "xmlhttprequest", mime: "video/mp4" })).toBe(false);
    // A range of a file, a fragment by its registered type, a transport stream, sound, data and a media element's own request are not noted.
    expect(mayBeFetchedFile("https://cdn.test/v/clip.mp4", fetched("video/mp4", 206))).toBe(false);
    expect(mayBeFetchedFile("https://cdn.test/v/seg-1.m4s", fetched("video/iso.segment"))).toBe(false);
    expect(mayBeFetchedFile("https://cdn.test/v/seg-1.ts", fetched("video/mp2t"))).toBe(false);
    expect(mayBeFetchedFile("https://cdn.test/a.mp3", fetched("audio/mpeg"))).toBe(false);
    expect(mayBeFetchedFile("https://cdn.test/v/clip.mp4", fetched("application/octet-stream"))).toBe(false);
    expect(mayBeFetchedFile("https://cdn.test/v/clip.mp4", fetched(undefined))).toBe(false);
    expect(mayBeFetchedFile("https://cdn.test/v/clip.mp4", fetched("video/mp4", 200, "media"))).toBe(false);
    expect(mayBeFetchedFile("blob:https://site.test/1", fetched("video/mp4"))).toBe(false);
  });

  it("lets a file name stand for a file only when the file's bytes are of the kind the name says", () => {
    for (const [name, container] of [["Trip.mp4", "mp4"], ["Trip.M4V", "mp4"], ["Trip.mp4", "fmp4"], ["Trip.mp4", "cmaf"], ["Trip.mov", "mov"], ["Trip.qt", "mov"],
      ["Trip.webm", "webm"], ["Holiday.Trip.2024.1080p.mkv", "mkv"], ["Trip.ts", "mpegts"], ["Trip.m2ts", "mpegts"]]) {
      expect(nameFitsContainer(name!, container!), `${name} as ${container}`).toBe(true);
    }
    for (const [name, container] of [["Holiday.Trip.2024.1080p.mkv", "mp4"], ["Trip.mov", "mp4"], ["Trip.mp4", "mov"], ["Trip.webm", "mkv"], ["Trip.mkv", "webm"],
      ["Trip.mp4", "mpegts"], ["Trip.mp4", "unknown"], ["Trip", "mp4"], ["Trip.avi", "mp4"], ["", "mp4"]]) {
      expect(nameFitsContainer(name!, container!), `${name} as ${container}`).toBe(false);
    }
  });

  it("gates scripts by the same suffixes and types the rules know", () => {
    for (const text of [`{"src":"/a.qt"}`, `file: "clip.m4v?x=1"`, `"https://cdn.test/v/master.m3u8"`, `type:"video\\/mp4"`, `"application/dash+xml"`,
      `"application\\/vnd.apple.mpegurl"`, `"audio/mpegurl"`]) {
      expect(mayDeclareMedia(text), text).toBe(true);
    }
    for (const text of [`{"page":"/watch/2"}`, `import x from "./player.ts"`, `"a.mp4x"`, `"audio/mpeg"`, `videoPlayer.start()`]) {
      expect(mayDeclareMedia(text), text).toBe(false);
    }
    expect(isManifestMime("application/vnd.apple.mpegurl; charset=utf-8")).toBe(true);
    expect(isManifestMime("Application/DASH+XML")).toBe(true);
    expect(isManifestMime("video/mp4")).toBe(false);
  });
});
