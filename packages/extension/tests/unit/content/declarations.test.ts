// @vitest-environment-options {"url":"https://player.example/watch/1"}
import { beforeEach, describe, expect, it } from "vitest";
import { declaredMedia, scriptLiterals } from "../../../src/content/declarations";
import { elementKeys } from "../../../src/content/media-tree";
import type { DeclaredGroup } from "../../../src/types/page-facts";

const page = "https://player.example/watch/1";

// A data type, so the test page does not run the text as code.
function script(text: string, type = "application/x-player-config", parent: Element = document.body): HTMLScriptElement {
  const node = document.createElement("script");
  node.type = type;
  node.textContent = text;
  parent.appendChild(node);
  return node;
}

function read(eligible: HTMLVideoElement[] = [...document.querySelectorAll("video")]) {
  const keyOf = elementKeys();
  const result = declaredMedia(document, page, eligible, keyOf);
  return { ...result, of: (video: HTMLVideoElement) => result.byElement.get(keyOf(video)) ?? [] };
}

const urls = (groups: readonly DeclaredGroup[]) => groups.map(group => group.sources.map(source => source.url.replace("https://player.example", "")));
const heights = (groups: readonly DeclaredGroup[]) => groups.map(group => group.sources.map(source => source.height));

beforeEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; });

describe("what a page's own data declares", () => {
  it("groups by structure: nested alternatives of one stream are one group", () => {
    script('{"stream":{"url":"\\/hls\\/master.m3u8","urls":{"1080p":"\\/hls-fmp4\\/master.m3u8"}}}', "application/json");
    const { page: groups } = read();
    expect(urls(groups)).toEqual([["/hls/master.m3u8", "/hls-fmp4/master.m3u8"]]);
    expect(heights(groups)).toEqual([[undefined, 1080]]);
    expect(groups[0]).toMatchObject({ via: "script", proximity: 3, primary: false });
  });

  it("an array whose entries each state a different height lists renditions of one video", () => {
    script('{"sources":[{"src":"/low/clip.mp4","label":"480p"},{"src":"/direct/clip.mp4","label":"720p"}]}', "application/json");
    const { page: groups } = read();
    expect(urls(groups)).toEqual([["/low/clip.mp4", "/direct/clip.mp4"]]);
    expect(heights(groups)).toEqual([[480, 720]]);
    expect(new Set(groups[0]!.sources.map(source => source.groupId)).size).toBe(1);
  });

  it("any other array lists different videos, and two top-level objects are two groups", () => {
    script('{"players":[{"file":"/a.mp4"},{"file":"/b.mp4"}]}', "application/json");
    script('{"file":"/c.mp4"}', "application/json");
    expect(urls(read().page)).toEqual([["/a.mp4"], ["/b.mp4"], ["/c.mp4"]]);
  });

  it("does not merge the items of a playlist into one quality list", () => {
    script(`const config = {playlist:[
      {sources:[{file:'/main.mp4',label:'480p'},{file:'/main-hd.mp4',label:'720p'}]},
      {sources:[{file:'/next.mp4',label:'1080p'},{file:'/next-hd.mp4',label:'2160p'}]}
    ]};`);
    expect(urls(read().page)).toEqual([["/main.mp4", "/main-hd.mp4"], ["/next.mp4", "/next-hd.mp4"]]);
  });

  it("reads values, not key names: renamed keys give the same groups", () => {
    script('{"quellen":[{"adresse":"/low/clip.mp4","groesse":"480p"},{"adresse":"/direct/clip.mp4","groesse":"720p"}]}', "application/json");
    const renamed = read().page;
    expect(urls(renamed)).toEqual([["/low/clip.mp4", "/direct/clip.mp4"]]);
    expect(heights(renamed)).toEqual([[480, 720]]);
  });

  it("takes a height from a label next to one address, and none when one object holds several addresses and labels", () => {
    script('{"a":"/low/clip.mp4","a_text":"480p","b":"/direct/clip.mp4","b_text":"720p"}', "application/json");
    script('{"1080p":"/hd.mp4","360p":"/sd.mp4"}', "application/json");
    script('{"file":"/one.mp4","height":2160}', "application/json");
    const groups = read().page;
    expect(urls(groups)).toEqual([["/low/clip.mp4", "/direct/clip.mp4"], ["/hd.mp4", "/sd.mp4"], ["/one.mp4"]]);
    expect(heights(groups)).toEqual([[undefined, undefined], [1080, 360], [2160]]);
  });

  it("ignores images, bare names and addresses that are not media", () => {
    script('{"poster":"/a.jpg","name":"clip.mp4","page":"/watch/2","script":"/player.ts","js":"javascript:alert(1)","blob":"blob:https://player.example/1"}', "application/json");
    expect(read().page).toEqual([]);
  });

  it("lets a sibling media type make an extensionless address a candidate, also for a transport stream", () => {
    script('{"src":"/api/stream/9","type":"application/x-mpegURL"}', "application/json");
    script('{"src":"/files/whole.ts","type":"video/mp2t"}', "application/json");
    script('{"src":"/files/code.ts"}', "application/json");
    const groups = read().page;
    expect(urls(groups)).toEqual([["/api/stream/9"], ["/files/whole.ts"]]);
    expect(groups[0]!.sources[0]!.mime).toBe("application/x-mpegURL");
  });

  it("reads object and array literals in inline scripts, with escapes, and never comments, strings or code", () => {
    script(`
      // {"file": "/commented.mp4"}
      /* {file: '/block.mp4'} */
      var text = "{\\"file\\": \\"/string.mp4\\"}";
      function setup() { return start({file: '\\/in-call.mp4', label: "720p"}); }
      window.player = {sources: [{src: "https:\\/\\/cdn.example\\/a.m3u8?x=1&amp;y=2"}]};
      const pick = flag ? "/ternary-a.mp4" : "/ternary-b.mp4";
    `);
    expect(urls(read().page)).toEqual([["/in-call.mp4"], ["https://cdn.example/a.m3u8?x=1&y=2"]]);
  });

  it("the tokenizer keeps nesting and nothing else: one pass, trees out", () => {
    expect(scriptLiterals(`a = {b: {c: [1, "x", true, null]}, 'd': "e"}; f({g: -2.5});`))
      .toEqual([{ b: { c: [1, "x", true, null] }, d: "e" }, { g: -2.5 }]);
    expect(scriptLiterals("if (x) { y(); } else { z = [1, 2]; }")).toEqual([[1, 2]]);
  });

  it("reads JSON on the video and on its ancestors, nearest first", () => {
    document.body.innerHTML = `<main><div id="player" data-setup='{"sources":[{"src":"/hls/master.m3u8","type":"application/x-mpegURL"}]}'>
      <video data-config='{"file":"/own.mp4"}'></video></div></main>`;
    script('{"file":"/in-container.mp4"}', "application/json", document.querySelector("#player")!);
    script('{"file":"/page.mp4"}', "application/json");
    const video = document.querySelector("video")!;
    const { of, page: groups } = read();
    expect(of(video).map(group => [group.via, group.proximity, group.sources[0]!.url.replace("https://player.example", "")])).toEqual([
      ["attribute", 0, "/own.mp4"], ["attribute", 1, "/hls/master.m3u8"], ["script", 2, "/in-container.mp4"]]);
    expect(urls(groups)).toEqual([["/page.mp4"]]);
  });

  it("a container ends where a second eligible video begins, so each script is read for one player", () => {
    document.body.innerHTML = `<section><article id="one"><video id="a"></video></article><article id="two"><video id="b"></video></article></section>`;
    script('{"file":"/one.mp4"}', "application/json", document.querySelector("#one")!);
    script('{"file":"/two.mp4"}', "application/json", document.querySelector("#two")!);
    script('{"file":"/shared.mp4"}', "application/json", document.querySelector("section")!);
    const { of, page: groups } = read();
    expect(urls(of(document.querySelector("#a")!))).toEqual([["/one.mp4"]]);
    expect(urls(of(document.querySelector("#b")!))).toEqual([["/two.mp4"]]);
    expect(urls(groups)).toEqual([["/shared.mp4"]]);
  });

  it("a video that is not eligible claims nothing: its data stays page data", () => {
    document.body.innerHTML = `<div id="hidden"><video id="preview" src="/preview.mp4"></video></div>`;
    script('{"file":"/declared.mp4"}', "application/json", document.querySelector("#hidden")!);
    const { byElement, page: groups } = read([]);
    expect(byElement.size).toBe(0);
    expect(urls(groups)).toEqual([["/declared.mp4"]]);
  });

  it("reads a lazy player's address from its other attributes until a standard source is assigned", () => {
    document.body.innerHTML = `<video data-src="/lazy.mp4" poster="/poster.jpg"><source data-file="/alt.webm" type="video/webm" label="720p"></video>`;
    const video = document.querySelector("video")!;
    expect(urls(read().of(video))).toEqual([["/lazy.mp4", "/alt.webm"]]);
    expect(read().of(video)[0]).toMatchObject({ via: "element", proximity: 0 });
    video.setAttribute("src", "/assigned.mp4");
    expect(urls(read().of(video))).toEqual([["/assigned.mp4"]]);
  });

  it("lists a video's own sources with their types and labelled heights, a whole .ts file included", () => {
    document.body.innerHTML = `<video><source src="/low.mp4" label="480p"><source src="/high.mp4" label="720p"><source src="/whole.ts" type="video/mp2t"></video>`;
    const groups = read().of(document.querySelector("video")!);
    expect(urls(groups)).toEqual([["/low.mp4", "/high.mp4", "/whole.ts"]]);
    expect(heights(groups)).toEqual([[480, 720, undefined]]);
  });

  it("reads schema.org and Open Graph video metadata as page groups, with types, the main entity and the stills", () => {
    document.head.innerHTML = `<meta property="og:video" content="https://cdn.example/og"><meta property="og:video:type" content="video/mp4">
      <meta property="og:image" content="https://cdn.example/still.jpg">`;
    script(JSON.stringify({ "@context": "https://schema.org", "@type": "WebPage", url: page,
      mainEntity: { "@type": "VideoObject", contentUrl: "https://cdn.example/main.mp4", thumbnailUrl: "https://cdn.example/thumb.jpg", height: 1080 } }), "application/ld+json");
    const { page: groups, thumbnails } = read();
    expect(groups.map(group => [group.via, group.primary, group.sources[0]!.url, group.sources[0]!.height, group.sources[0]!.mime])).toEqual([
      ["json-ld", true, "https://cdn.example/main.mp4", 1080, undefined], ["og", false, "https://cdn.example/og", undefined, "video/mp4"]]);
    expect(thumbnails).toEqual(["https://cdn.example/thumb.jpg", "https://cdn.example/still.jpg"]);
  });

  it("takes og:image as the video's still when the page's og:video is media itself, or the page declares itself a video", () => {
    const image = `<meta property="og:image" content="https://cdn.example/poster.jpg"><meta property="og:image:secure_url" content="https://cdn.example/poster-s.jpg">`;
    const both = ["https://cdn.example/poster.jpg", "https://cdn.example/poster-s.jpg"];
    // A file or a stream by its type, and a video with no type stated.
    for (const type of [`<meta property="og:video:type" content="video/mp4">`, `<meta property="og:video:type" content="application/vnd.apple.mpegurl">`, ""]) {
      document.head.innerHTML = `<meta property="og:video" content="https://cdn.example/v/31">${type}${image}`;
      expect(read(), type).toMatchObject({ thumbnails: both, playerStills: [] });
    }
    // A player page: the video is declared as an embed page, which is no source to check, and the page says it is a video.
    for (const type of ["video.other", "video.movie", "VIDEO.EPISODE", "video"]) {
      document.head.innerHTML = `<meta property="og:type" content="${type}"><meta property="og:video" content="https://player.example/embed/31">
        <meta property="og:video:type" content="text/html">${image}`;
      const player = read();
      expect(player.page, type).toEqual([]);
      expect(player, type).toMatchObject({ thumbnails: both, playerStills: [] });
    }
  });

  it("takes og:image next to an embed-only og:video as a still only on a player: an article's lead photo is declared the same way", () => {
    // An article with a video further down: the embed page is its og:video, and the lead photo is its og:image.
    for (const type of [`<meta property="og:type" content="article">`, `<meta property="og:type" content="website">`, `<meta property="og:type" content="videogame">`, ""]) {
      document.head.innerHTML = `${type}<meta property="og:video" content="https://player.example/embed/31"><meta property="og:video:type" content="text/html">
        <meta property="og:image" content="https://cdn.example/hero.jpg">`;
      expect(read(), type).toMatchObject({ page: [], thumbnails: [], playerStills: ["https://cdn.example/hero.jpg"] });
    }
    // A picture schema.org declares as a video's still is one everywhere, and is not listed twice.
    script(JSON.stringify({ "@context": "https://schema.org", "@type": "VideoObject", contentUrl: "https://cdn.example/main.mp4", thumbnailUrl: "https://cdn.example/hero.jpg" }),
      "application/ld+json");
    expect(read()).toMatchObject({ thumbnails: ["https://cdn.example/hero.jpg"], playerStills: [] });
    // A page that declares no video: its og:image is a picture like any other.
    document.body.innerHTML = "";
    document.head.innerHTML = `<meta property="og:type" content="video.other"><meta property="og:image" content="https://cdn.example/photo.jpg"><meta property="og:video:type" content="text/html">`;
    expect(read()).toMatchObject({ thumbnails: [], playerStills: [] });
    document.head.innerHTML = `<meta property="og:video" content=""><meta property="og:image" content="https://cdn.example/photo.jpg">`;
    expect(read()).toMatchObject({ thumbnails: [], playerStills: [] });
  });

  it("offers a page's declared file link as its primary group, with the name the page gives", () => {
    document.body.innerHTML = `<h1>Clip 31.mov</h1><a href="/get/31" download>Get</a>`;
    expect(read().page).toEqual([{ groupId: `${page}#page:link:0:`, via: "link", proximity: 3, primary: true,
      sources: [{ url: "https://player.example/get/31", groupId: `${page}#page:link:0:`, filenameHint: "Clip 31.mov" }] }]);
  });

  it("gives a page's one declared source the file name the page shows", () => {
    document.body.innerHTML = `<h1>Test pattern 31.mov</h1><video src="/signed-movie?file=31"></video>`;
    const video = document.querySelector("video")!;
    expect(read().of(video)[0]!.sources).toEqual([expect.objectContaining({ url: "https://player.example/signed-movie?file=31", filenameHint: "Test pattern 31.mov" })]);
    script('{"file":"/second.mp4"}', "application/json");
    expect(read().of(video)[0]!.sources[0]).not.toHaveProperty("filenameHint");
  });

  it("gives a transport stream name the page shows only to a media element's source or a source with that type", () => {
    // ".ts" also names TypeScript sources: the heading alone names no media file.
    document.body.innerHTML = `<h1>capture.ts</h1><video src="/stream/31"></video>`;
    expect(read().of(document.querySelector("video")!)[0]!.sources[0]).toMatchObject({ filenameHint: "capture.ts" });
    document.body.innerHTML = `<h1>utils.ts</h1>`;
    script('{"file":"/raw/clip.mp4"}', "application/json");
    expect(read().page[0]!.sources[0]).not.toHaveProperty("filenameHint");
    document.body.innerHTML = `<h1>capture.ts</h1>`;
    script('{"file":"/stream/31/data","type":"video/mp2t"}', "application/json");
    expect(read().page[0]!.sources[0]).toMatchObject({ mime: "video/mp2t", filenameHint: "capture.ts" });
  });

  it("gives every group a stable id within the document", () => {
    script('{"file":"/a.mp4"}', "application/json");
    script('{"file":"/b.mp4"}', "application/json");
    const first = read().page.map(group => group.groupId);
    expect(first).toEqual(read().page.map(group => group.groupId));
    expect(new Set(first).size).toBe(2);
    expect(first[0]).toMatch(/^https:\/\/player\.example\/watch\/1#page:script:/);
  });

  it("stays bounded: at most 80 sources, and a script is tokenized once however often the page is read", () => {
    const many = Array.from({ length: 200 }, (_item, n) => `{"file":"/v/${n}.mp4"}`).join(",");
    const node = script(`window.list = [${many}];`);
    expect(read().page.flatMap(group => group.sources)).toHaveLength(80);
    // The second read must not touch the text again: a getter that throws proves the cache was used.
    let reads = 0;
    const text = node.textContent!;
    Object.defineProperty(node, "textContent", { configurable: true, get: () => { reads++; return text; } });
    read();
    read();
    expect(reads).toBe(2);
    expect(read().page.flatMap(group => group.sources)).toHaveLength(80);
  });

  it("skips scripts that cannot name media before tokenizing them, and stops at the size budget", () => {
    script(`window.state = ${JSON.stringify({ items: Array.from({ length: 2000 }, (_item, n) => ({ id: n, title: `Item ${n}`, href: `/item/${n}` })) })};`);
    expect(read().page).toEqual([]);
    script(`window.big = {file: "/too-big.mp4", pad: "${"x".repeat(2_000_001)}"};`);
    expect(read().page).toEqual([]);
  });

  it("reads a script for every suffix the shared rules know, not for a list of its own", () => {
    script(`player({"src":"/media/talk.qt"})`);
    script(`setup({"file":"/media/second.m4v"})`);
    script(`track({"page":"/watch/2", "ts": 12})`);
    const urls = read([]).page.flatMap(group => group.sources.map(source => source.url));
    expect(urls).toEqual(expect.arrayContaining(["https://player.example/media/talk.qt", "https://player.example/media/second.m4v"]));
    expect(urls).toHaveLength(2);
  });
});
