// @vitest-environment-options {"url":"https://player.example/watch/1"}
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let posted: { kind: string; url: string | null }[] = [];
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeAll(async () => { await import("../../../src/content/main"); });
beforeEach(() => {
  document.body.innerHTML = "";
  posted = [];
  vi.spyOn(window, "postMessage").mockImplementation(message => { posted.push(message); });
});

describe("generic media-element discovery", () => {
  it("observes a player switching the src attribute without replacing its video element", async () => {
    const video = document.createElement("video");
    video.src = "/low.mp4/";
    document.body.appendChild(video);
    await flush();
    expect(posted.some(m => m.url === "https://player.example/low.mp4/")).toBe(true);
    posted = [];
    video.src = "/high.mp4/?token=example";
    await flush();
    expect(posted).toContainEqual(expect.objectContaining({ kind: "media-element", url: "https://player.example/high.mp4/?token=example" }));
  });

  it("observes a source inserted into an existing player and later changed", async () => {
    const video = document.createElement("video");
    document.body.appendChild(video);
    await flush();
    const source = document.createElement("source");
    source.src = "/first.mp4";
    video.appendChild(source);
    await flush();
    expect(posted.some(m => m.url === "https://player.example/first.mp4")).toBe(true);
    posted = [];
    source.src = "/second.mp4";
    await flush();
    expect(posted.some(m => m.url === "https://player.example/second.mp4")).toBe(true);
  });
});
