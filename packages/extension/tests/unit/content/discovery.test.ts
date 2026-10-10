// @vitest-environment-options {"url":"https://player.example/watch/1"}
import { beforeEach, describe, expect, it } from "vitest";
import { discoverPageMedia } from "../../../src/content/discovery";

const page = "https://player.example/watch/1";
function script(text: string): void {
  const node = document.createElement("script");
  node.type = "application/x-player-config";
  node.textContent = text;
  document.body.appendChild(node);
}

beforeEach(() => { document.body.innerHTML = ""; });

describe("literal player quality discovery", () => {
  it("finds grouped qualities without playback and excludes login redirects and thumbnails", () => {
    script(`var options = {
      video_url: 'https://cdn.example/clip.mp4/?token=one', video_url_text: '480p',
      video_alt_url: 'https://cdn.example/clip_720p.mp4/?token=two', video_alt_url_text: '720p',
      video_alt_url2: 'https://player.example/?login', video_alt_url2_text: '1080p', video_alt_url2_redirect: '1',
      preview_url: 'https://cdn.example/preview.mp4.jpg'
    };`);
    const media = discoverPageMedia(document, page);
    expect(media.map(m => m.url)).toEqual([
      "https://cdn.example/clip.mp4/?token=one", "https://cdn.example/clip_720p.mp4/?token=two",
    ]);
    expect(media.map(m => m.quality?.height)).toEqual([480, 720]);
    expect(media[0]!.quality?.groupId).toBe(media[1]!.quality?.groupId);
    expect(document.querySelector("video")).toBeNull();
  });

  it("supports JSON source arrays and escaped URLs without executing page code", () => {
    script(String.raw`window.config = { sources: [
      {file:"https:\/\/cdn.example\/movie.mp4?x=1&y=2", label:"480p"},
      {file:"https:\/\/cdn.example\/movie-hd.mp4", label:"1080p"}
    ] }; throw new Error('must never execute');`);
    const media = discoverPageMedia(document, page);
    expect(media.map(m => m.quality?.height)).toEqual([480, 1080]);
    expect(media[0]!.url).toBe("https://cdn.example/movie.mp4?x=1&y=2");
    expect(media[0]!.quality?.groupId).toBe(media[1]!.quality?.groupId);
  });

  it("does not recover explicitly redirected entries through the generic URL scan", () => {
    script(`const config = {video_url:'/a.mp4', video_url_text:'480p',
      video_alt_url:'/restricted.mp4', video_alt_url_text:'1080p', video_alt_url_redirect:true};`);
    expect(discoverPageMedia(document, page).map(m => m.url)).toEqual(["https://player.example/a.mp4"]);
  });

  it("does not mix adjacent players or interpret comments and strings as objects", () => {
    script(`const ignored = "{ video_url: 'https://cdn.example/fake.mp4' }";
      const template = \`{ video_url: 'https://cdn.example/template.mp4' }\`;
      // { video_url: 'https://cdn.example/comment.mp4' }
      const a = {video_url:'/a.mp4', video_url_text:'720p'};
      const b = {video_url:'/b.mp4', video_url_text:'1080p'};`);
    const media = discoverPageMedia(document, page);
    expect(media.map(m => m.url)).toEqual(["https://player.example/a.mp4"]);
    expect(media[0]!.quality?.height).toBe(720);
  });

  it("keeps the main player's qualities and ignores 20 recommendation previews", () => {
    document.body.innerHTML = Array.from({ length: 20 }, (_, n) =>
      `<a href="/preview-${n}.mp4" data-preview="/hover-${n}.mp4"><img src="/poster-${n}.jpg"></a>`).join("");
    script(`const related = [{file:'/recommendation.mp4',label:'2160p'}];
      const main = {video_url:'/main.mp4',video_url_text:'480p',video_alt_url:'/main-hd.mp4',video_alt_url_text:'720p'};
      const previews = [{src:'/hover.mp4',label:'1080p'}];`);
    const media = discoverPageMedia(document, page);
    expect(media.map(m => m.url)).toEqual(["https://player.example/main.mp4", "https://player.example/main-hd.mp4"]);
    expect(media.map(m => m.quality?.height)).toEqual([480, 720]);
    expect(media[0]!.quality?.groupId).toBe(media[1]!.quality?.groupId);
  });

  it("matches the largest visible video to its config even when another config appears first", () => {
    document.body.innerHTML = `<video id="preview" src="/preview.mp4"></video><main><video id="main" src="/main.mp4" controls></video></main>`;
    for (const [id, width, height] of [["preview", 160, 90], ["main", 960, 540]] as const) {
      document.getElementById(id)!.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() {} });
    }
    script(`const other = {video_url:'/preview.mp4',video_url_text:'1080p',video_alt_url:'/preview-4k.mp4',video_alt_url_text:'2160p'};
      const actual = {video_url:'/main.mp4',video_url_text:'480p',video_alt_url:'/main-hd.mp4',video_alt_url_text:'720p'};`);
    expect(discoverPageMedia(document, page).map(m => m.url)).toEqual([
      "https://player.example/main.mp4", "https://player.example/main-hd.mp4",
    ]);
  });

  it("does not scrape arbitrary links, attributes or URL strings as playable media", () => {
    document.body.innerHTML = `<a href="/linked.mp4">link</a><div data-preview="/hover.mp4"></div>`;
    script(`const preview = '/recommendation.mp4'; // https://cdn.example/comment.mp4`);
    expect(discoverPageMedia(document, page)).toEqual([]);
  });

  it("ignores hidden preview elements before the main player creates a video element", () => {
    document.body.innerHTML = `<div style="display:none"><video src="/preview.mp4"></video></div>`;
    script(`const recommendations = [{file:'/related.mp4',label:'2160p'}];
      const config = {sources:[{file:'/main.mp4',label:'480p'},{file:'/main-hd.mp4',label:'720p'}]};`);
    expect(discoverPageMedia(document, page).map(m => m.url)).toEqual([
      "https://player.example/main.mp4", "https://player.example/main-hd.mp4",
    ]);
  });

  it("keeps nested labelled manifest alternatives in the same player", () => {
    script(String.raw`window.config = {"stream":{"url":"\/hls\/master.m3u8","urls":{"1080p":"\/hls-hd\/master.m3u8"}}};`);
    const media = discoverPageMedia(document, page);
    expect(media.map(m => m.url).sort()).toEqual([
      "https://player.example/hls-hd/master.m3u8", "https://player.example/hls/master.m3u8",
    ]);
    expect(media[0]!.quality?.groupId).toBe(media[1]!.quality?.groupId);
  });

  it("does not merge different playlist items into one quality list", () => {
    script(`const config = {playlist:[
      {sources:[{file:'/main.mp4',label:'480p'},{file:'/main-hd.mp4',label:'720p'}]},
      {sources:[{file:'/next.mp4',label:'1080p'},{file:'/next-hd.mp4',label:'2160p'}]}
    ]};`);
    expect(discoverPageMedia(document, page).map(m => m.url)).toEqual([
      "https://player.example/main.mp4", "https://player.example/main-hd.mp4",
    ]);
  });

  it("reads labelled source siblings and rejects fragments, non-http URLs and image suffixes", () => {
    document.body.innerHTML = `<video><source src="/low.mp4" label="480p"><source src="/high.mp4/" label="720p"></video>
      <a href="https://cdn.example/init.mp4">init</a><a href="https://cdn.example/seg-20.mp4">segment</a>
      <img src="https://cdn.example/preview.mp4.jpg">`;
    script(`const data = {video_url:'javascript:alert(1)', video_url_text:'1080p'};`);
    const media = discoverPageMedia(document, page);
    expect(media.map(m => m.url)).toEqual(["https://player.example/low.mp4", "https://player.example/high.mp4/"]);
    expect(media.map(m => m.quality?.height)).toEqual([480, 720]);
    expect(media[0]!.quality?.groupId).toBe(media[1]!.quality?.groupId);
  });
});
