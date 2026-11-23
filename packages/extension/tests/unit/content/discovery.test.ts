// @vitest-environment-options {"url":"https://player.example/watch/1"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { declaredMediaFilename, fileDownloadOffer, publishedFileLinks } from "../../../src/content/discovery";
import { declaredMedia } from "../../../src/content/declarations";

const page = "https://player.example/watch/1";
beforeEach(() => {
  document.body.innerHTML = "";
  // jsdom lays nothing out. Like a browser, give an element boxes unless it or an ancestor is display: none.
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    for (let node: Element | null = this; node; node = node.parentElement) {
      if (getComputedStyle(node).display === "none") return [] as unknown as DOMRectList;
    }
    return [{ x: 0, y: 0, left: 0, top: 0, right: 80, bottom: 20, width: 80, height: 20 }] as unknown as DOMRectList;
  });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("declared file links", () => {
  it("offers the one link the page declares for its named file", () => {
    document.body.innerHTML = `<main><h1>Clip 31.mov</h1><a href="/get/31?token=1" download>Download</a></main>`;
    expect(fileDownloadOffer(document, page)).toEqual({ filename: "Clip 31.mov", url: "https://player.example/get/31?token=1" });
    expect(publishedFileLinks(document, page)).toEqual([{ url: "https://player.example/get/31?token=1", filenameHint: "Clip 31.mov", named: true }]);
  });

  it("names the file after the page even when the link's path names it differently", () => {
    document.body.innerHTML = `<h1>Holiday.mov</h1><a download href="https://files.example/dl/x/clip.mov">Download</a>`;
    expect(fileDownloadOffer(document, page)).toEqual({ filename: "Holiday.mov", url: "https://files.example/dl/x/clip.mov" });
    document.querySelector("a")!.setAttribute("download", "Other.mov");
    expect(fileDownloadOffer(document, page)).toBeUndefined();
    document.querySelector("a")!.setAttribute("href", "http://files.example/dl/x/clip.mov");
    document.querySelector("a")!.setAttribute("download", "");
    expect(fileDownloadOffer(document, page)).toBeUndefined();
  });

  it("offers a plain link whose path is the file the page names, whatever its label says", () => {
    document.body.innerHTML = `<main><h1>Holiday.mov</h1><a href="https://files.example/d/7/Holiday.mov">Herunterladen</a>
      <a href="https://files.example/d/8/Other.mov">Other</a><a href="https://files.example/d/7/Holiday.mov.html">Details</a></main>`;
    expect(fileDownloadOffer(document, page)).toEqual({ filename: "Holiday.mov", url: "https://files.example/d/7/Holiday.mov" });
    expect(publishedFileLinks(document, page)).toEqual([{ url: "https://files.example/d/7/Holiday.mov", filenameHint: "Holiday.mov", named: true }]);
    // Without a page that names the file, a plain link is not a declaration.
    document.querySelector("h1")!.textContent = "Holiday";
    expect(fileDownloadOffer(document, page)).toBeUndefined();
    expect(publishedFileLinks(document, page)).toEqual([]);
  });

  it("never reads a source file page as a transport stream from its heading and raw link", () => {
    document.body.innerHTML = `<main><h1>utils.ts</h1><a href="https://code.example/raw/main/src/utils.ts">Raw</a></main>`;
    expect(fileDownloadOffer(document, page)).toBeUndefined();
    expect(publishedFileLinks(document, page)).toEqual([]);
    // A type attribute supplies the context the name lacks.
    document.querySelector("a")!.setAttribute("type", "video/mp2t");
    expect(fileDownloadOffer(document, page)).toEqual({ filename: "utils.ts", url: "https://code.example/raw/main/src/utils.ts" });
    expect(publishedFileLinks(document, page)).toEqual([{ url: "https://code.example/raw/main/src/utils.ts", filenameHint: "utils.ts", named: true }]);
  });

  // A download attribute is neither a MIME type nor a media element: it makes a link a download, not a video.
  it.each([
    ["the raw file", `<a download href="https://code.example/raw/main/src/utils.ts">Download raw file</a>`],
    ["the raw file under its name", `<a download="utils.ts" href="https://code.example/raw/main/blob/91">Download raw file</a>`],
    ["an archive", `<a download href="https://code.example/archive/main.zip">Download ZIP</a>`],
    ["a numbered address", `<a download href="https://code.example/get/31">Download</a>`],
  ])("never reads a source file page as a transport stream from its heading and a download link to %s", (_what, link) => {
    document.body.innerHTML = `<main><h1>utils.ts</h1>${link}</main>`;
    expect(fileDownloadOffer(document, page)).toBeUndefined();
    expect(publishedFileLinks(document, page)).toEqual([]);
    expect(declaredMedia(document, page, [], () => "k").page).toEqual([]);
    // Without the heading too: a download link to a source file declares no media.
    document.querySelector("h1")!.remove();
    expect(publishedFileLinks(document, page)).toEqual([]);
  });

  it("takes a transport stream name from a link only with the link's own transport stream type", () => {
    document.body.innerHTML = `<a download href="/files/capture.ts">A</a><a download="capture.m2ts" href="/files/7">B</a>
      <a download href="/files/typed.ts" type="video/mp2t">C</a><a download="named.ts" href="/files/8" type="video/MP2T">D</a>
      <a download="notes.ts" href="/files/clip.mp4">E</a><a href="/files/other.ts" type="video/mp4">F</a>`;
    expect(publishedFileLinks(document, page)).toEqual([
      { url: "https://player.example/files/typed.ts", filenameHint: "typed.ts", named: false },
      { url: "https://player.example/files/8", filenameHint: "named.ts", named: false },
      // The name that does not count is left out; the path's own name and the stated type still do.
      { url: "https://player.example/files/clip.mp4", filenameHint: "clip.mp4", named: false },
      { url: "https://player.example/files/other.ts", named: false },
    ]);
  });

  it("keeps a media link listed on a page whose heading names a source file", () => {
    document.body.innerHTML = `<h1>utils.ts</h1><a download href="/files/a.mp4">A</a>`;
    expect(fileDownloadOffer(document, page)).toBeUndefined();
    expect(publishedFileLinks(document, page)).toEqual([{ url: "https://player.example/files/a.mp4", filenameHint: "a.mp4", named: false }]);
  });

  it("ignores a copy of the file link that the page does not lay out", () => {
    document.body.innerHTML = `<h1>Clip 31.mov</h1><nav style="display: none"><a href="/mobile/31" download>Get</a></nav>
      <a href="/get/31" download>Get</a>`;
    expect(fileDownloadOffer(document, page)).toEqual({ filename: "Clip 31.mov", url: "https://player.example/get/31" });
    document.querySelector("nav")!.removeAttribute("style");
    expect(fileDownloadOffer(document, page)).toBeUndefined();
  });

  it("never treats a labelled button or script-driven link as a file", () => {
    document.body.innerHTML = `<main><h1>Clip 31.mov</h1><button type="button">Download</button>
      <a href="#">Download</a><a href="/page/download-31.html">Download original file</a></main>`;
    expect(fileDownloadOffer(document, page)).toBeUndefined();
    expect(publishedFileLinks(document, page)).toEqual([]);
  });

  it("chooses among named links only by the section of the heading that names the file", () => {
    document.body.innerHTML = `<main><section><h1>Clip 31.mov</h1><a href="/get/31" download>Get</a></section>
      <aside><a href="/get/32" download>Get</a></aside></main>`;
    expect(fileDownloadOffer(document, page)).toEqual({ filename: "Clip 31.mov", url: "https://player.example/get/31" });
    document.querySelector("aside")!.remove();
    document.querySelector("section")!.insertAdjacentHTML("beforeend", '<a href="/get/33" download>Get</a>');
    expect(fileDownloadOffer(document, page)).toBeUndefined();
  });
});

describe("the file name a page shows", () => {
  it("reads a media file name from the heading or the page title metadata, by the shared suffix list", () => {
    document.body.innerHTML = "<h1> Holiday 2.m4v </h1>";
    expect(declaredMediaFilename(document, { transport: false })).toBe("Holiday 2.m4v");
    document.body.innerHTML = "<h1>Holiday</h1>";
    expect(declaredMediaFilename(document, { transport: true })).toBeUndefined();
    document.head.innerHTML = '<meta property="og:title" content="Talk 7.mov">';
    expect(declaredMediaFilename(document, { transport: false })).toBe("Talk 7.mov");
    document.head.innerHTML = "";
  });

  it("does not take a transport stream name from text alone: .ts also names source files", () => {
    for (const name of ["utils.ts", "capture.m2ts", "stream.mpegts"]) {
      document.body.innerHTML = `<h1>${name}</h1>`;
      // Only a caller that holds a MIME type or a media element for the file may take it.
      expect(declaredMediaFilename(document, { transport: true })).toBe(name);
      expect(declaredMediaFilename(document, { transport: false })).toBeUndefined();
    }
  });

  it("lists each declared file link of a page without a player as a choice of its own", () => {
    document.body.innerHTML = `<a href="/files/a.mp4" download>A</a><a href="/files/b" type="video/webm">B</a><a href="/files/c.mp4">plain</a>`;
    expect(publishedFileLinks(document, page)).toEqual([
      { url: "https://player.example/files/a.mp4", filenameHint: "a.mp4", named: false },
      { url: "https://player.example/files/b", named: false },
    ]);
  });

  it("offers no file on a page that names none: a link there is one of the page's sources, not the page's file", () => {
    // The page plays one video and links another. Nothing on it names a file.
    document.body.innerHTML = `<main><h1>Making of the album</h1><video src="https://cdn.example/stream/main.mp4"></video>
      <a download href="https://cdn.example/extras/trailer.mp4">Download the trailer</a></main>`;
    expect(declaredMediaFilename(document, { transport: true })).toBeUndefined();
    expect(fileDownloadOffer(document, page)).toBeUndefined();
    // The link is still declared, to be checked and listed as a card of its own.
    expect(publishedFileLinks(document, page)).toEqual([{ url: "https://cdn.example/extras/trailer.mp4", filenameHint: "trailer.mp4", named: false }]);
  });
});
