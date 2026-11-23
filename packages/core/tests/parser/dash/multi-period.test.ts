import { describe, expect, it } from "vitest";
import { parseDash } from "../../../src/parser/dash/adapter";
import { dispatch } from "../../../src/engine/dispatch";
import { classify } from "../../../src/classifier/classify";
import type { UserChoice } from "../../../src/types/job";

// A static manifest of two periods, as server-side ad insertion writes one
// for a finished video: an ad period, then the video. Each period has its
// own header and its own timeline.
const MPD_URL = "https://media.example/clip.mpd";
const EMPTY = { kind: "dash-segments", initUrl: "", mediaUrls: [] };
const choice: UserChoice = { outputMode: "Original", filename: "out.mp4", variantId: null, audioRenditionId: null };

const template = (prefix: string, track: "v" | "a") =>
  `<SegmentTemplate initialization="${prefix}${track}-init.mp4" media="${prefix}${track}-$Number$.m4s" startNumber="1" duration="2" timescale="1"/>`;

function period(id: string, start: string, layout: "own-base" | "own-path", height = 720): string {
  // The periods' files lie under different addresses: named by a BaseURL of the period, or inside the template.
  const base = layout === "own-base" ? `<BaseURL>${id}/</BaseURL>` : "";
  const prefix = layout === "own-path" ? `${id}/` : "";
  return `<Period id="${id}" start="${start}" duration="PT4S">${base}
    <AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="800000" width="${Math.round(height * 16 / 9)}" height="${height}" codecs="avc1.64001f">
      ${template(prefix, "v")}</Representation></AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" lang="en"><Representation id="a" bandwidth="64000" codecs="mp4a.40.2">
      ${template(prefix, "a")}</Representation></AdaptationSet>
  </Period>`;
}

const mpd = (...periods: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT8S" minBufferTime="PT1S">${periods.join("\n")}</MPD>`;

async function plan(text: string, variantId: string | null = null) {
  const descriptor = await classify({ tabId: 1, pageUrl: "https://site.example/watch", url: MPD_URL,
    headers: { "content-type": "application/dash+xml" }, bodyBytes: null, manifestText: text });
  return { descriptor, plan: dispatch(descriptor, { ...choice, variantId: variantId as UserChoice["variantId"] }) };
}

describe("a DASH manifest of several periods", () => {
  it.each([
    ["each under its own BaseURL", "own-base"],
    ["each under its own path", "own-path"],
  ] as const)("is not put together from its periods, %s: no track names anything to fetch", (_name, layout) => {
    const parsed = parseDash(mpd(period("ad", "PT0S", layout), period("main", "PT4S", layout)), MPD_URL);
    expect(parsed.videoVariants.length).toBeGreaterThan(0);
    expect(parsed.audioRenditions.length).toBeGreaterThan(0);
    for (const track of [...parsed.videoVariants, ...parsed.audioRenditions]) expect(track.segmentRef).toEqual(EMPTY);
  });

  it("gives every track an id of its own, also when two periods name their representations alike", () => {
    const parsed = parseDash(mpd(period("ad", "PT0S", "own-base"), period("main", "PT4S", "own-base", 1080)), MPD_URL);
    const ids = [...parsed.videoVariants, ...parsed.audioRenditions].map(track => track.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(parsed.videoVariants.map(track => [track.id, track.height])).toEqual([[`${MPD_URL}#v`, 720], [`${MPD_URL}#v~2`, 1080]]);
  });

  it.each(["own-base", "own-path"] as const)("is refused as a layout that cannot be assembled, never saved as its first period (%s)", async layout => {
    const text = mpd(period("ad", "PT0S", layout), period("main", "PT4S", layout, 1080));
    const { descriptor, plan: best } = await plan(text);
    expect(descriptor.protocol).toBe("dash");
    expect(descriptor.drm).toBeNull();
    expect(best).toEqual({ kind: "refuse", reason: "dash_unsupported" });
    // Whichever quality is asked for: the ad period's video is never what a save gets.
    for (const variant of descriptor.variants) expect((await plan(text, variant.id)).plan).toEqual({ kind: "refuse", reason: "dash_unsupported" });
  });

  it("leaves a manifest of one period as it was: its tracks are fetched and merged", async () => {
    const { plan: single } = await plan(mpd(period("main", "PT0S", "own-base")));
    expect(single).toMatchObject({ kind: "av-merge",
      video: { initUrl: "https://media.example/main/v-init.mp4", segmentUrls: ["https://media.example/main/v-1.m4s", "https://media.example/main/v-2.m4s"] },
      audio: { initUrl: "https://media.example/main/a-init.mp4", segmentUrls: ["https://media.example/main/a-1.m4s", "https://media.example/main/a-2.m4s"] } });
  });
});
