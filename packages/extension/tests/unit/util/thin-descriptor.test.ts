import { describe, expect, it } from "vitest";
import { dispatch, type StreamDescriptor, type StreamId, type UserChoice, type Variant, type VariantId } from "@savemedia/core";
import { MAX_KEPT_PARTS, MAX_KEPT_PART_BYTES, rowBytes, thinDescriptor } from "../../../src/util/thin-descriptor";
import { downloadOptions } from "../../../src/util/downloadable";
import { dashDescriptor, directDescriptor, hlsDescriptor } from "../popup/helpers/descriptors";

const choice: UserChoice = { outputMode: "Original", filename: "clip.mp4", variantId: null, audioRenditionId: null };
const urls = (count: number, base = "https://cdn.example/v/") => Array.from({ length: count }, (_, n) => `${base}seg-${n}.m4s`);

function hlsMedia(count: number, base?: string): StreamDescriptor {
  return hlsDescriptor({ id: "media" as StreamId, source: { kind: "hls-manifest", manifestUrl: "https://cdn.example/v/media.m3u8", type: "media" },
    variants: [{ ...hlsDescriptor().variants[0]!, id: "https://cdn.example/v/media.m3u8#media" as VariantId, audioRenditionId: null,
      segmentRef: { kind: "hls-segments", playlistUrl: "https://cdn.example/v/media.m3u8", initSegmentUrl: null, segmentUrls: urls(count, base), encryption: null } }] });
}

function dash(count: number): StreamDescriptor {
  const video = dashDescriptor().variants[0]!;
  const track = (id: string): Variant => ({ ...video, id: id as VariantId,
    segmentRef: { kind: "dash-segments", initUrl: `https://cdn.example/${id}/init.m4s`, mediaUrls: urls(count, `https://cdn.example/${id}/`) } });
  return dashDescriptor({ variants: [track("v1080"), track("v720")],
    audioRenditions: [{ ...track("audio"), width: null, height: null, videoCodec: null, audioRenditionId: "audio" as never }] });
}

const lists = (descriptor: StreamDescriptor): (readonly string[])[] => [...descriptor.variants, ...(descriptor.audioRenditions ?? [])].map(track =>
  track.segmentRef.kind === "hls-segments" ? track.segmentRef.segmentUrls : track.segmentRef.kind === "dash-segments" ? track.segmentRef.mediaUrls : []);

describe("the row a stream is listed as", () => {
  it("keeps an even sample of a long segment list, beginning with the first segment", () => {
    const full = hlsMedia(10_000);
    const thin = thinDescriptor(full);
    const [kept] = lists(thin);
    expect(kept!.length).toBeGreaterThan(MAX_KEPT_PARTS / 2);
    expect(kept!.length).toBeLessThanOrEqual(MAX_KEPT_PARTS);
    expect(kept![0]).toBe("https://cdn.example/v/seg-0.m4s");
    // Even: every kept address is the same number of segments after the one before.
    const numbers = kept!.map(url => Number(/seg-(\d+)/.exec(url)![1]));
    expect(new Set(numbers.slice(1).map((n, index) => n - numbers[index]!)).size).toBe(1);
    expect(numbers.at(-1)!).toBeGreaterThan(9_900);
    expect(rowBytes(thin)).toBeLessThan(rowBytes(full) / 20);
    // The full descriptor is left as it was.
    expect(lists(full)[0]).toHaveLength(10_000);
  });

  it("returns a short stream, a master playlist and a file as they are", () => {
    for (const row of [hlsMedia(40), hlsDescriptor(), directDescriptor(), dashDescriptor()]) expect(thinDescriptor(row)).toBe(row);
    const thin = thinDescriptor(hlsMedia(10_000));
    expect(thinDescriptor(thin)).toBe(thin);
  });

  it("splits what it keeps across the tracks of a stream, and keeps less of long addresses", () => {
    const thin = thinDescriptor(dash(5_000));
    const kept = lists(thin);
    expect(kept).toHaveLength(3);
    for (const list of kept) expect(list.length).toBeLessThanOrEqual(MAX_KEPT_PARTS / 3);
    expect(kept.flat().length).toBeGreaterThan(MAX_KEPT_PARTS / 2);
    // Every track still has its init section.
    expect(thin.variants.map(track => track.segmentRef.kind === "dash-segments" && track.segmentRef.initUrl))
      .toEqual(["https://cdn.example/v1080/init.m4s", "https://cdn.example/v720/init.m4s"]);
    const long = thinDescriptor(hlsMedia(10_000, `https://cdn.example/${"t".repeat(6_000)}/`));
    const text = lists(long)[0]!.reduce((sum, url) => sum + url.length, 0);
    expect(text).toBeLessThanOrEqual(MAX_KEPT_PART_BYTES);
    expect(lists(long)[0]!.length).toBeGreaterThanOrEqual(1);
  });

  it("changes nothing about what can be saved, or how", () => {
    for (const full of [hlsMedia(10_000), dash(5_000), dashDescriptor()]) {
      const thin = thinDescriptor(full);
      const plan = (row: StreamDescriptor) => { const made = dispatch(row, choice); return made.kind === "refuse" ? made : { kind: made.kind }; };
      expect(plan(thin)).toEqual(plan(full));
      expect(downloadOptions(thin).map(option => option.choice)).toEqual(downloadOptions(full).map(option => option.choice));
    }
    // A track whose list was empty (a live or byte-range DASH track) stays unsaveable.
    const live = dashDescriptor({ variants: [{ ...dashDescriptor().variants[0]!, segmentRef: { kind: "dash-segments", initUrl: "", mediaUrls: [] } }] });
    expect(dispatch(thinDescriptor(live), choice)).toEqual(dispatch(live, choice));
  });

  it("keeps the key of every kept segment with its segment", () => {
    const full = hlsMedia(1_000);
    const ref = full.variants[0]!.segmentRef;
    if (ref.kind !== "hls-segments") throw new Error("fixture");
    const keyed: StreamDescriptor = { ...full, variants: [{ ...full.variants[0]!, segmentRef: { ...ref,
      segmentKeys: ref.segmentUrls.map((_, n) => ({ keyUri: `https://cdn.example/key-${n}`, iv: null, mediaSequence: n })) } }] };
    const thinRef = thinDescriptor(keyed).variants[0]!.segmentRef;
    if (thinRef.kind !== "hls-segments") throw new Error("fixture");
    expect(thinRef.segmentKeys).toHaveLength(thinRef.segmentUrls.length);
    thinRef.segmentUrls.forEach((url, index) => expect(thinRef.segmentKeys![index]!.keyUri).toBe(`https://cdn.example/key-${/seg-(\d+)/.exec(url)![1]}`));
  });
});
