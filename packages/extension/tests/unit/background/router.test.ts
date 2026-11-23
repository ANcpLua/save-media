import { describe, it, expect, vi } from "vitest";
import { emptyTabMediaState } from "../../../src/util/tab-media-state";
import { createRouter, dispatchRefusalToError, MAX_DESCRIPTORS_PER_TAB, MAX_TAB_ROW_BYTES } from "../../../src/background/router";
import { MAX_KEPT_PARTS, rowBytes } from "../../../src/util/thin-descriptor";
import { demuxedPairDescriptor } from "../../../src/background/capture";
import { select } from "../../../src/selection/main-video";
import { directDescriptor, hlsDescriptor, dashDescriptor, drmDescriptor, clearKeyDescriptor, unassemblableDash } from "../popup/helpers/descriptors";
import { dispatch, userMessage, type UserChoice, type StreamDescriptor, type StreamId, type VariantId, type AudioRenditionId } from "@savemedia/core";
import type { BackgroundEvent } from "../../../src/background/events";
import { directResumeScope } from "../../../src/types/transfer";
import type { JobRecord, TabRecord } from "../../../src/background/state/records";
import type { RouterPersistence } from "../../../src/background/router";

/**
 * The router's surroundings. `runtime.sendMessage` records what reaches the
 * engine and `ensureEngineHost` counts how often it is opened, as one start
 * does: open, then hand over the job.
 */
function deps() {
  const runtime = { sendMessage: vi.fn<(msg: unknown) => unknown>() };
  const ensureEngineHost = vi.fn(async () => undefined);
  const emitted: BackgroundEvent[] = [];
  return {
    runtime,
    ensureEngineHost,
    emitted,
    downloads: { download: vi.fn(async (_opts: { url: string; filename: string }) => 1) },
    engine: {
      start: vi.fn(async (msg: unknown) => { await ensureEngineHost(); await runtime.sendMessage(msg); }),
      cancel: (streamId: string) => { runtime.sendMessage({ type: "cancel-job", streamId }); },
      release: vi.fn((blobUrl: string) => { runtime.sendMessage({ type: "release-output", blobUrl }); }),
      ack: vi.fn(),
      isPending: (_streamId: string) => false,
    },
    events: { emit: (event: BackgroundEvent) => { emitted.push(event); }, on: () => () => undefined },
  };
}

/** The error of a start that failed, or null: how these tests read a download result. */
async function startErr(r: ReturnType<typeof createRouter>, id: StreamId, selected: UserChoice) {
  const result = await r.startDownload(id, selected);
  return result.outcome === "failed" ? result.error : null;
}

function jobEvents(d: ReturnType<typeof deps>) {
  return d.emitted.flatMap(event => event.type === "job" ? [event] : []);
}

const NOTHING_KNOWN = emptyTabMediaState();

/** Save as the popup and Alt+S do: the shared selector picks, the router starts. */
function startBest(r: ReturnType<typeof createRouter>, tabId: number) {
  const selection = select({ descriptors: r.descriptors(tabId), failures: r.failures(tabId), media: NOTHING_KNOWN,
    jobs: r.activeJobs(tabId), facts: null, usePointer: false });
  return r.startSelected(tabId, selection.candidates);
}

function choice(overrides: Partial<UserChoice> = {}): UserChoice {
  return {
    outputMode: "Original",
    filename: "clip.mp4",
    variantId: null,
    audioRenditionId: null,
    ...overrides,
  };
}

describe("router — descriptor de-duplication", () => {
  it("keeps everything a page loaded: a declared source never hides what the player loaded", () => {
    const r = createRouter(deps());
    const played = hlsDescriptor();
    const preview = directDescriptor({ id: "preview" as StreamId, source: { kind: "direct-url", url: "https://example.com/preview.mp4", headers: {} } });
    r.addDescriptor(1, played);
    r.addDescriptor(1, preview);
    const failure = { url: "https://old-media.example/clip/playlist.m3u8", error: {
      code: "server_busy", severity: "terminal", phase: "manifest", url: "https://old-media.example/clip/playlist.m3u8", httpStatus: 522,
    } } as const;
    r.setDiscoveryFailure(1, failure);
    expect(r.descriptors(1)).toEqual([played, preview]);
    expect(r.failures(1)).toEqual([failure]);
    expect(r.snapshot(1).descriptors).toEqual([played, preview]);
  });

  it("startSelected starts the first selected descriptor that can be saved, in the given order", async () => {
    const d = deps();
    const r = createRouter(d);
    const protectedMedia = drmDescriptor();
    const low = directDescriptor({ id: "low" as StreamId, source: { kind: "direct-url", url: "https://example.com/low.mp4", headers: {} } });
    const high = directDescriptor({ id: "high" as StreamId, source: { kind: "direct-url", url: "https://example.com/high.mp4", headers: {} } });
    for (const item of [protectedMedia, low, high]) r.addDescriptor(1, item);
    expect(await r.startSelected(1, [protectedMedia.id, high.id, low.id])).toEqual({ kind: "started", streamId: high.id });
    expect(d.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "start-job", streamId: high.id }));
  });

  it("a keyed main refuses with cdm_required, and another video is never started in its place", async () => {
    const d = deps();
    const r = createRouter(d);
    const protectedMedia = drmDescriptor();
    r.addDescriptor(1, protectedMedia);
    r.addDescriptor(1, directDescriptor());
    expect(await r.startSelected(1, [protectedMedia.id])).toMatchObject({ kind: "failed", streamId: protectedMedia.id, error: { code: "cdm_required" } });
    expect(d.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("startSelected names the refusal of media the engine cannot finish, and is no-media for nothing", async () => {
    const r = createRouter(deps());
    const dash = unassemblableDash();
    r.addDescriptor(1, dash);
    expect(await r.startSelected(1, [dash.id])).toMatchObject({ kind: "failed", error: { code: "dash_unsupported" } });
    expect(await r.startSelected(1, [])).toEqual({ kind: "no-media" });
    expect(await r.startSelected(1, ["unknown" as StreamId])).toEqual({ kind: "no-media" });
  });

  it("removes descriptors and failures by id and address, but never the row of a running save", async () => {
    const r = createRouter(deps());
    const ad = directDescriptor({ id: "ad" as StreamId, source: { kind: "direct-url", url: "https://ads.example/creative.mp4", headers: {} } });
    const content = directDescriptor();
    r.addDescriptor(1, ad);
    r.addDescriptor(1, content);
    r.setDiscoveryFailure(1, { url: "https://ads.example/other.mp4#t", error: { code: "http_error", severity: "terminal", phase: "direct", url: "", httpStatus: 500 } });
    expect(r.removeFailures(1, ["https://ads.example/other.mp4"])).toBe(1);
    expect(r.removeDescriptors(1, [ad.id])).toBe(1);
    expect(r.descriptors(1)).toEqual([content]);
    await startErr(r, content.id, choice());
    expect(r.removeDescriptors(1, [content.id])).toBe(0);
    expect(r.activeJobs(1)).toEqual(new Set([content.id]));
  });

  it("annotate gives a master the timeline its media playlist states, once", () => {
    const r = createRouter(deps());
    const master = hlsDescriptor();
    r.addDescriptor(1, master);
    const presentation = { live: true, durationSeconds: 12, maxSegmentSeconds: 4 };
    expect(r.annotate(1, master.id, { presentation })).toBe(true);
    expect(r.annotate(1, master.id, { presentation: { ...presentation } })).toBe(false);
    expect(r.descriptors(1)[0]?.presentation).toEqual(presentation);
    expect(r.annotate(1, "missing" as StreamId, { presentation })).toBe(false);
  });

  it("every reload of a low-latency playlist is the same descriptor, and is covered by its master", () => {
    const r = createRouter(deps());
    const media = (query: string, id: string) => hlsDescriptor({ id: id as StreamId,
      source: { kind: "hls-manifest", manifestUrl: `https://cdn.example/720p/playlist.m3u8${query}`, type: "media" },
      variants: [{ ...hlsDescriptor().variants[0]!, segmentRef: { kind: "hls-segments", playlistUrl: `https://cdn.example/720p/playlist.m3u8${query}`,
        initSegmentUrl: null, segmentUrls: ["https://cdn.example/720p/seg1.ts"], encryption: null } }] });
    expect(r.addDescriptor(1, media("?token=1", "first"))).toBe(true);
    for (let part = 0; part < 50; part++) expect(r.addDescriptor(1, media(`?token=1&_HLS_msn=${part}&_HLS_part=2`, `reload-${part}`))).toBe(false);
    expect(r.descriptors(1).map(d => d.id)).toEqual(["first"]);

    const other = createRouter(deps());
    const master = hlsDescriptor({ variants: [{ ...hlsDescriptor().variants[0]!, segmentRef: { kind: "hls-segments",
      playlistUrl: "https://cdn.example/720p/playlist.m3u8", initSegmentUrl: null, segmentUrls: [], encryption: null } }] });
    other.addDescriptor(1, master);
    other.addDescriptor(1, media("?_HLS_msn=9&_HLS_part=1", "reload"));
    expect(other.descriptors(1).map(d => d.id)).toEqual([master.id]);
  });

  it("upgrades a passive capture with quality metadata and preserves its ID", () => {
    const r = createRouter(deps());
    const original = directDescriptor();
    r.addDescriptor(1, original);
    const rich = { ...original, id: "new-id" as StreamId, mediaGroup: "player-one", variants: [{
      ...hlsDescriptor().variants[0]!, height: 480,
      segmentRef: { kind: "direct" as const, url: "https://example.com/clip.mp4" },
    }] };
    expect(r.addDescriptor(1, rich)).toBe(true);
    expect(r.descriptors(1)).toHaveLength(1);
    expect(r.findDescriptor(original.id)).toMatchObject({ mediaGroup: "player-one", variants: [{ height: 480 }] });
    expect(r.addDescriptor(1, original)).toBe(false);
    expect(r.findDescriptor(original.id)?.variants[0]?.height).toBe(480);
  });

  it("keeps numbered file identities and query-selected videos separate", () => {
    const router = createRouter(deps());
    const urls = ["/31", "/32", "/file?id=31", "/file?id=32"];
    for (const [index, url] of urls.entries()) {
      router.addDescriptor(1, directAt(`https://cdn.example${url}`, `video-${index}` as StreamId));
    }
    expect(router.descriptors(1)).toHaveLength(4);
  });

  it("takes the page's fresh link for the same verified file into the existing row, judged by validators, not parameter names", () => {
    const router = createRouter(deps());
    const verified = (url: string, id: string, etag: string, detectedAt: number) => directDescriptor({ id: id as StreamId, detectedAt,
      source: { kind: "direct-url", url, headers: { "content-range": "bytes 0-4095/5000000", etag } } });
    router.addDescriptor(1, verified("https://cdn.example/v/clip.mp4?p=1&h=old", "first", '"v1"', 1));
    expect(router.addDescriptor(1, verified("https://cdn.example/v/clip.mp4?p=1&h=fresh", "fresh", '"v1"', 2))).toBe(true);
    expect(router.descriptors(1)).toEqual([expect.objectContaining({
      id: "first", source: expect.objectContaining({ url: "https://cdn.example/v/clip.mp4?p=1&h=fresh" }),
    })]);
    // Another version of the file at the same address is another file.
    router.addDescriptor(1, verified("https://cdn.example/v/clip.mp4?p=1&h=newer", "changed", '"v2"', 3));
    expect(router.descriptors(1).map(d => d.id)).toEqual(["first", "changed"]);
  });

  it("retains the redirect entry and row identity while the media destination changes", () => {
    const router = createRouter(deps());
    const url = "https://player.example/file/31";
    const first = "https://cdn.example/file/51";
    const second = "https://media.example/file/52";
    router.addDescriptor(1, directAt(first, "first" as StreamId));
    router.addDescriptor(1, directDescriptor({ id: "entry" as StreamId, source: {
      kind: "direct-url", url, finalUrl: first, headers: {},
    } }));
    router.addDescriptor(1, directDescriptor({ id: "refresh" as StreamId, source: {
      kind: "direct-url", url, finalUrl: second, headers: {},
    } }));
    expect(router.addDescriptor(1, directAt(second, "destination" as StreamId))).toBe(false);
    expect(router.descriptors(1)).toEqual([expect.objectContaining({
      id: "first", source: expect.objectContaining({ url, finalUrl: second }),
    })]);
  });

  it("keeps declared numeric quality siblings and downloads the highest", async () => {
    const d = deps();
    const r = createRouter(d);
    for (const height of [480, 720, 1080]) {
      const url = `https://cdn.example/movie_${height}p.mp4`;
      r.addDescriptor(1, directDescriptor({ id: `quality-${height}` as StreamId, mediaGroup: "player-one",
        source: { kind: "direct-url", url, headers: {} }, variants: [{ ...hlsDescriptor().variants[0]!, height,
          segmentRef: { kind: "direct", url } }],
      }));
    }
    expect(r.descriptors(1)).toHaveLength(3);
    await startBest(r, 1);
    expect(d.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ streamId: "quality-1080" }));
  });
  it("returns the latest failed job when the popup is reopened", async () => {
    const r = createRouter(deps());
    const d = directDescriptor();
    r.addDescriptor(1, d);
    await r.startDownload(d.id, choice());
    const error = { code: "server_busy" as const, severity: "terminal" as const,
      phase: "direct" as const, url: "https://cdn.example/clip.mp4", httpStatus: 503 };
    await r.handleEngineMessage({ type: "failed", streamId: d.id, error });

    expect(r.snapshot(1)).toMatchObject({
      statuses: { [d.id]: { phase: "failed", error } },
    });
  });

  it("adds a descriptor once and reports false on duplicates", () => {
    const r = createRouter(deps());
    const d = directDescriptor();
    expect(r.addDescriptor(1, d)).toBe(true);
    expect(r.addDescriptor(1, d)).toBe(false);
    expect(r.descriptors(1)).toHaveLength(1);
  });

  it("isolates descriptors per tab", () => {
    const r = createRouter(deps());
    r.addDescriptor(1, directDescriptor());
    r.addDescriptor(2, hlsDescriptor());
    expect(r.descriptors(1)).toHaveLength(1);
    expect(r.descriptors(2)).toHaveLength(1);
  });

  it("clears tab descriptors on clearTab", () => {
    const r = createRouter(deps());
    r.addDescriptor(1, directDescriptor());
    r.clearTab(1);
    expect(r.descriptors(1)).toHaveLength(0);
  });

  it("drops an HLS media-playlist descriptor when its master variant is already known", () => {
    const r = createRouter(deps());
    const master = hlsDescriptor({
      variants: [{
        ...hlsDescriptor().variants[0]!,
        segmentRef: {
          kind: "hls-segments",
          playlistUrl: "https://cdn/video/720p.m3u8",
          initSegmentUrl: null,
          segmentUrls: [],
          encryption: null,
        },
      }],
    });
    const media = hlsMediaDescriptor("https://cdn/video/720p.m3u8");

    expect(r.addDescriptor(1, master)).toBe(true);
    expect(r.addDescriptor(1, media)).toBe(false);
    expect(r.descriptors(1).map(d => d.id)).toEqual([master.id]);
  });

  it("replaces a standalone HLS media-playlist descriptor when its master arrives later", () => {
    const r = createRouter(deps());
    const media = hlsMediaDescriptor("https://cdn/video/720p.m3u8");
    const master = hlsDescriptor({
      variants: [{
        ...hlsDescriptor().variants[0]!,
        segmentRef: {
          kind: "hls-segments",
          playlistUrl: "https://cdn/video/720p.m3u8",
          initSegmentUrl: null,
          segmentUrls: [],
          encryption: null,
        },
      }],
    });

    expect(r.addDescriptor(1, media)).toBe(true);
    expect(r.addDescriptor(1, master)).toBe(true);
    expect(r.descriptors(1).map(d => d.id)).toEqual([master.id]);
  });

  it("removes direct fMP4 chunk descriptors once their HLS media playlist is known", () => {
    const r = createRouter(deps());
    const initUrl = "https://cdn/video/title-init.mp4";
    const segmentUrl = "https://cdn/video/title-part-1.mp4";
    const init = directAt(initUrl, "stream-init" as StreamId);
    const segment = directAt(segmentUrl, "stream-segment" as StreamId);
    const media = hlsMediaDescriptor("https://cdn/video/720p.m3u8", {
      initSegmentUrl: initUrl,
      segmentUrls: [segmentUrl],
    });

    expect(r.addDescriptor(1, init)).toBe(true);
    expect(r.addDescriptor(1, segment)).toBe(true);
    expect(r.descriptors(1).map(d => d.id)).toEqual([init.id, segment.id]);

    expect(r.addDescriptor(1, media)).toBe(true);
    expect(r.descriptors(1).map(d => d.id)).toEqual([media.id]);
  });

  it("suppresses direct chunks from a covered HLS media playlist even when the master is already visible", () => {
    const r = createRouter(deps());
    const manifestUrl = "https://cdn/video/720p.m3u8";
    const segmentUrl = "https://cdn/video/title-part-1.mp4";
    const master = hlsDescriptor({
      variants: [{
        ...hlsDescriptor().variants[0]!,
        segmentRef: {
          kind: "hls-segments",
          playlistUrl: manifestUrl,
          initSegmentUrl: null,
          segmentUrls: [],
          encryption: null,
        },
      }],
    });
    const media = hlsMediaDescriptor(manifestUrl, { segmentUrls: [segmentUrl] });

    expect(r.addDescriptor(1, master)).toBe(true);
    expect(r.addDescriptor(1, media)).toBe(false);
    expect(r.addDescriptor(1, directAt(segmentUrl, "stream-segment" as StreamId))).toBe(false);
    expect(r.descriptors(1).map(d => d.id)).toEqual([master.id]);
  });
});

describe("router — startDownload routing", () => {
  it.each([
    {},
    { "content-range": "bytes 0-4095/100000" },
    { "content-range": "bytes 0-4095/100000", etag: '"v1"' },
  ])("routes every direct stream to the verifier before invoking browser downloads", async headers => {
    const d = deps();
    const r = createRouter(d);
    const descriptor = directDescriptor({ source: { kind: "direct-url", url: "https://example.com/clip.mp4", headers } });
    r.addDescriptor(1, descriptor);
    expect(await startErr(r, descriptor.id, choice())).toBeNull();
    expect(d.downloads.download).not.toHaveBeenCalled();
    expect(d.ensureEngineHost).toHaveBeenCalledOnce();
    expect(d.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "start-job", streamId: descriptor.id,
    }));
  });

  it("hands a save the local origins the browser was answered from in its tab, and nothing when there are none", async () => {
    const d = deps();
    const localOriginsOf = vi.fn((tabId: number) => tabId === 1 ? ["http://192.168.1.10"] : []);
    const r = createRouter({ ...d, localOriginsOf });
    const mine = directDescriptor({ id: "one" as StreamId, tabId: 1 });
    const other = directDescriptor({ id: "two" as StreamId, tabId: 2, source: { kind: "direct-url", url: "https://example.com/other.mp4", headers: {} } });
    r.addDescriptor(1, mine);
    r.addDescriptor(2, other);
    expect(await startErr(r, mine.id, choice())).toBeNull();
    expect(await startErr(r, other.id, choice())).toBeNull();
    const starts = d.runtime.sendMessage.mock.calls.map(call => call[0] as { type: string; streamId: string; localOrigins?: string[] })
      .filter(message => message.type === "start-job");
    expect(starts.map(message => [message.streamId, message.localOrigins])).toEqual([["one", ["http://192.168.1.10"]], ["two", undefined]]);
    expect("localOrigins" in starts[1]!).toBe(false);
  });

  it("routes an HLS stream through the engine host", async () => {
    const d = deps();
    const r = createRouter(d);
    r.addDescriptor(1, hlsDescriptor());
    const err = await startErr(r, hlsDescriptor().id, choice({ variantId: "v-1080" as VariantId }));
    expect(err).toBeNull();
    expect(d.ensureEngineHost).toHaveBeenCalledTimes(1);
    expect(d.runtime.sendMessage).toHaveBeenCalled();
    expect(r.job(hlsDescriptor().id)).not.toBeNull();
  });

  it("refuses DRM-blocked streams without calling engine host", async () => {
    const d = deps();
    const r = createRouter(d);
    r.addDescriptor(1, drmDescriptor("cdm_required"));
    const err = await startErr(r, drmDescriptor("cdm_required").id, choice());
    expect(err?.code).toBe("cdm_required");
    expect(d.ensureEngineHost).not.toHaveBeenCalled();
  });

  it("refuses ClearKey with the deferred reason code", async () => {
    const d = deps();
    const r = createRouter(d);
    r.addDescriptor(1, clearKeyDescriptor());
    const err = await startErr(r, clearKeyDescriptor().id, choice());
    expect(err?.code).toBe("clearkey_deferred");
  });

  it("refuses DASH the engine cannot assemble without calling engine host", async () => {
    const d = deps();
    const r = createRouter(d);
    r.addDescriptor(1, unassemblableDash());
    const err = await startErr(r, unassemblableDash().id, choice({ variantId: "dash-1080" as VariantId }));
    expect(err?.code).toBe("dash_unsupported");
    expect(d.ensureEngineHost).not.toHaveBeenCalled();
  });

  it("starts a clear DASH stream that declares no audio: it is saved as the page plays it", async () => {
    const d = deps();
    const r = createRouter(d);
    r.addDescriptor(1, dashDescriptor());
    expect(await r.startDownload(dashDescriptor().id, choice({ variantId: "dash-1080" as VariantId }))).toMatchObject({ outcome: "started" });
    expect(d.ensureEngineHost).toHaveBeenCalled();
    expect(d.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "start-job", streamId: dashDescriptor().id }));
  });

  it("a row the router no longer knows answers listing-expired and leaves no status behind", async () => {
    const d = deps();
    const r = createRouter(d);
    expect(await r.startDownload("nope" as StreamId, choice())).toEqual({ type: "download-result", outcome: "listing-expired" });
    expect(r.snapshot(1).statuses).toEqual({});
    expect(d.emitted).toEqual([]);
    expect(d.ensureEngineHost).not.toHaveBeenCalled();
  });


});

describe("router — saving the selection", () => {
  it("a page with only Widevine media is a cdm_required refusal, not an empty page", async () => {
    const d = deps();
    const r = createRouter(d);
    r.addDescriptor(1, drmDescriptor("cdm_required"));

    const outcome = await startBest(r, 1);

    expect(outcome).toMatchObject({ kind: "failed", error: { code: "cdm_required" } });
    expect(d.ensureEngineHost).not.toHaveBeenCalled();
    expect(d.downloads.download).not.toHaveBeenCalled();
  });

  it("a page with only ClearKey media is a clearkey_deferred refusal, not an empty page", async () => {
    const r = createRouter(deps());
    r.addDescriptor(1, clearKeyDescriptor());

    expect(await startBest(r, 1)).toMatchObject({ kind: "failed", error: { code: "clearkey_deferred" } });
  });

  it("still saves the clear stream when a page carries clear and protected media", async () => {
    const d = deps();
    const r = createRouter(d);
    r.addDescriptor(1, drmDescriptor("cdm_required"));
    r.addDescriptor(1, directDescriptor());

    expect(await startBest(r, 1)).toMatchObject({ kind: "started" });
  });

  it("a page whose only media the engine cannot finish names the refusal instead of no-media", async () => {
    const r = createRouter(deps());
    r.addDescriptor(1, unassemblableDash());

    expect(await startBest(r, 1)).toMatchObject({ kind: "failed", error: { code: "dash_unsupported" } });
  });

  it("an empty page is still no-media", async () => {
    expect(await startBest(createRouter(deps()), 1)).toEqual({ kind: "no-media" });
  });

  it("downloads the highest HLS variant on the active tab", async () => {
    const d = deps();
    const r = createRouter(d);
    const base = hlsDescriptor().variants[0]!;
    const highVariant = {
      ...base,
      id: "v-1080" as VariantId,
      height: 1080,
      bitrate: 5_000_000,
    };
    const lowVariant = {
      ...base,
      id: "v-480" as VariantId,
      height: 480,
      bitrate: 1_000_000,
    };
    r.addDescriptor(1, hlsDescriptor({ variants: [lowVariant, highVariant] }));

    const outcome = await startBest(r, 1);

    expect(outcome).toMatchObject({ kind: "started" });
    expect(d.ensureEngineHost).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(d.runtime.sendMessage).mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      type: "start-job",
      choice: {
        outputMode: "Original",
        filename: "master.m3u8.mp4",
        variantId: "v-1080",
      },
    });
  });

  it("falls back to direct download when the tab only has a progressive file", async () => {
    const d = deps();
    const r = createRouter(d);
    r.addDescriptor(1, directDescriptor());

    const outcome = await startBest(r, 1);

    expect(outcome).toMatchObject({ kind: "started" });
    expect(d.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "start-job",
      choice: expect.objectContaining({ filename: "clip name.mp4" }),
    }));
  });

  it("releases the reservation and allows another save if the engine did not acknowledge startup", async () => {
    const d = deps();
    d.runtime.sendMessage.mockRejectedValueOnce(new Error("Engine disconnected"));
    const finish = vi.fn(async () => undefined);
    const r = createRouter({ ...d, reserveSave: async () => ({ finish }) });
    r.addDescriptor(1, directDescriptor());
    expect(await startBest(r, 1)).toMatchObject({ kind: "failed", error: { code: "engine_stopped", when: "start" } });
    expect(finish).toHaveBeenCalledWith(false);
    expect(r.engineJobCount()).toBe(0);
    expect(await startBest(r, 1)).toMatchObject({ kind: "started" });
  });

  it("skips DRM-blocked descriptors when choosing the best stream", async () => {
    const d = deps();
    const r = createRouter(d);
    r.addDescriptor(1, drmDescriptor("cdm_required"));
    r.addDescriptor(1, directDescriptor());

    const outcome = await startBest(r, 1);

    expect(outcome).toMatchObject({ kind: "started" });
    expect(d.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ streamId: directDescriptor().id }));
  });

  it("skips DASH the engine cannot assemble when choosing the best stream", async () => {
    const d = deps();
    const r = createRouter(d);
    r.addDescriptor(1, unassemblableDash());
    r.addDescriptor(1, directDescriptor());

    const outcome = await startBest(r, 1);

    expect(outcome).toMatchObject({ kind: "started" });
    expect(d.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ streamId: directDescriptor().id }));
  });

  it("starts nothing when the only descriptor is protected, and says why", async () => {
    // This used to assert no-media. That was the bug: the user saw "Nothing
    // to save" on a Widevine page, and no-media is delegable to the local
    // downloader. Starting nothing is still right; the outcome is a refusal.
    const d = deps();
    const r = createRouter(d);
    r.addDescriptor(1, drmDescriptor("cdm_required"));

    const outcome = await startBest(r, 1);

    expect(outcome).toMatchObject({ kind: "failed", error: { code: "cdm_required" } });
    expect(d.downloads.download).not.toHaveBeenCalled();
    expect(d.ensureEngineHost).not.toHaveBeenCalled();
  });

  it("selects a demuxed audio+video pair while DASH that cannot be assembled stays skipped", async () => {
    const d = deps();
    const r = createRouter(d);
    r.addDescriptor(1, unassemblableDash()); // no segment addresses → never a candidate
    const pair = demuxedPairDescriptor(
      directDescriptor({
        id: "stream-pair" as StreamId,
        source: { kind: "direct-url", url: "https://cdn.example/videoplayback?id=o-AAA&itag=137", headers: {} },
      }),
      "https://cdn.example/videoplayback?id=o-AAA&itag=140",
      null,
      null,
    );
    expect(r.addDescriptor(1, pair)).toBe(true);
    expect(r.addDescriptor(1, pair)).toBe(false); // same pair dedupes

    const outcome = await startBest(r, 1);

    // The pair — not the DASH entry, not nothing — is selected, and
    // core dispatch turns its demuxed shape into an AvMergePlan, so the job
    // must reach the engine host rather than resolve to a refusal or a
    // silent video-only browser download.
    expect(outcome).toMatchObject({ kind: "started" });
    expect(d.ensureEngineHost).toHaveBeenCalled();
    expect(d.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "start-job", streamId: pair.id }),
    );
    expect(d.downloads.download).not.toHaveBeenCalled();
  });

  it("an unmaterialized pair never outranks a working direct stream", async () => {
    const d = deps();
    const r = createRouter(d);
    // A live/byte-range MPD parses into variants and renditions whose
    // dash-segments refs carry no media URLs — dispatch can only refuse it,
    // so it must not be selected over the usable direct entry.
    const unmaterialized = dashDescriptor({
      id: "stream-live-mpd" as StreamId,
      variants: [{
        ...dashDescriptor().variants[0]!,
        audioRenditionId: "audio" as AudioRenditionId,
        segmentRef: { kind: "dash-segments", initUrl: "", mediaUrls: [] },
      }],
      audioRenditions: [{
        ...dashDescriptor().variants[0]!,
        id: "live-audio" as VariantId,
        videoCodec: null,
        audioRenditionId: "audio" as AudioRenditionId,
        segmentRef: { kind: "dash-segments", initUrl: "", mediaUrls: [] },
      }],
    });
    r.addDescriptor(1, unmaterialized);
    r.addDescriptor(1, directDescriptor());

    const outcome = await startBest(r, 1);

    expect(outcome).toMatchObject({ kind: "started" });
    expect(d.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ streamId: directDescriptor().id }));
    expect(d.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ streamId: unmaterialized.id }),
    );
  });
});

/** A router with one running direct save, started the way the popup starts it. */
async function running(overrides: Partial<Parameters<typeof createRouter>[0]> = {}) {
  const d = deps();
  const r = createRouter({ ...d, ...overrides });
  const descriptor = directDescriptor();
  r.addDescriptor(descriptor.tabId, descriptor);
  expect(await r.startDownload(descriptor.id, choice())).toEqual({ type: "download-result", outcome: "started" });
  d.emitted.length = 0;
  return { d, r, id: descriptor.id, tabId: descriptor.tabId };
}

describe("router — engine message handling", () => {
  it("turns progress into the stream's status and tells the observers", async () => {
    const { d, r, id, tabId } = await running();
    await r.handleEngineMessage({ type: "progress", streamId: id, bytesWritten: 1, bytesTotal: 2, stage: { kind: "remuxing", fraction: 0.5 } });
    const status = { phase: "active", bytesWritten: 1, bytesTotal: 2, stage: { kind: "remuxing", fraction: 0.5 }, stageSince: expect.any(Number) };
    expect(r.snapshot(tabId).statuses?.[id]).toEqual(status);
    expect(jobEvents(d)).toEqual([expect.objectContaining({ tabId, streamId: id, origin: "popup", status, previous: expect.objectContaining({ phase: "active" }) })]);
  });

  it("ignores progress for a stream that has no running save", async () => {
    const d = deps();
    const r = createRouter(d);
    r.addDescriptor(1, directDescriptor());
    d.emitted.length = 0;
    await r.handleEngineMessage({ type: "progress", streamId: directDescriptor().id, bytesWritten: 1, bytesTotal: 2, stage: { kind: "downloading" } });
    expect(r.snapshot(1).statuses).toEqual({});
    expect(d.emitted).toEqual([]);
  });

  it("keeps a failure's retained bytes as status data, acknowledges it, and drops the promise when the engine lets go", async () => {
    const { d, r, id, tabId } = await running();
    const retained = { bytes: 10, total: 20, expiresAt: 1_900_000_000_000 };
    const error = { code: "server_busy", severity: "terminal", phase: "direct", url: "https://example.com", httpStatus: 503 } as const;
    await r.handleEngineMessage({ type: "failed", streamId: id, error, retained });
    expect(r.snapshot(tabId).statuses?.[id]).toMatchObject({ phase: "failed", error, retained });
    expect(jobEvents(d).at(-1)?.status).toMatchObject({ phase: "failed", error, retained });
    expect(d.engine.ack).toHaveBeenCalledWith(id);
    expect(r.engineJobCount()).toBe(0);
    await r.handleEngineMessage({ type: "idle" });

    // Another failed save took the engine's one slot: the failure stands, its kept bytes are gone.
    d.emitted.length = 0;
    await r.handleEngineMessage({ type: "retained-released", streamId: id });
    expect(r.snapshot(tabId).statuses?.[id]).toEqual(expect.objectContaining({ phase: "failed", error }));
    expect(r.snapshot(tabId).statuses?.[id]).not.toHaveProperty("retained");
    expect(jobEvents(d)).toHaveLength(1);
    await r.handleEngineMessage({ type: "retained-released", streamId: id });
    expect(jobEvents(d)).toHaveLength(1);
  });

  it("on complete: waits for the browser to write the file, then ends the job and frees the Blob", async () => {
    let written!: () => void;
    const wait = vi.fn(() => new Promise<void>(resolve => { written = resolve; }));
    const { d, r, id, tabId } = await running({ downloads: { download: vi.fn(async () => 7), wait, filename: async () => "out (1).mp4" } });
    const done = r.handleEngineMessage({ type: "complete", streamId: id, blobUrl: "blob:x", filename: "out.mp4", checksum: "abc" });
    await vi.waitFor(() => expect(wait).toHaveBeenCalledWith(7));
    expect(r.snapshot(tabId).statuses?.[id]).toMatchObject({ phase: "active", stage: { kind: "writing" } });
    expect(r.engineJobCount()).toBe(1);
    expect(d.engine.release).not.toHaveBeenCalled();
    written();
    await done;
    expect(r.snapshot(tabId).statuses?.[id]).toEqual({ phase: "complete", savedAs: "out (1).mp4" });
    expect(r.engineJobCount()).toBe(0);
    expect(d.engine.release).toHaveBeenCalledWith("blob:x");
  });

  it("on complete: a result reported again while the file is being written starts no second download", async () => {
    let written!: () => void;
    const download = vi.fn(async () => 7);
    const { r, id } = await running({ downloads: { download, wait: () => new Promise<void>(resolve => { written = resolve; }) } });
    const complete = { type: "complete", streamId: id, blobUrl: "blob:x", filename: "out.mp4", checksum: "abc" } as const;
    const first = r.handleEngineMessage(complete);
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    await r.handleEngineMessage(complete);
    written();
    await first;
    // And once more after the save is recorded: only the Blob is left to free.
    await r.handleEngineMessage(complete);
    expect(download).toHaveBeenCalledOnce();
  });

  it("on complete: a download failure becomes a failed status with browser_download_failed (no false success)", async () => {
    const { d, r, id, tabId } = await running();
    d.downloads.download.mockRejectedValueOnce(new Error("ENOSPC: disk full"));
    await r.handleEngineMessage({ type: "complete", streamId: id, blobUrl: "blob:x", filename: "out.mp4", checksum: "abc" });
    expect(r.snapshot(tabId).statuses?.[id]).toMatchObject({ phase: "failed", error: { code: "browser_download_failed" } });
    expect(d.engine.release).toHaveBeenCalledWith("blob:x");
  });

  it("on complete: a file:// blobUrl is still handed to chrome.downloads and can fail honestly", async () => {
    const { d, r, id, tabId } = await running();
    d.downloads.download.mockRejectedValueOnce(new Error("Cannot download file:// URL"));
    await r.handleEngineMessage({ type: "complete", streamId: id, blobUrl: "file:///Users/x/Downloads/out.mp4", filename: "out.mp4", checksum: "abc" });
    expect(r.snapshot(tabId).statuses?.[id]?.phase).toBe("failed");
    expect(d.downloads.download).toHaveBeenCalledWith(expect.objectContaining({ url: "file:///Users/x/Downloads/out.mp4" }));
    expect(d.engine.release).not.toHaveBeenCalled();
  });

  it("on failed: ends the job and tells the observers", async () => {
    const { d, r, id } = await running();
    await r.handleEngineMessage({ type: "failed", streamId: id, error: { code: "engine_stopped", severity: "terminal", when: "running" } });
    expect(jobEvents(d).at(-1)?.status).toMatchObject({ phase: "failed", error: { code: "engine_stopped" } });
    expect(r.engineJobCount()).toBe(0);
  });

  it("a cancel by the user is a neutral end: no error, no failure, and the save can be started again", async () => {
    const finish = vi.fn(async () => undefined);
    const { d, r, id, tabId } = await running({ reserveSave: async () => ({ finish }) });
    await r.handleEngineMessage({ type: "failed", streamId: id, error: { code: "user_cancelled", severity: "terminal" } });
    expect(r.snapshot(tabId).statuses?.[id]).toEqual({ phase: "cancelled" });
    expect(jobEvents(d).at(-1)).toMatchObject({ status: { phase: "cancelled" }, previous: { phase: "active" } });
    expect(jobEvents(d).at(-1)?.status.error).toBeUndefined();
    expect(finish).toHaveBeenCalledExactlyOnceWith(false);
    expect(d.engine.ack).toHaveBeenCalledWith(id);
    expect(r.engineJobCount()).toBe(0);
    expect(await r.startDownload(id, choice())).toMatchObject({ outcome: "started" });
  });

  it("a download the user stopped in the browser's own list is cancelled, not failed", async () => {
    const { d, r, id, tabId } = await running();
    Object.assign(d.downloads, { wait: async () => { throw new Error("USER_CANCELED"); } });
    await r.handleEngineMessage({ type: "complete", streamId: id, blobUrl: "blob:x", filename: "out.mp4", checksum: "abc" });
    expect(r.snapshot(tabId).statuses?.[id]).toEqual({ phase: "cancelled" });
  });

  it("stamps a stage with the time it began and keeps that time while the stage lasts, so a wait counts down from one moment", async () => {
    let clock = 1_000;
    const { r, id, tabId } = await running({ now: () => clock });
    const retry = (attempt: number) => ({ kind: "retrying", attempt, maxAttempts: 5, waitMs: 4000, httpStatus: 503, part: null } as const);
    const since = (): number | undefined => r.snapshot(tabId).statuses?.[id]?.stageSince;
    await r.handleEngineMessage({ type: "progress", streamId: id, bytesWritten: 1, bytesTotal: 9, stage: retry(1) });
    expect(since()).toBe(1_000);
    clock = 2_500;
    await r.handleEngineMessage({ type: "progress", streamId: id, bytesWritten: 1, bytesTotal: 9, stage: retry(1) });
    expect(since()).toBe(1_000);
    // The next attempt is a new wait.
    await r.handleEngineMessage({ type: "progress", streamId: id, bytesWritten: 1, bytesTotal: 9, stage: retry(2) });
    expect(since()).toBe(2_500);
    clock = 9_000;
    await r.handleEngineMessage({ type: "progress", streamId: id, bytesWritten: 2, bytesTotal: 9, stage: { kind: "downloading" } });
    expect(since()).toBe(9_000);
    clock = 9_500;
    await r.handleEngineMessage({ type: "progress", streamId: id, bytesWritten: 3, bytesTotal: 9, stage: { kind: "downloading" } });
    expect(since()).toBe(9_000);
  });

  it("asks what the browser reported about the job's own requests before a failure is recorded, and records what it is given", async () => {
    const explainNetwork = vi.fn((error: unknown, _context: { since: number; address: string }) => ({ ...(error as object),
      browserDiagnostic: { host: "cdn.example", code: null, ip: "192.168.1.1", finalHost: null, redirect: null } }));
    const { r, id, tabId } = await running({ explainNetwork: explainNetwork as never, now: () => 5_000 });
    await r.handleEngineMessage({ type: "failed", streamId: id, error: { code: "unexpected_media_response", severity: "terminal", response: "page" } });
    expect(explainNetwork).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "unexpected_media_response" }),
      // The tab and its page come along: where the browser reaches that page says whether a server address explains anything.
      { since: 5_000, address: directDescriptor().source.kind === "direct-url" ? (directDescriptor().source as { url: string }).url : "",
        tabId, pageUrl: directDescriptor().pageUrl });
    expect(r.snapshot(tabId).statuses?.[id]?.error).toMatchObject({ code: "unexpected_media_response", browserDiagnostic: { ip: "192.168.1.1" } });
    // A cancel is not a failure and is never explained.
    explainNetwork.mockClear();
    await r.startDownload(id, choice());
    await r.handleEngineMessage({ type: "failed", streamId: id, error: { code: "user_cancelled", severity: "terminal" } });
    expect(explainNetwork).not.toHaveBeenCalled();
  });

  it("passes the user's choice of another copy to the reservation, so the question is not asked a second time", async () => {
    const d = deps();
    const reserveSave = vi.fn(async (_descriptor: unknown, _choice: unknown, _file: unknown, _context: { origin: string; allowRepeat: boolean }) =>
      ({ finish: async () => undefined }));
    const r = createRouter({ ...d, reserveSave });
    r.addDescriptor(1, directDescriptor());
    await r.startSelected(1, [directDescriptor().id], undefined, "popup", { allowRepeat: true });
    expect(reserveSave.mock.calls[0]![3]).toEqual({ origin: "popup", allowRepeat: true });
    await r.handleEngineMessage({ type: "failed", streamId: directDescriptor().id, error: { code: "user_cancelled", severity: "terminal" } });
    await r.startDownload(directDescriptor().id, choice(), { origin: "hotkey" });
    expect(reserveSave.mock.calls[1]![3]).toEqual({ origin: "hotkey", allowRepeat: false });
  });

  it("maps a transfer's request to the save's tab and document", async () => {
    const { d, r, id, tabId } = await running();
    const observation = { host: "media.example" } as never;
    await r.handleEngineMessage({ type: "transfer-http", streamId: id, observation });
    expect(d.emitted).toEqual([{ type: "http", tabId, generation: 0, source: "transfer", streamId: id, observation }]);
  });
});

describe("router — the popup's requests", () => {
  it("the snapshot is the descriptors response", async () => {
    const r = createRouter(deps());
    r.addDescriptor(1, directDescriptor());
    expect(r.snapshot(1)).toEqual({ type: "descriptors", tabId: 1, descriptors: [directDescriptor()], failures: [], statuses: {} });
  });

  it("cancel is always forwarded to the engine, also for a save this worker no longer knows", async () => {
    const { d, r, id } = await running();
    d.runtime.sendMessage.mockClear();
    r.cancel(id);
    expect(r.engineJobCount()).toBe(1);
    expect(d.runtime.sendMessage).toHaveBeenCalledWith({ type: "cancel-job", streamId: id });
    r.cancel("stream-gone" as StreamId);
    expect(d.runtime.sendMessage).toHaveBeenCalledWith({ type: "cancel-job", streamId: "stream-gone" });
  });

  it("a Save that could not start leaves its reason on the row", async () => {
    const d = deps();
    const r = createRouter(d);
    r.addDescriptor(1, unassemblableDash());
    const result = await r.startDownload(unassemblableDash().id, choice());
    expect(result).toMatchObject({ outcome: "failed", error: { code: "dash_unsupported" } });
    if (result.outcome === "failed") r.recordFailure(unassemblableDash().id, result.error);
    expect(r.snapshot(1).statuses?.[unassemblableDash().id]).toMatchObject({ phase: "failed", error: { code: "dash_unsupported" } });
    expect(jobEvents(d)).toHaveLength(1);
  });

  it("a reservation that throws fails the row and answers failed, exactly once", async () => {
    const d = deps();
    const r = createRouter({ ...d, reserveSave: async () => { throw new Error("storage unavailable"); } });
    r.addDescriptor(1, directDescriptor());
    expect(await r.startDownload(directDescriptor().id, choice())).toMatchObject({ outcome: "failed", error: { code: "engine_job_failed", at: "init" } });
    expect(r.snapshot(1).statuses?.[directDescriptor().id]?.phase).toBe("failed");
    expect(jobEvents(d)).toHaveLength(1);
    expect(r.engineJobCount()).toBe(0);
  });
});

describe("router — one save per stream, however often it is asked for (rule 11)", () => {
  it("a second Save while the first runs starts no second job", async () => {
    const { d, r, id } = await running();
    expect(await r.startDownload(id, choice())).toEqual({ type: "download-result", outcome: "started" });
    expect(await startBest(r, 1)).toEqual({ kind: "started", streamId: id });
    expect(d.engine.start).toHaveBeenCalledOnce();
    expect(r.engineJobCount()).toBe(1);
  });

  it("two starts in the same moment reserve once and start one job", async () => {
    const d = deps();
    let reserved = 0;
    const r = createRouter({ ...d, reserveSave: async () => (++reserved === 1 ? { finish: async () => undefined } : null) });
    r.addDescriptor(1, directDescriptor());
    const results = await Promise.all([r.startDownload(directDescriptor().id, choice()), r.startDownload(directDescriptor().id, choice())]);
    expect(results.map(result => result.outcome).sort()).toEqual(["skipped", "started"]);
    expect(d.engine.start).toHaveBeenCalledOnce();
  });

  it("the same captures again add nothing, keep ids and order, and give the same pick", async () => {
    const r = createRouter(deps());
    const page = [hlsDescriptor(), directAt("https://example.com/a.mp4", "stream-11" as StreamId), directAt("https://example.com/b.mp4", "stream-12" as StreamId)];
    for (const item of page) r.addDescriptor(1, item);
    const first = r.descriptors(1);
    const pick = select({ descriptors: first, failures: [], media: NOTHING_KNOWN, jobs: new Set(), facts: null, usePointer: false }).candidates;
    for (let round = 0; round < 3; round++) for (const item of page) expect(r.addDescriptor(1, { ...item, detectedAt: item.detectedAt })).toBe(false);
    expect(r.descriptors(1)).toEqual(first);
    expect(select({ descriptors: r.descriptors(1), failures: [], media: NOTHING_KNOWN, jobs: new Set(), facts: null, usePointer: false }).candidates).toEqual(pick);
  });
});

describe("router — ids that survive a worker restart", () => {
  it("replaces the classifier's counter id with one derived from the tab and the source", () => {
    const first = createRouter(deps());
    const second = createRouter(deps());
    first.addDescriptor(1, directAt("https://example.com/a.mp4", "stream-3" as StreamId));
    // Another worker instance counts differently; the row's id is the same.
    second.addDescriptor(1, directAt("https://example.com/a.mp4", "stream-9" as StreamId));
    const id = first.descriptors(1)[0]!.id;
    expect(id).toMatch(/^stream-[0-9a-f]{16}$/);
    expect(second.descriptors(1)[0]!.id).toBe(id);
    second.addDescriptor(2, directAt("https://example.com/a.mp4", "stream-1" as StreamId));
    second.addDescriptor(1, directAt("https://example.com/b.mp4", "stream-1" as StreamId));
    expect(new Set([id, second.descriptors(2)[0]!.id, second.descriptors(1)[1]!.id]).size).toBe(3);
  });

  it("keeps an id it was given by name: a protected element's row and a job's row", () => {
    const r = createRouter(deps());
    r.addDescriptor(1, drmDescriptor("cdm_required"));
    expect(r.descriptors(1)[0]!.id).toBe(drmDescriptor("cdm_required").id);
  });
});

describe("router — bounded rows per tab", () => {
  it("keeps the newest rows, the running save and the main video when a page loads more than the limit", async () => {
    const main = directAt("https://example.com/main.mp4", "main" as StreamId);
    const saving = directAt("https://example.com/saving.mp4", "saving" as StreamId);
    const d = deps();
    const r = createRouter({ ...d, keep: () => new Set(["main"]) });
    r.addDescriptor(1, main);
    r.addDescriptor(1, saving);
    await r.startDownload(saving.id, choice());
    for (let index = 0; index < MAX_DESCRIPTORS_PER_TAB + 50; index++) {
      r.addDescriptor(1, directAt(`https://example.com/feed/${index}.mp4`, `feed-${index}` as StreamId));
    }
    const ids = r.descriptors(1).map(item => item.id as string);
    expect(ids).toHaveLength(MAX_DESCRIPTORS_PER_TAB);
    expect(ids).toEqual(expect.arrayContaining(["main", "saving", `feed-${MAX_DESCRIPTORS_PER_TAB + 49}`]));
    expect(ids).not.toContain("feed-0");
  });
});

/** A store double: what the router wrote, as JSON, the way the browser keeps it. */
function memoryPersistence() {
  const tabs = new Map<number, TabRecord>();
  const descriptors = new Map<number, Map<string, StreamDescriptor>>();
  const covered = new Map<number, readonly string[]>();
  let jobs: readonly JobRecord[] = [];
  const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const persist: RouterPersistence = {
    tab: record => { tabs.set(record.tabId, copy(record)); },
    descriptor: (tabId, descriptor) => { (descriptors.get(tabId) ?? descriptors.set(tabId, new Map()).get(tabId)!).set(descriptor.id, copy(descriptor)); },
    dropDescriptor: (tabId, id) => { descriptors.get(tabId)?.delete(id); },
    covered: (tabId, ids) => { covered.set(tabId, copy(ids)); },
    dropTab: (tabId, ids) => { tabs.delete(tabId); covered.delete(tabId); for (const id of ids) descriptors.get(tabId)?.delete(id); },
    jobs: records => { jobs = copy(records); },
    durable: async () => undefined,
  };
  return { persist, stored: () => ({ tabs: new Map(tabs), descriptors: new Map(descriptors), covered: new Map(covered), jobs }) };
}

describe("router — state that survives a worker restart", () => {
  const failure = { url: "https://old-media.example/clip/playlist.m3u8", error: {
    code: "server_busy", severity: "terminal", phase: "manifest", url: "https://old-media.example/clip/playlist.m3u8", httpStatus: 522 } } as const;
  const redirected = directDescriptor({ id: "stream-7" as StreamId, title: null,
    source: { kind: "direct-url", url: "https://example.com/entry.mp4", finalUrl: "https://cdn.example/final.mp4", headers: {} } });
  const captures = () => [hlsDescriptor(), hlsMediaDescriptor("https://example.com/video/1080.m3u8"), redirected, drmDescriptor("cdm_required")];

  async function restarted() {
    const memory = memoryPersistence();
    const before = createRouter({ ...deps(), persist: memory.persist });
    for (const item of captures()) before.addDescriptor(1, item);
    before.setDiscoveryFailure(1, failure);
    before.setPageReach(1, "blocked");
    // A finished save with kept bytes.
    await before.startDownload(redirected.id === "stream-7" ? before.descriptors(1).find(d => d.source.kind === "direct-url")!.id : redirected.id, choice());
    const saved = before.descriptors(1).find(d => d.source.kind === "direct-url")!.id;
    const retained = { bytes: 10, total: 20, expiresAt: 1_900_000_000_000 };
    await before.handleEngineMessage({ type: "failed", streamId: saved, retained,
      error: { code: "transfer_failed", severity: "terminal", reason: "ended-early", host: "cdn.example", receivedBytes: 10, totalBytes: 20, httpStatus: 206 } });
    const d = deps();
    const after = createRouter({ ...d, persist: memoryPersistence().persist });
    after.importState(memory.stored());
    return { before, after, d, saved, retained };
  }

  it("restores rows in order, failures, statuses with kept bytes, the page's reach and the document count", async () => {
    const { before, after, saved, retained } = await restarted();
    expect(after.snapshot(1)).toEqual(JSON.parse(JSON.stringify(before.snapshot(1))));
    expect(after.descriptors(1).map(item => item.id)).toEqual(before.descriptors(1).map(item => item.id));
    expect(after.snapshot(1).statuses?.[saved]).toMatchObject({ phase: "failed", retained });
    expect(after.failures(1)).toEqual([failure]);
    expect(after.pageReach(1)).toBe("blocked");
    expect(after.generation(1)).toBe(before.generation(1));
  });

  it("captures the page sends again after the restart change nothing", async () => {
    const { after } = await restarted();
    const snapshot = after.snapshot(1);
    for (const item of captures()) expect(after.addDescriptor(1, item)).toBe(false);
    expect(after.snapshot(1)).toEqual(snapshot);
  });

  it("a page with only protected media still refuses with its protection, never as an empty page", async () => {
    const memory = memoryPersistence();
    const before = createRouter({ ...deps(), persist: memory.persist });
    before.addDescriptor(1, drmDescriptor("cdm_required"));
    const after = createRouter(deps());
    after.importState(memory.stored());
    expect(await startBest(after, 1)).toMatchObject({ kind: "failed", error: { code: "cdm_required" } });
  });

  it("is imported once, into an empty router", async () => {
    const { after } = await restarted();
    expect(() => after.importState({ tabs: new Map(), descriptors: new Map(), covered: new Map(), jobs: [] })).toThrow();
  });

  it("drops a closed tab's records and counts a navigation as a new document", () => {
    const memory = memoryPersistence();
    const d = deps();
    const r = createRouter({ ...d, persist: memory.persist });
    r.addDescriptor(1, directDescriptor());
    r.clearTab(1, "https://elsewhere.example/");
    expect(r.generation(1)).toBe(1);
    expect(memory.stored().tabs.get(1)).toMatchObject({ generation: 1, order: [] });
    expect(memory.stored().descriptors.get(1)?.size).toBe(0);
    expect(d.emitted.at(-1)).toEqual({ type: "document", tabId: 1, generation: 1, closed: false });
    r.forgetTab(1);
    expect(memory.stored().tabs.has(1)).toBe(false);
    expect(d.emitted.at(-1)).toMatchObject({ type: "document", tabId: 1, closed: true });
  });
});

describe("router — the engine after a restart or a crash", () => {
  async function restored(phases: Record<string, JobRecord["phase"]>) {
    const memory = memoryPersistence();
    const before = createRouter({ ...deps(), persist: memory.persist,
      reserveSave: async descriptor => ({ receiptKey: `saved:${descriptor.id}`, resumeKey: null, finish: async () => undefined }) });
    const rows = Object.keys(phases).map(name => directAt(`https://example.com/${name}.mp4`, name as StreamId));
    for (const row of rows) { before.addDescriptor(1, row); await before.startDownload(row.id, choice()); }
    const stored = memory.stored();
    const jobs = stored.jobs.map(job => ({ ...job, phase: phases[job.streamId]!,
      output: phases[job.streamId] === "writing" ? { blobUrl: `blob:${job.streamId}`, filename: `${job.streamId}.mp4`, downloadId: null } : null }));
    const d = deps();
    const finish = vi.fn(async (_saved: boolean) => undefined);
    const wait = vi.fn(async () => undefined);
    const r = createRouter({ ...d, downloads: { download: d.downloads.download, wait, findByUrl: async () => null },
      permitFrom: data => ({ ...data, finish }) });
    r.importState({ ...stored, jobs });
    return { d, r, finish, wait };
  }

  it("with no engine left: running saves fail as stopped and can be saved again; a file being written is left to the browser", async () => {
    const { d, r } = await restored({ x: "engine", y: "starting", z: "writing" });
    await r.failEngineJobs("restart");
    const statuses = r.snapshot(1).statuses!;
    expect(statuses["x"]).toMatchObject({ phase: "failed", error: { code: "engine_stopped", when: "restart" } });
    expect(statuses["y"]).toMatchObject({ phase: "failed", error: { code: "engine_stopped", when: "restart" } });
    expect(statuses["z"]).toMatchObject({ phase: "active", stage: { kind: "writing" } });
    expect(r.engineJobCount()).toBe(1);
    expect(await r.startDownload("x" as StreamId, choice())).toMatchObject({ outcome: "started" });
    expect(d.engine.start).toHaveBeenCalledOnce();
  });

  it("the engine's own account: a running save keeps going, a kept result is written once, an unknown job is cancelled", async () => {
    const { d, r } = await restored({ x: "engine", y: "engine", lost: "engine" });
    const hello = { type: "engine-hello", protocol: 1, idle: false, retained: null,
      active: [{ streamId: "x" as StreamId, progress: { bytesWritten: 5, bytesTotal: 10, stage: { kind: "downloading" } } }, { streamId: "w" as StreamId, progress: null }],
      outbox: [{ type: "complete", streamId: "y" as StreamId, blobUrl: "blob:y", filename: "y.mp4", checksum: "c" }] } as const;
    await r.reconcileEngine(hello);
    await vi.waitFor(() => expect(r.snapshot(1).statuses?.["y"]?.phase).toBe("complete"));
    expect(r.snapshot(1).statuses?.["x"]).toMatchObject({ phase: "active", bytesWritten: 5, stage: { kind: "downloading" } });
    expect(r.snapshot(1).statuses?.["lost"]).toMatchObject({ phase: "failed", error: { code: "engine_stopped", when: "restart" } });
    expect(d.runtime.sendMessage).toHaveBeenCalledWith({ type: "cancel-job", streamId: "w" });
    // The same account again: one file, the same state.
    await r.reconcileEngine(hello);
    await Promise.resolve();
    expect(d.downloads.download).toHaveBeenCalledOnce();
    expect(r.snapshot(1).statuses?.["x"]?.phase).toBe("active");
  });

  it("a save whose file the browser was writing is finished from the browser's download, without a second one", async () => {
    const { d, r, finish, wait } = await restored({ z: "writing" });
    d.downloads.download.mockResolvedValueOnce(41);
    await r.resumeWriting();
    expect(d.downloads.download).toHaveBeenCalledWith(expect.objectContaining({ url: "blob:z" }));
    expect(wait).toHaveBeenCalledWith(41);
    expect(finish).toHaveBeenCalledWith(true);
    expect(r.snapshot(1).statuses?.["z"]?.phase).toBe("complete");
    expect(d.engine.release).toHaveBeenCalledWith("blob:z");
  });

  it("an engine that is gone takes its kept bytes with it", async () => {
    const { r, id, tabId } = await running({ reserveSave: async () => ({ receiptKey: "saved:a", resumeKey: "scope-a", finish: async () => undefined }) });
    const error = { code: "server_busy", severity: "terminal", phase: "direct", url: "https://example.com", httpStatus: 503 } as const;
    await r.handleEngineMessage({ type: "failed", streamId: id, error, retained: { bytes: 1, total: 2, expiresAt: 9 } });
    // The engine still holds them under the same scope: the promise stands.
    await r.reconcileEngine({ type: "engine-hello", protocol: 1, idle: false, retained: directResumeScope(tabId, "scope-a"), active: [], outbox: [] });
    expect(r.snapshot(tabId).statuses?.[id]).toHaveProperty("retained");
    // It holds another save's bytes now.
    await r.reconcileEngine({ type: "engine-hello", protocol: 1, idle: true, retained: "scope-b", active: [], outbox: [] });
    expect(r.snapshot(tabId).statuses?.[id]).not.toHaveProperty("retained");
    expect(r.snapshot(tabId).statuses?.[id]).toMatchObject({ phase: "failed", error });
  });

  it("a crashed engine fails the running save, frees its reservation and allows a retry", async () => {
    const finish = vi.fn(async (_saved: boolean) => undefined);
    const { d, r, id, tabId } = await running({ reserveSave: async () => ({ finish }) });
    await r.failEngineJobs("running");
    expect(r.snapshot(tabId).statuses?.[id]).toMatchObject({ phase: "failed", error: { code: "engine_stopped", when: "running" } });
    expect(finish).toHaveBeenCalledWith(false);
    expect(jobEvents(d).at(-1)).toMatchObject({ origin: "popup", status: { phase: "failed" }, previous: { phase: "active" } });
    expect(await r.startDownload(id, choice())).toMatchObject({ outcome: "started" });
  });

  it("a cancel while the engine is still being opened ends the save as cancelled", async () => {
    const d = deps();
    let opened!: () => void;
    d.ensureEngineHost.mockImplementationOnce(() => new Promise<undefined>(resolve => { opened = () => resolve(undefined); }));
    const r = createRouter(d);
    r.addDescriptor(1, directDescriptor());
    const starting = r.startDownload(directDescriptor().id, choice());
    await vi.waitFor(() => expect(d.ensureEngineHost).toHaveBeenCalled());
    r.cancel(directDescriptor().id);
    opened();
    await starting;
    expect(d.runtime.sendMessage).toHaveBeenCalledWith({ type: "cancel-job", streamId: directDescriptor().id });
  });

  it("a cancel before the engine could be opened ends the save as cancelled, never as a failure", async () => {
    const d = deps();
    let fail!: (error: Error) => void;
    d.ensureEngineHost.mockImplementationOnce(() => new Promise<undefined>((_resolve, reject) => { fail = reject; }));
    const r = createRouter(d);
    r.addDescriptor(1, directDescriptor());
    const starting = r.startDownload(directDescriptor().id, choice());
    await vi.waitFor(() => expect(d.ensureEngineHost).toHaveBeenCalled());
    r.cancel(directDescriptor().id);
    fail(new Error("no engine"));
    expect(await starting).toEqual({ type: "download-result", outcome: "skipped" });
    expect(r.snapshot(1).statuses?.[directDescriptor().id]).toEqual({ phase: "cancelled" });
  });

  /** A store whose writes take a turn of the event loop, as the browser's do. */
  function slowPersistence() {
    const memory = memoryPersistence();
    return { ...memory, persist: { ...memory.persist, durable: () => new Promise<void>(resolve => { setTimeout(resolve, 0); }) } };
  }

  it("a result the engine kept is handed to the browser once, also when the restarted worker looks for unfinished files right after", async () => {
    // The order of a worker start: the engine's account first, then the files that were being written.
    const memory = slowPersistence();
    const before = createRouter({ ...deps(), persist: memory.persist });
    before.addDescriptor(1, directAt("https://example.com/y.mp4", "y" as StreamId));
    await before.startDownload("y" as StreamId, choice());
    const d = deps();
    // The browser takes its time to accept a download, as it does: both callers would find none under way.
    d.downloads.download.mockImplementation(() => new Promise<number>(resolve => { setTimeout(() => resolve(1), 5); }));
    const r = createRouter({ ...d, persist: slowPersistence().persist, downloads: { download: d.downloads.download, findByUrl: async () => null } });
    r.importState(memory.stored());
    await r.reconcileEngine({ type: "engine-hello", protocol: 1, idle: false, retained: null, active: [],
      outbox: [{ type: "complete", streamId: "y" as StreamId, blobUrl: "blob:y", filename: "y.mp4", checksum: "c" }] });
    await r.resumeWriting();
    await vi.waitFor(() => expect(r.snapshot(1).statuses?.["y"]?.phase).toBe("complete"));
    expect(d.downloads.download).toHaveBeenCalledOnce();
    expect(d.engine.release).toHaveBeenCalledExactlyOnceWith("blob:y");
  });

  it("a save this worker is still handing to the engine is not failed by the engine's hello or by a lost engine", async () => {
    // What production does at every worker start: the router is imported, also when nothing was stored.
    for (const interrupt of ["hello", "lost"] as const) {
      const d = deps();
      const r = createRouter({ ...d, persist: slowPersistence().persist });
      r.importState({ tabs: new Map(), descriptors: new Map(), covered: new Map(), jobs: [] });
      const row = directDescriptor();
      r.addDescriptor(row.tabId, row);
      const starting = r.startDownload(row.id, choice());
      // The job's record is being written: the engine has not heard of the job yet.
      await Promise.resolve();
      if (interrupt === "hello") await r.reconcileEngine({ type: "engine-hello", protocol: 1, idle: true, retained: null, active: [], outbox: [] });
      else await r.failEngineJobs("running");
      expect(await starting).toMatchObject({ outcome: "started" });
      expect(r.snapshot(row.tabId).statuses?.[row.id]).toMatchObject({ phase: "active" });
      expect(d.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "start-job", streamId: row.id }));
      // Once the engine has it, a hello that does not name it means the engine lost it.
      await r.reconcileEngine({ type: "engine-hello", protocol: 1, idle: true, retained: null, active: [], outbox: [] });
      expect(r.snapshot(row.tabId).statuses?.[row.id]).toMatchObject({ phase: "failed", error: { code: "engine_stopped", when: "restart" } });
    }
  });

  it("a save keeps the page whose Referer its check sent, across a restart", async () => {
    const memory = memoryPersistence();
    const before = createRouter({ ...deps(), persist: memory.persist, referrerOf: () => "https://player.vendor.example" });
    const row = directDescriptor();
    before.addDescriptor(row.tabId, row);
    await before.startDownload(row.id, choice());
    expect(before.job(row.id)).toMatchObject({ pageUrl: row.pageUrl, referrer: "https://player.vendor.example" });
    const after = createRouter(deps());
    after.importState(memory.stored());
    expect(after.job(row.id)).toMatchObject({ referrer: "https://player.vendor.example" });
    // Without a known check the tab's page stands.
    const plain = createRouter(deps());
    plain.addDescriptor(row.tabId, row);
    await plain.startDownload(row.id, choice());
    expect(plain.job(row.id)).toMatchObject({ referrer: null });
  });
});

describe("router — rows have a bounded size", () => {
  const segments = (count: number, base = "https://cdn.example/video/1080/") => Array.from({ length: count }, (_, n) => `${base}seg${n}.ts`);

  it("lists a long playlist with a sample of its segments, after its segments were noted as its own", () => {
    const memory = memoryPersistence();
    const r = createRouter({ ...deps(), persist: memory.persist });
    const playlist = "https://cdn.example/video/1080.m3u8";
    const parts = segments(5000);
    r.addDescriptor(1, hlsMediaDescriptor(playlist, { segmentUrls: parts }));
    const row = r.descriptors(1)[0]!;
    const kept = row.variants[0]!.segmentRef.kind === "hls-segments" ? row.variants[0]!.segmentRef.segmentUrls : [];
    expect(kept.length).toBeGreaterThan(1);
    expect(kept.length).toBeLessThanOrEqual(MAX_KEPT_PARTS);
    expect(kept[0]).toBe(parts[0]);
    // What is stored, and what the popup receives, is the same small row.
    expect(rowBytes(row)).toBeLessThan(64 * 1024);
    expect(JSON.stringify(memory.stored().descriptors.get(1)!.get(row.id)).length).toBeLessThan(64 * 1024);
    expect(JSON.stringify(r.snapshot(1)).length).toBeLessThan(64 * 1024);
    // A segment in the middle of the stream, which the row no longer carries, is still never listed as a video of its own.
    expect(r.addDescriptor(1, directAt(parts[2500]!, "stream-99" as StreamId))).toBe(false);
    expect(r.descriptors(1)).toHaveLength(1);
    // The page's reload of the same playlist changes nothing.
    expect(r.addDescriptor(1, hlsMediaDescriptor(playlist, { segmentUrls: parts }))).toBe(false);
  });

  it("starts a save of a long stream from the listed row: the engine reads the playlist itself", async () => {
    const d = deps();
    const r = createRouter(d);
    r.addDescriptor(1, hlsMediaDescriptor("https://cdn.example/video/1080.m3u8", { segmentUrls: segments(5000) }));
    const row = r.descriptors(1)[0]!;
    expect(await r.startDownload(row.id, choice())).toMatchObject({ outcome: "started" });
    const sent = d.runtime.sendMessage.mock.calls.map(call => call[0] as { type: string; descriptor?: StreamDescriptor }).find(msg => msg.type === "start-job")!;
    expect(JSON.stringify(sent).length).toBeLessThan(64 * 1024);
    expect(sent.descriptor!.source).toEqual({ kind: "hls-manifest", manifestUrl: "https://cdn.example/video/1080.m3u8", type: "media" });
  });

  it("keeps a tab's rows within a size, dropping the oldest first and never the saving or the main one", async () => {
    const d = deps();
    const r = createRouter({ ...d, keep: () => new Set(["main"]) });
    // Rows that stay large after thinning: a long address under every segment.
    // Sixteen of them are already more than a row keeps, and cost this test little to build.
    const big = (name: string) => hlsMediaDescriptor(`https://cdn.example/${name}/${"p".repeat(4000)}/index.m3u8`,
      { segmentUrls: segments(16, `https://cdn.example/${name}/${"s".repeat(4000)}/`) });
    r.addDescriptor(1, { ...big("main"), id: "main" as StreamId });
    r.addDescriptor(1, { ...directAt("https://example.com/saving.mp4", "saving" as StreamId) });
    await r.startDownload("saving" as StreamId, choice());
    const count = Math.ceil(MAX_TAB_ROW_BYTES / rowBytes(r.descriptors(1)[0]!)) + 40;
    for (let index = 0; index < count; index++) r.addDescriptor(1, { ...big(`feed-${index}`), id: `feed-${index}` as StreamId });
    const rows = r.descriptors(1);
    expect(rows.reduce((sum, row) => sum + rowBytes(row), 0)).toBeLessThanOrEqual(MAX_TAB_ROW_BYTES);
    expect(rows.length).toBeLessThan(count);
    const ids = rows.map(row => row.id);
    expect(ids).toEqual(expect.arrayContaining(["main", "saving", `feed-${count - 1}`]));
    expect(ids).not.toContain("feed-0");
  });
});

describe("dispatchRefusalToError", () => {
  it("carries the descriptor's key system into cdm_required", () => {
    const err = dispatchRefusalToError("cdm_required", drmDescriptor("cdm_required"));
    if (err.code !== "cdm_required") throw new Error("wrong code");
    expect(err.keySystem).toBe("com.widevine.alpha");
  });

  it("falls back to 'unknown' keySystem when descriptor lacks it", () => {
    const d = { ...drmDescriptor("cdm_required"), drm: null };
    const err = dispatchRefusalToError("cdm_required", d);
    if (err.code !== "cdm_required") throw new Error("wrong code");
    expect(err.keySystem).toBe("unknown");
  });

  it("states the size of the whole save for a refusal by size: video and audio together, as dispatch added them up", () => {
    // A video file of 1.95 GiB with an audio file of 0.1 GiB, each the length its server declared (a size
    // without a bit rate): either track fits, the save does not.
    const GIB = 1024 ** 3;
    const row = dashDescriptor();
    const large = dashDescriptor({ variants: [{ ...row.variants[0]!, bitrate: null, estimatedSize: 1.95 * GIB }],
      audioRenditions: [{ ...row.variants[0]!, id: "audio" as never, width: null, height: null, videoCodec: null, bitrate: null, estimatedSize: 0.1 * GIB,
        audioRenditionId: "en" as never, segmentRef: { kind: "dash-segments", initUrl: "https://example.com/dash/a-init.m4s", mediaUrls: ["https://example.com/dash/a-1.m4s"] } }] });
    const plan = dispatch(large, { outputMode: "Original", filename: "movie.mp4", variantId: null, audioRenditionId: null });
    expect(plan).toEqual({ kind: "refuse", reason: "output_too_large_for_browser", estimatedBytes: 2.05 * GIB });
    if (plan.kind !== "refuse") throw new Error("expected a refusal");
    const error = dispatchRefusalToError(plan.reason, large, plan);
    expect(error).toEqual({ code: "output_too_large_for_browser", severity: "terminal", estimatedBytes: 2.05 * GIB, limitBytes: 2 * GIB });
    // The text never sets a size below the limit against the limit.
    expect(userMessage(error).body).toBe("This file would be about 2.05 GB, more than the 2.00 GB savemedia can save in the browser.");
  });

  it("says a demuxed stream whose sound the MP4 file cannot hold as a format limit, never as a playlist to check again", () => {
    const row = hlsDescriptor();
    const lossless = hlsDescriptor({
      variants: [{ ...row.variants[0]!, audioRenditionId: "lossless" as never, audioCodec: { rfc6381: "alac", family: "alac", channels: 2, sampleRate: 44100 } }],
      audioRenditions: [{ ...row.variants[0]!, id: "audio" as never, width: null, height: null, videoCodec: null, audioCodec: null, audioRenditionId: "lossless" as never }],
    });
    const plan = dispatch(lossless, { outputMode: "Original", filename: "concert.mp4", variantId: null, audioRenditionId: null });
    expect(plan).toEqual({ kind: "refuse", reason: "codec_unsupported", codec: { track: "audio", family: "alac" } });
    if (plan.kind !== "refuse") throw new Error("expected a refusal");
    const error = dispatchRefusalToError(plan.reason, lossless, plan);
    expect(error).toEqual({ code: "codec_unsupported", severity: "terminal", manifestUrl: "https://example.com/master.m3u8", track: "audio", codec: "alac" });
    const message = userMessage(error);
    expect(message).toMatchObject({ title: "Can't save in this format", hint: null,
      body: "This video's sound is in a format savemedia can't put into an MP4 file in the browser." });
    // Before: "The video's playlist can't be used ... Press Check page again, then save.", which no new look could ever change.
    expect(`${message.title} ${message.body}`).not.toMatch(/playlist|Check page/);
  });

  it("maps unsupported output to an honest non-DRM error", () => {
    const err = dispatchRefusalToError("unsupported_output", directDescriptor({ container: "mkv" }));
    expect(err).toMatchObject({ code: "unsupported_output", from: "mkv" });
  });
});

function directAt(url: string, id: StreamId): StreamDescriptor {
  return directDescriptor({
    id,
    title: null,
    source: { kind: "direct-url", url, headers: {} },
  });
}

function hlsMediaDescriptor(
  manifestUrl: string,
  overrides: { readonly initSegmentUrl?: string | null; readonly segmentUrls?: readonly string[] } = {},
): StreamDescriptor {
  return hlsDescriptor({
    id: "stream-hls-media" as StreamId,
    source: { kind: "hls-manifest", manifestUrl, type: "media" },
    variants: [{
      ...hlsDescriptor().variants[0]!,
      id: `${manifestUrl}#media` as VariantId,
      segmentRef: {
        kind: "hls-segments",
        playlistUrl: manifestUrl,
        initSegmentUrl: overrides.initSegmentUrl ?? null,
        segmentUrls: overrides.segmentUrls ?? [`${manifestUrl}/seg0.ts`],
        encryption: null,
      },
    }],
  });
}
