import { describe, expect, it } from "vitest";
import type { StreamId } from "@savemedia/core";
import { selectionView } from "../../../src/selection/main-video";
import type { DiscoveryFailure } from "../../../src/types/messages";
import { drmDescriptor, dashDescriptor } from "../popup/helpers/descriptors";
import { PAGE, direct, el, facts, frame, group, hls, image, media, origin, run, video } from "./helpers";
import { REMOVED_FRAME, protectionRowAddress } from "../../../src/util/tab-media-state";
import { createTabMediaStore } from "../../../src/background/tab-media";
import { factsOfCurrentRoutes } from "../../../src/background/page-facts";

const CREATIVE = "https://ads.test/creative.mp4";
const MASTER = "https://cdn.test/v/master.m3u8";
const CLIP = "https://cdn.test/clip.webm";
const blob = { kind: "blob", url: "blob:https://site.test/1" } as const;
const url = (value: string) => ({ kind: "url", url: value }) as const;
const busy = (address: string): DiscoveryFailure => ({ url: address, error: { code: "server_busy", severity: "terminal", phase: "direct", url: address, httpStatus: 503 } });
const pointerAt = (key: string) => ({ at: 10, x: 5, y: 5, overFrame: null, layers: [video(key)] });
const timeline = (durationSeconds: number, live = false) => ({ live, durationSeconds, maxSegmentSeconds: 6 });

describe("the one selector", () => {
  it("1. pre-roll: the content the player declares is the main video, and the ad creative is listed apart, never as a card of the page", () => {
    const player = el("v1", { source: url(CREATIVE), playing: true, played: true, muted: true, groups: [group("g", [MASTER])] });
    const base = { facts: facts(frame(0, { elements: [player] })), media: media({ ads: { [CREATIVE]: "vast" },
      origins: { [MASTER]: origin(0, ["declared"], 0, "element"), [CREATIVE]: origin() } }) };
    const selection = run({ ...base, descriptors: [direct("ad", CREATIVE), hls("content", MASTER, {}, ["https://cdn.test/v/720.m3u8"])] });
    expect(selection).toMatchObject({ state: "ready", main: "content", element: { frameId: 0, key: "v1" } });
    expect(selection.cards.map(card => card.ids)).toEqual([["content"]]);
    // The creative the browser loaded is listed apart: it is no card, no candidate and no main video.
    expect(selection.ads).toEqual([{ ids: ["ad"], live: false, element: null }]);
    expect(selection.candidates).toEqual(["content"]);
    expect(selection.toProbe).toEqual([]);
    expect(selectionView(selection)).toMatchObject({ mainId: "content", cards: [{ ids: ["content"], live: false }], ads: [{ ids: ["ad"], live: false }] });

    const bare = run({ descriptors: [direct("ad", CREATIVE)], media: base.media,
      facts: facts(frame(0, { elements: [{ ...player, groups: [] }] })) });
    expect(bare).toMatchObject({ state: "ad-playing", main: null, cards: [], candidates: [] });
    expect(bare.ads.map(card => card.ids)).toEqual([["ad"]]);
  });

  it("1c. an ad response that names the page's own main video demotes it and hides nothing: it is listed as an ad, never picked", () => {
    // The page's only video. Its address was named by an ad response before or after the browser loaded it.
    const player = el("v1", { source: url(CLIP), playing: true, played: true, audible: true });
    const base = { descriptors: [direct("clip", CLIP)], facts: facts(frame(0, { elements: [player] })) };
    const plain = run({ ...base, media: media({ origins: { [CLIP]: origin() } }) });
    expect(plain).toMatchObject({ state: "ready", main: "clip", ads: [] });
    expect(plain.cards.map(card => card.ids)).toEqual([["clip"]]);

    const marked = { ...base, media: media({ ads: { [CLIP]: "vast" as const }, origins: { [CLIP]: origin() } }) };
    const named = run(marked);
    // Nothing vanished: the row is there, under the ads. The count of the page's media leaves it out.
    expect(named.ads.map(card => card.ids)).toEqual([["clip"]]);
    expect(named.cards).toEqual([]);
    expect(named).toMatchObject({ state: "ad-playing", main: null, candidates: [] });
    // Alt+S over that video keeps the answer an ad gets, and the page's fallback never takes it either.
    expect(run({ ...marked, usePointer: true, facts: facts(frame(0, { elements: [player], pointer: pointerAt("v1") })) }))
      .toMatchObject({ state: "ad-playing", main: null, candidates: [], reason: "pointer" });
    expect(run({ ...marked, facts: facts(frame(0)) })).toMatchObject({ state: "no-media", main: null, candidates: [] });
    // A save of it that the user started keeps it listed on another route too.
    const moved = media({ ads: { [CLIP]: "vast" }, origins: { [CLIP]: origin() }, frames: { 0: { documentId: "doc-0", url: PAGE, generation: 1 } } });
    expect(run({ ...base, media: moved }).ads).toEqual([]);
    expect(run({ ...base, media: moved, jobs: new Set(["clip"]) }).ads.map(card => card.ids)).toEqual([["clip"]]);
  });

  // An article whose only video is an ad of its own (an in-read or outstream ad): no video follows it.
  it("1e. an ad that is not playing promises no video: only an ad that plays gives the ad hint", () => {
    const state = media({ ads: { [CREATIVE]: "vast" }, origins: { [CREATIVE]: origin() } });
    const answers = (ad: Partial<Parameters<typeof el>[1]>) => {
      const element = el("ad", { source: url(CREATIVE), ...ad });
      const base = { descriptors: [direct("ad", CREATIVE)], media: state };
      return {
        popup: run({ ...base, facts: facts(frame(0, { elements: [element] })) }),
        hotkey: run({ ...base, usePointer: true, facts: facts(frame(0, { elements: [element], pointer: pointerAt("ad") })) }),
      };
    };
    const playing = answers({ playing: true, played: true, muted: true });
    expect(playing.popup).toMatchObject({ state: "ad-playing", targetPlaying: true });
    expect(playing.hotkey).toMatchObject({ state: "ad-playing", reason: "pointer" });
    for (const [name, ad] of [
      ["paused or ended", { playing: false, played: true }],
      ["scrolled out of view", { playing: false, played: true, render: "offscreen" }],
      ["loaded and never played", { playing: false, played: false }],
    ] as const) {
      const { popup, hotkey } = answers(ad);
      // Nothing to wait for. The ad the browser loaded stays listed under the ads, and can be saved from there.
      expect(popup, name).toMatchObject({ state: "no-media", main: null, candidates: [], cards: [], targetPlaying: false });
      expect(popup.ads.map(card => card.ids), name).toEqual([["ad"]]);
      expect(hotkey, name).toMatchObject({ state: "no-media", main: null, candidates: [] });
    }
    // A paused ad in a player whose data declares the content: the content is the answer, as while the ad plays.
    const declared = run({ descriptors: [direct("ad", CREATIVE), hls("content", MASTER)],
      media: media({ ads: { [CREATIVE]: "vast" }, origins: { [CREATIVE]: origin(), [MASTER]: origin(0, ["declared"], 0, "element") } }),
      facts: facts(frame(0, { elements: [el("v1", { source: url(CREATIVE), played: true, groups: [group("g", [MASTER])] })] })) });
    expect(declared).toMatchObject({ state: "ready", main: "content" });
  });

  it("1d. ads are listed one card each, in one order whatever order they were found in, and an ad of a document that is gone is not listed", () => {
    const other = "https://ads.test/second.mp4";
    const gone = "https://ads.test/gone.mp4";
    const selection = run({ descriptors: [direct("a2", other), direct("a1", CREATIVE), direct("old", gone), hls("content", MASTER)],
      media: media({ ads: { [CREATIVE]: "vast", [other]: "hls-interstitial", [gone]: "vast" },
        origins: { [MASTER]: origin(0, ["network-fetch"]), [CREATIVE]: origin(), [other]: origin(), [gone]: { ...origin(5), documentId: "doc-5-old" } },
        frames: { 5: { documentId: "doc-5", url: "https://player.test/embed/5", generation: 0 } } }) });
    expect(selection.ads.map(card => card.ids)).toEqual([["a1"], ["a2"]]);
    expect(selection.cards.map(card => card.ids)).toEqual([["content"]]);
    expect(selection).toMatchObject({ state: "ready", main: "content" });
  });

  it("1b. pre-roll: the declared content is checked on the user's request, the creative never", () => {
    const player = el("v1", { source: url(CREATIVE), playing: true, groups: [group("g", [MASTER])] });
    const selection = run({ facts: facts(frame(0, { elements: [player] })), media: media({ ads: { [CREATIVE]: "vast" } }) });
    expect(selection.toProbe.map(request => request.url)).toEqual([MASTER]);
    expect(selection.listProbe).toEqual([]);
  });

  it("2. mid-roll: the stream the document loaded before the ad is the main video", () => {
    const selection = run({ descriptors: [hls("content", MASTER)],
      facts: facts(frame(0, { elements: [el("v1", { source: url(CREATIVE), playing: true })] })),
      media: media({ ads: { [CREATIVE]: "vmap" }, origins: { [MASTER]: origin(0, ["network-fetch"]) } }) });
    expect(selection).toMatchObject({ state: "ready", main: "content" });
  });

  it("3. an ad video on the page and a player in a frame: the player's file is the main video, with and without the pointer", () => {
    const top = frame(0, { elements: [el("ad", { source: url(CREATIVE), playing: true, muted: true, box: { x: 0, y: 0, width: 160, height: 90 } })],
      childFrames: [{ index: 0, box: { x: 0, y: 100, width: 640, height: 360 }, visible: { x: 0, y: 100, width: 640, height: 360 } }] });
    const player = frame(3, { viewport: { width: 640, height: 360 }, elements: [el("p", { source: url(CLIP) })] });
    const base = { descriptors: [direct("clip", CLIP)], media: media({ ads: { [CREATIVE]: "vast" }, origins: { [CLIP]: origin(3) } }) };
    expect(run({ ...base, facts: facts(top, player) })).toMatchObject({ state: "ready", main: "clip", element: { frameId: 3, key: "p" }, reason: "visible" });
    const pointed = run({ ...base, usePointer: true, facts: facts(top, { ...player, pointer: pointerAt("p") }) });
    expect(pointed).toMatchObject({ state: "ready", main: "clip", reason: "pointer" });
    const onAd = run({ ...base, usePointer: true, facts: facts({ ...top, pointer: pointerAt("ad") }, player) });
    expect(onAd).toMatchObject({ state: "ad-playing", main: null });
  });

  it("4. a feed of MediaSource posts: each post gets its own stream by duration, within the longest segment the playlist states", () => {
    const durations = [31, 45, 12, 60, 22];
    const posts = durations.map((duration, index) => el(`v${index + 1}`, { source: blob, duration,
      ...(index === 2 ? {} : { render: "offscreen" as const }) }));
    const streams = durations.map((duration, index) => hls(`s${index + 1}`, `https://cdn.test/feed/${index + 1}/media.m3u8`, { presentation: timeline(duration + 0.4) }));
    const origins = Object.fromEntries(streams.map((_stream, index) => [`https://cdn.test/feed/${index + 1}/media.m3u8`, origin(0, ["network-fetch"])]));
    const base = { descriptors: streams, media: media({ origins }) };
    const popup = run({ ...base, facts: facts(frame(0, { elements: posts })) });
    expect(popup).toMatchObject({ state: "ready", main: "s3", element: { frameId: 0, key: "v3" } });
    expect(popup.cards[0]).toEqual({ ids: ["s3"], live: false, element: { frameId: 0, key: "v3" } });
    expect(Object.keys(popup.previews).sort()).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(new Set(Object.values(popup.previews).map(preview => preview.duration)).size).toBe(5);
    const pointed = run({ ...base, usePointer: true, facts: facts(frame(0, { elements: posts, pointer: pointerAt("v2") })) });
    expect(pointed).toMatchObject({ state: "ready", main: "s2", reason: "pointer" });
  });

  it("4b. two posts of the same length: the pointer does not guess, the popup offers the best of what the page loaded", () => {
    const posts = [el("v1", { source: blob, duration: 30 }), el("v2", { source: blob, duration: 30, render: "offscreen" })];
    const streams = [1, 2].map(n => hls(`s${n}`, `https://cdn.test/feed/${n}/media.m3u8`, { presentation: timeline(30) }));
    const base = { descriptors: streams, media: media({ origins: { "https://cdn.test/feed/1/media.m3u8": origin(0, ["network-fetch"]),
      "https://cdn.test/feed/2/media.m3u8": origin(0, ["network-fetch"]) } }) };
    expect(run({ ...base, usePointer: true, facts: facts(frame(0, { elements: posts, pointer: pointerAt("v1") })) }))
      .toMatchObject({ state: "ambiguous", main: null, candidates: [] });
    expect(run({ ...base, facts: facts(frame(0, { elements: posts })) })).toMatchObject({ state: "ready", main: "s1" });
  });

  it("4c. no playlist-stated segment length, no association by duration", () => {
    const stream = hls("s1", "https://cdn.test/a.m3u8", { presentation: { live: false, durationSeconds: 30, maxSegmentSeconds: null } });
    const other = hls("s2", "https://cdn.test/b.m3u8", { presentation: { live: false, durationSeconds: 90, maxSegmentSeconds: null } });
    const posts = [el("v1", { source: blob, duration: 30 }), el("v2", { source: blob, duration: 90, render: "offscreen" })];
    const selection = run({ descriptors: [stream, other], usePointer: true, facts: facts(frame(0, { elements: posts, pointer: pointerAt("v1") })),
      media: media({ origins: { "https://cdn.test/a.m3u8": origin(0, ["network-fetch"]), "https://cdn.test/b.m3u8": origin(0, ["network-fetch"]) } }) });
    expect(selection.state).toBe("ambiguous");
  });

  it("5. picture-in-picture beats a visible video even when scrolled away, and fullscreen beats a visible one", () => {
    const teaser = el("teaser", { source: url("https://cdn.test/teaser.mp4"), playing: true, played: true, audible: true });
    const base = { descriptors: [direct("teaser", "https://cdn.test/teaser.mp4"), direct("main", "https://cdn.test/main.mp4")],
      media: media({ origins: { "https://cdn.test/teaser.mp4": origin(), "https://cdn.test/main.mp4": origin() } }) };
    const pip = el("pip", { source: url("https://cdn.test/main.mp4"), pip: true, render: "offscreen" });
    expect(run({ ...base, facts: facts(frame(0, { elements: [teaser, pip] })) })).toMatchObject({ main: "main", reason: "picture-in-picture" });
    const full = el("full", { source: url("https://cdn.test/main.mp4"), fullscreen: true, box: { x: 0, y: 0, width: 10, height: 10 } });
    expect(run({ ...base, facts: facts(frame(0, { elements: [teaser, full] })) })).toMatchObject({ main: "main", reason: "fullscreen" });
  });

  it("6. the decided order: sound first, then what the user played, then size and length; muted autoplay gives way", () => {
    const origins = { "https://cdn.test/teaser.mp4": origin(), "https://cdn.test/main.mp4": origin() };
    const base = { descriptors: [direct("teaser", "https://cdn.test/teaser.mp4"), direct("main", "https://cdn.test/main.mp4")], media: media({ origins }) };
    const teaser = (over = {}) => el("teaser", { source: url("https://cdn.test/teaser.mp4"), playing: true, played: true, muted: true,
      box: { x: 700, y: 0, width: 320, height: 180 }, ...over });
    const player = (over = {}) => el("player", { source: url("https://cdn.test/main.mp4"), box: { x: 0, y: 0, width: 960, height: 540 }, ...over });
    // A paused 960x540 main player beats a 320x180 muted autoplaying teaser, played or not.
    expect(run({ ...base, facts: facts(frame(0, { elements: [teaser(), player({ played: true })] })) }).main).toBe("main");
    expect(run({ ...base, facts: facts(frame(0, { elements: [teaser(), player()] })) }).main).toBe("main");
    // A small video playing with sound beats a larger one playing muted.
    expect(run({ ...base, facts: facts(frame(0, { elements: [teaser({ muted: false, audible: true }), player({ playing: true, played: true, muted: true })] })) }).main)
      .toBe("teaser");
    // A video the user played with sound and paused beats a larger one that never played.
    expect(run({ ...base, facts: facts(frame(0, { elements: [teaser({ playing: false, muted: false }), player()] })) }).main).toBe("teaser");
    // A large muted autoplaying main video still beats small previews that never played.
    expect(run({ ...base, facts: facts(frame(0, { elements: [
      el("teaser", { source: url("https://cdn.test/teaser.mp4"), box: { x: 700, y: 0, width: 320, height: 180 } }),
      player({ playing: true, played: true, muted: true })] })) }).main).toBe("main");
    // Equal size and length: the paused one, not the muted autoplay.
    const same = { box: { x: 0, y: 0, width: 640, height: 360 }, duration: 60 };
    expect(run({ ...base, facts: facts(frame(0, { elements: [teaser(same), player(same)] })) }).main).toBe("main");
  });

  it("7. an exact tie names no main element: the page's best is offered instead of a guess", () => {
    const twins = [el("v1", { source: url("https://cdn.test/a.mp4") }), el("v2", { source: url("https://cdn.test/b.mp4") })];
    const selection = run({ facts: facts(frame(0, { elements: twins })),
      descriptors: [direct("a", "https://cdn.test/a.mp4"), direct("b", "https://cdn.test/b.mp4")],
      media: media({ origins: { "https://cdn.test/a.mp4": origin(), "https://cdn.test/b.mp4": origin() } }) });
    expect(selection).toMatchObject({ state: "ready", element: null, reason: "page" });
    expect(selectionView(selection).elementMain).toBe(false);
  });

  it("8. a live stream is listed and labelled but never picked over a finished one", () => {
    const live = hls("live", "https://cdn.test/live/media.m3u8", { presentation: timeline(12, true) });
    const mixed = run({ descriptors: [live, direct("vod", CLIP)] });
    expect(mixed).toMatchObject({ state: "ready", main: "vod" });
    expect(mixed.cards).toEqual([{ ids: ["vod"], live: false, element: null }, { ids: ["live"], live: true, element: null }]);
    expect(run({ descriptors: [live] })).toMatchObject({ state: "live", main: "live", candidates: ["live"] });
  });

  it("8b. a master playlist is live when its media playlist says so", () => {
    const master = hls("master", MASTER, {}, ["https://cdn.test/v/720.m3u8"]);
    const selection = run({ descriptors: [master], media: media({ timelines: { "https://cdn.test/v/720.m3u8": timeline(12, true) } }) });
    expect(selection).toMatchObject({ state: "live", cards: [{ ids: ["master"], live: true }] });
  });

  it("9. an element that used a key is protected, and nothing else is saved in its place", () => {
    const drm = { ...drmDescriptor(), id: "protected:1:doc-0/v1" as StreamId, source: { kind: "media-element", element: "video", elementSrc: "savemedia-element:doc-0/v1" } } as const;
    const keyed = el("v1", { source: blob, keyed: { keySystem: "com.widevine.alpha" }, playing: true });
    const state = media({ elementDrm: { "doc-0/v1": { id: drm.id, keySystem: "com.widevine.alpha", elementSrc: null, frameId: 0 } },
      origins: { [CLIP]: origin(0, ["network-fetch"]) } });
    const selection = run({ descriptors: [drm, direct("clear", CLIP)], media: state, facts: facts(frame(0, { elements: [keyed] })) });
    expect(selection).toMatchObject({ state: "protected", main: drm.id, candidates: [drm.id], element: { frameId: 0, key: "v1" } });
    // Known as keyed before any descriptor exists: still protected, with the key system for the message.
    expect(run({ descriptors: [direct("clear", CLIP)], media: media({ origins: { [CLIP]: origin(0, ["network-fetch"]) } }),
      facts: facts(frame(0, { elements: [keyed] })) })).toMatchObject({ state: "protected", main: null, keySystem: "com.widevine.alpha" });
  });

  it("9b. a protected player in another frame does not block a clear main video, and asking what the browser can play protects nothing", () => {
    const clear = el("v1", { source: url(CLIP), played: true });
    const keyed = el("k", { source: blob, keyed: { keySystem: null }, box: { x: 0, y: 0, width: 100, height: 60 } });
    const top = frame(0, { elements: [clear], childFrames: [{ index: 0, box: { x: 0, y: 400, width: 100, height: 60 }, visible: { x: 0, y: 400, width: 100, height: 60 } }] });
    const selection = run({ descriptors: [direct("clear", CLIP)], media: media({ origins: { [CLIP]: origin() } }),
      facts: facts(top, frame(3, { viewport: { width: 100, height: 60 }, elements: [keyed] })) });
    expect(selection).toMatchObject({ state: "ready", main: "clear" });
    // A capability probe leaves no fact at all: the element is not keyed.
    expect(run({ descriptors: [direct("clear", CLIP)], media: media({ origins: { [CLIP]: origin() } }), facts: facts(frame(0, { elements: [clear] })) }).state).toBe("ready");
  });

  // Any frame can show a copy of the page's video and report key use for it (a forged event is enough).
  it("9c. key use reported by another frame's copy of the page's video protects that copy only: the page's clear video is saved", () => {
    const store = createTabMediaStore();
    store.tab(1).topDocument = "doc-0";
    store.tab(1).frames[0] = { documentId: "doc-0", url: PAGE, generation: 0 };
    store.tab(1).frames[3] = { documentId: "doc-3", url: "https://player.test/embed/3", generation: 0, parent: 0 };
    store.recordOrigin(1, CLIP, origin(0));
    // What the background does with the frame's report (protectElement).
    const entry = store.upsertElementDrm(1, 3, "doc-3", "x", null, CLIP);
    const address = protectionRowAddress(store.tab(1).origins, 3, "doc-3", "x", entry.elementSrc);
    expect(address).toBe("savemedia-element:doc-3/x");
    store.recordOrigin(1, address, { frameId: 3, documentId: "doc-3", generation: 0, via: ["eme"], scope: null });
    const row = { ...drmDescriptor(), id: entry.id, source: { kind: "media-element", element: "video", elementSrc: address } } as const;
    // Where the page's own video was seen is unchanged.
    expect(store.tab(1).origins[CLIP]).toMatchObject({ frameId: 0, documentId: "doc-0" });

    const top = el("v1", { source: url(CLIP), playing: true, played: true, audible: true });
    const copy = el("x", { source: url(CLIP), render: "hidden", box: { x: 0, y: 0, width: 1, height: 1 } });
    const shown = (pointed: boolean, withCopy: boolean) => facts(frame(0, { elements: [top], ...(pointed ? { pointer: pointerAt("v1") } : {}) }),
      ...(withCopy ? [frame(3, { elements: [copy] })] : []));
    const base = { descriptors: [direct("clip", CLIP), row], media: store.tab(1) };
    for (const withCopy of [true, false]) {
      expect(run({ ...base, facts: shown(false, withCopy) }), `copy shown: ${withCopy}`).toMatchObject({ state: "ready", main: "clip", element: { frameId: 0, key: "v1" } });
      expect(run({ ...base, usePointer: true, facts: shown(true, withCopy) }), `copy shown: ${withCopy}`).toMatchObject({ state: "ready", main: "clip", reason: "pointer" });
    }
    // A row that carries the shared address (a report that arrived before the page's video was seen) changes nothing either.
    const shared = { ...row, source: { ...row.source, elementSrc: CLIP } } as const;
    expect(run({ ...base, descriptors: [direct("clip", CLIP), shared], facts: shown(true, true), usePointer: true })).toMatchObject({ state: "ready", main: "clip" });
    // The frame's own copy stays protected.
    const copyShown = el("x", { source: url(CLIP), box: { x: 0, y: 0, width: 300, height: 200 } });
    const inFrame = facts(frame(0, { elements: [top], childFrames: [{ index: 0, box: { x: 0, y: 400, width: 300, height: 200 }, visible: { x: 0, y: 400, width: 300, height: 200 } }] }),
      frame(3, { viewport: { width: 300, height: 200 }, elements: [copyShown], pointer: pointerAt("x") }));
    expect(run({ ...base, usePointer: true, facts: inFrame })).toMatchObject({ state: "protected", main: entry.id });
    // The frame goes to another document: its row leaves the list, and the page's video stays.
    store.tab(1).frames[3] = { documentId: "doc-3b", url: "https://player.test/embed/next", generation: 0, parent: 0 };
    const after = run({ ...base, facts: shown(false, false) });
    expect(after).toMatchObject({ state: "ready", main: "clip" });
    expect(after.cards.map(card => card.ids)).toEqual([["clip"]]);
  });

  it("9d. a protected element is named by its own address while no other frame is known for it", () => {
    expect(protectionRowAddress({}, 0, "doc-0", "v1", CLIP)).toBe(CLIP);
    expect(protectionRowAddress({ [CLIP]: origin(0) }, 0, "doc-0", "v1", CLIP)).toBe(CLIP);
    expect(protectionRowAddress({ [CLIP]: origin(0) }, 3, "doc-3", "x", CLIP)).toBe("savemedia-element:doc-3/x");
    expect(protectionRowAddress({ [CLIP]: origin(0) }, 3, "doc-3", null, null)).toBe("savemedia-element:doc-3/document");
  });

  it("10. keeps the HLS master when the player's source is one of its variant playlists, on the page and in a player frame", () => {
    const variant = "https://cdn.test/v/720.m3u8";
    const master = hls("master", MASTER, {}, [variant, "https://cdn.test/v/1080.m3u8"]);
    const samePage = run({ descriptors: [master], media: media({ origins: { [MASTER]: origin(0, ["declared"], 0, "page") } }),
      facts: facts(frame(0, { elements: [el("v1", { source: url(variant) })] })) });
    expect(samePage).toMatchObject({ state: "ready", main: "master", element: { frameId: 0, key: "v1" } });
    const top = frame(0, { childFrames: [{ index: 0, box: { x: 0, y: 0, width: 640, height: 360 }, visible: { x: 0, y: 0, width: 640, height: 360 } }] });
    const inFrame = run({ descriptors: [master], media: media({ origins: { [MASTER]: origin(3, ["network-fetch"]) } }),
      facts: facts(top, frame(3, { viewport: { width: 640, height: 360 }, elements: [el("p", { source: url(`${variant}#t=1`) })] })) });
    expect(inFrame).toMatchObject({ state: "ready", main: "master", element: { frameId: 3, key: "p" } });
  });

  it("11. a stale declared manifest that fails does not hide the stream the player loaded: its failure is shown aside", () => {
    const stale = "https://old-media.test/clip/playlist.m3u8";
    const failure = busy(stale);
    const selection = run({ descriptors: [hls("played", MASTER)], failures: [failure],
      facts: facts(frame(0, { elements: [el("v1", { source: blob, playing: true })], pageGroups: [group("og", [stale], { via: "og", proximity: 3 })] })),
      media: media({ origins: { [MASTER]: origin(0, ["network-fetch"]), [stale]: origin(0, ["metadata"], 0, "page") } }) });
    expect(selection).toMatchObject({ state: "ready", main: "played", failure: null });
    expect(selection.shownFailures).toEqual([failure]);
  });

  it("11b. a ready answer does not wait for a source that failed before, unless it may be another rendition of the player's own source", () => {
    const stale = "https://old-media.test/clip/playlist.m3u8";
    const declared = group("config", [stale], { via: "attribute", proximity: 1 });
    const loaded = { descriptors: [hls("played", MASTER)], media: media({ origins: { [MASTER]: origin(0, ["network-fetch"]) } }) };
    const page = facts(frame(0, { elements: [el("v1", { source: blob, playing: true, groups: [declared] })] }));

    // Never checked: its first check may still improve the answer, so the save waits for it once.
    const first = run({ ...loaded, facts: page });
    expect(first).toMatchObject({ state: "ready", main: "played" });
    expect(first.toProbe).toEqual([expect.objectContaining({ url: stale, retry: false, scope: "element" })]);
    expect(first.listProbe).toEqual([]);

    // Failed before: the player's stream is captured and the player names no address of its own. A save starts
    // at once. The failed address is checked again when the user looks at the page again.
    const failed = run({ ...loaded, failures: [busy(stale)], facts: page });
    expect(failed).toMatchObject({ state: "ready", main: "played" });
    expect(failed.toProbe).toEqual([]);
    expect(failed.listProbe).toEqual([expect.objectContaining({ url: stale, retry: true, scope: "element" })]);

    // Without a ready answer the failed source is what a save asks for again.
    const nothing = run({ failures: [busy(stale)], facts: page });
    expect(nothing.state).toBe("failed");
    expect(nothing.toProbe).toEqual([expect.objectContaining({ url: stale, retry: true })]);

    // A player with an address of its own, whose data lists that address next to another quality that failed:
    // the retry may give the better quality, so it stays with the save.
    const high = "https://cdn.test/high.mp4";
    const renditions = group("qualities", [[CLIP, 480], [high, 1080]]);
    const own = run({ descriptors: [direct("clip", CLIP, { mediaGroup: "qualities" })], failures: [busy(high)], media: media({ origins: { [CLIP]: origin() } }),
      facts: facts(frame(0, { elements: [el("v1", { source: url(CLIP), playing: true, groups: [renditions] })] })) });
    expect(own).toMatchObject({ state: "ready", main: "clip" });
    expect(own.toProbe).toEqual([expect.objectContaining({ url: high, retry: true, groupId: "qualities" })]);
    expect(own.listProbe).toEqual([]);
  });

  it("11c. the page's answer from what it loaded does not wait for a failed source its data declares", () => {
    const stale = "https://old-media.test/clip.mp4";
    const selection = run({ descriptors: [hls("played", MASTER)], failures: [busy(stale)],
      facts: facts(frame(0, { pageGroups: [group("config", [stale], { via: "script", proximity: 3 })] })),
      media: media({ origins: { [MASTER]: origin(0, ["network-fetch"]), [stale]: origin(0, ["declared"], 0, "page") } }) });
    expect(selection).toMatchObject({ state: "ready", main: "played" });
    expect(selection.toProbe).toEqual([]);
    expect(selection.listProbe).toEqual([expect.objectContaining({ url: stale, retry: true, scope: "page" })]);
  });

  it("12. a player whose own file failed says so: another player's video is not saved instead", () => {
    const failure = busy("https://cdn.test/a.mp4");
    const selection = run({ descriptors: [direct("b", "https://cdn.test/b.mp4")], failures: [failure],
      facts: facts(frame(0, { elements: [el("v1", { source: url("https://cdn.test/a.mp4"), box: { x: 0, y: 0, width: 960, height: 540 } }),
        el("v2", { source: url("https://cdn.test/b.mp4"), box: { x: 0, y: 600, width: 320, height: 100 } })] })),
      media: media({ origins: { "https://cdn.test/b.mp4": origin() } }) });
    expect(selection).toMatchObject({ state: "failed", main: null, candidates: [], failure });
    expect(selection.shownFailures).toEqual([]);
    expect(selection.cards.map(card => card.ids)).toEqual([["b"]]);
    expect(selection.toProbe).toEqual([expect.objectContaining({ url: "https://cdn.test/a.mp4", retry: true, scope: "element" })]);
  });

  it("13. metadata that names the embed page, not a file, is no error to show next to a working player", () => {
    const embed = "https://site.test/embed/1.mp4";
    const pageAnswer: DiscoveryFailure = { url: embed, error: { code: "unexpected_media_response", severity: "terminal", response: "page" } };
    const top = frame(0, { pageGroups: [group("og", [embed], { via: "og", proximity: 3 })],
      childFrames: [{ index: 0, box: { x: 0, y: 0, width: 640, height: 360 }, visible: { x: 0, y: 0, width: 640, height: 360 } }] });
    const selection = run({ descriptors: [direct("clip", CLIP)], failures: [pageAnswer],
      facts: facts(top, frame(3, { viewport: { width: 640, height: 360 }, elements: [el("p", { source: url(CLIP), playing: true, played: true, audible: true })] })),
      media: media({ origins: { [CLIP]: origin(3), [embed]: origin(0, ["metadata"], 0, "page") } }) });
    expect(selection).toMatchObject({ state: "ready", main: "clip", failure: null, shownFailures: [] });
    // Alone on the page, it is still never the page's state.
    expect(run({ failures: [pageAnswer], facts: facts(top), media: media({ origins: { [embed]: origin(0, ["metadata"], 0, "page") } }) }).state).toBe("no-media");
  });

  it("14. a hidden video that feeds a canvas counts as shown", () => {
    const selection = run({ descriptors: [direct("clip", CLIP)], media: media({ origins: { [CLIP]: origin() } }),
      facts: facts(frame(0, { elements: [el("v1", { source: url(CLIP), render: "hidden", canvas: { x: 0, y: 0, width: 800, height: 450 }, played: true })] })) });
    expect(selection).toMatchObject({ state: "ready", main: "clip", element: { frameId: 0, key: "v1" }, reason: "visible" });
  });

  it("14b. twenty hidden previews next to one declared player: the declared video is the main one and no preview is ever checked", () => {
    const previews = Array.from({ length: 20 }, (_item, n) => el(`v${n + 1}`, { source: url(`https://cdn.test/clip.mp4?preview=${n}`), render: "hidden" }));
    const declared = group(`${PAGE}#page:script:0:s0.0`, [["https://cdn.test/low.mp4", 480], ["https://cdn.test/high.mp4", 720]], { via: "script", proximity: 3 });
    const page = facts(frame(0, { elements: previews, pageGroups: [declared] }));
    const before = run({ facts: page });
    expect(before.toProbe).toEqual([
      expect.objectContaining({ url: "https://cdn.test/low.mp4", height: 480, groupId: declared.groupId, scope: "page", retry: false }),
      expect.objectContaining({ url: "https://cdn.test/high.mp4", height: 720, groupId: declared.groupId }),
    ]);
    expect(before.listProbe).toEqual([]);
    const withHeight = (id: string, address: string, height: number) => {
      const base = direct(id, address, { mediaGroup: declared.groupId });
      return { ...base, variants: [{ ...hls("x", MASTER).variants[0]!, id: address as never, height, width: null, segmentRef: { kind: "direct" as const, url: address } }] };
    };
    const after = run({ facts: page, descriptors: [withHeight("low", "https://cdn.test/low.mp4", 480), withHeight("high", "https://cdn.test/high.mp4", 720)],
      media: media({ origins: { "https://cdn.test/low.mp4": origin(0, ["declared"], 0, "page"), "https://cdn.test/high.mp4": origin(0, ["declared"], 0, "page") } }) });
    expect(after).toMatchObject({ state: "ready", main: "high", candidates: ["high", "low"], toProbe: [], listProbe: [] });
    expect(after.cards).toEqual([{ ids: ["high", "low"], live: false, element: null }]);
  });

  it("15. a route change inside the page unlists the old route's stream, but not a player that still holds it or a running save", () => {
    const routed = { topDocument: "doc-0", frames: { 0: { documentId: "doc-0", url: `${PAGE}?v=2`, generation: 1 } } };
    const origins = { "https://cdn.test/old.mp4": origin(0, ["network-media"], 0), "https://cdn.test/new.mp4": origin(0, ["network-media"], 1) };
    const base = { descriptors: [direct("old", "https://cdn.test/old.mp4"), direct("new", "https://cdn.test/new.mp4")] };
    expect(run({ ...base, media: media({ ...routed, origins }) }).cards.map(card => card.ids)).toEqual([["new"]]);
    // The paused player still holds the old file: it stays listed.
    const held = run({ ...base, media: media({ ...routed, origins }),
      facts: facts(frame(0, { elements: [el("v1", { source: url("https://cdn.test/old.mp4"), played: true })] })) });
    expect(held.cards.map(card => card.ids).flat().sort()).toEqual(["new", "old"]);
    expect(held.main).toBe("old");
    expect(run({ ...base, media: media({ ...routed, origins }), jobs: new Set(["old"]) }).cards.map(card => card.ids).flat().sort()).toEqual(["new", "old"]);
    // Facts read on the route before say what the player held then. Stored ones are not taken for the new route:
    // the toolbar count and the list an open popup is sent show the new route's video alone.
    const before = facts({ ...frame(0, { elements: [el("v1", { source: url("https://cdn.test/old.mp4"), played: true })] }), generation: 0 });
    const stale = run({ ...base, media: media({ ...routed, origins }), facts: factsOfCurrentRoutes(before, () => 1) });
    expect(stale.cards.map(card => card.ids)).toEqual([["new"]]);
    expect(stale.main).toBe("new");
    // Read again on the new route, the same facts count: the player does hold the old file.
    const again = run({ ...base, media: media({ ...routed, origins }), facts: factsOfCurrentRoutes({ ...before, frames: [{ ...before.frames[0]!, generation: 1 }] }, () => 1) });
    expect(again.cards.map(card => card.ids).flat().sort()).toEqual(["new", "old"]);
    // A stream the page still requests on the new route stays listed by that activity.
    expect(run({ ...base, media: media({ ...routed, origins, activity: { "https://cdn.test/old.mp4": { at: 9, frameId: 0, generation: 1 } } }) })
      .cards.map(card => card.ids).flat().sort()).toEqual(["new", "old"]);
  });

  it("15b. what an older document of a frame loaded is not listed", () => {
    const state = media({ frames: { 0: { documentId: "doc-0", url: PAGE, generation: 0 }, 3: { documentId: "doc-3b", url: "https://player.test/b", generation: 0 } },
      origins: { [CLIP]: { frameId: 3, documentId: "doc-3a", generation: 0, via: ["network-media"], scope: null } } });
    expect(run({ descriptors: [direct("old-frame", CLIP)], media: state }).cards).toEqual([]);
  });

  it("16. a player the page has not given a source says so, and a page that only names a file says that", () => {
    expect(run({ facts: facts(frame(0, { elements: [el("v1")] })) })).toMatchObject({ state: "not-loaded-yet", main: null });
    expect(run({ facts: facts(frame(0, { page: { title: "Talk", namedFile: "Talk 7.mov" } })) })).toMatchObject({ state: "file-not-received" });
    expect(run({})).toMatchObject({ state: "no-media", cards: [] });
  });

  // A player fed through MediaSource has no address of its own, so nothing ties a failed manifest to it but its document.
  it("16f. a player that makes its video only on Play: Alt+S on the still the page declares says the video has not loaded yet, and saves no picture", () => {
    const still = (over = {}) => ({ at: 10, x: 5, y: 5, overFrame: null, layers: [image("https://site.test/poster.jpg", { declaredThumbnail: true, loaded: true, ...over })] });
    const lazy = run({ usePointer: true, facts: facts(frame(0, { pointer: still() })) });
    expect(lazy).toMatchObject({ state: "not-loaded-yet", main: null, image: null, failure: null });
    // The same picture when the page declares it as no video's still is a picture, and a spot with nothing is nothing.
    expect(run({ usePointer: true, facts: facts(frame(0, { pointer: still({ declaredThumbnail: false }) })) }))
      .toMatchObject({ state: "no-media", image: { url: "https://site.test/poster.jpg" } });
    expect(run({ usePointer: true, facts: facts(frame(0, { pointer: { at: 10, x: 5, y: 5, overFrame: null, layers: [] } })) })).toMatchObject({ state: "no-media", image: null });
    // The popup does not point: its answer for the page stays "nothing found", with its own start-playback line.
    expect(run({ facts: facts(frame(0, { pointer: still() })) })).toMatchObject({ state: "no-media" });
    // Once the video has loaded, the still stands for it.
    const loaded = { descriptors: [direct("clip", CLIP)], media: media({ origins: { [CLIP]: origin() } }) };
    expect(run({ ...loaded, usePointer: true, facts: facts(frame(0, { elements: [el("v1", { source: url(CLIP), playing: true, played: true })], pointer: still() })) }))
      .toMatchObject({ state: "ready", main: "clip" });
    // A check of the page's own request that failed stays the answer: it says more than "start playback".
    const denied = busy(MASTER);
    expect(run({ usePointer: true, failures: [denied], media: media({ origins: { [MASTER]: origin(0, ["network-fetch"]) } }), facts: facts(frame(0, { pointer: still() })) }))
      .toMatchObject({ state: "failed", failure: denied });
  });

  it("16a. Alt+S on a MediaSource player and the popup give the same answer: the check that failed, or that there is nothing to save", () => {
    const denied: DiscoveryFailure = { url: MASTER, error: { code: "access_denied", severity: "terminal", phase: "manifest", url: MASTER,
      httpStatus: 403, explanation: "forbidden-or-expired-url" } };
    const playing = el("v1", { source: blob, playing: true, played: true, audible: true });
    const page = (pointed: boolean) => facts(frame(0, { elements: [playing], ...(pointed ? { pointer: pointerAt("v1") } : {}) }));
    const origins = { [MASTER]: origin(0, ["network-fetch"]) };
    // The manifest the player asked for failed savemedia's check: both say so, and neither tells the user to start a video that plays.
    const popup = run({ failures: [denied], media: media({ origins }), facts: page(false) });
    const hotkey = run({ usePointer: true, failures: [denied], media: media({ origins }), facts: page(true) });
    expect(popup).toMatchObject({ state: "failed", failure: denied });
    expect(hotkey).toMatchObject({ state: "failed", failure: denied, reason: "pointer", targetPlaying: true });
    expect(hotkey.shownFailures).toEqual([]);
    // Nothing of its stream was seen at all, and it plays: there is nothing to save, and nothing to start.
    expect(run({ facts: page(false) })).toMatchObject({ state: "no-media" });
    expect(run({ usePointer: true, facts: page(true) })).toMatchObject({ state: "no-media", streamSource: false, targetPlaying: true });
    // A failure of another document is not this player's.
    const elsewhere = run({ usePointer: true, failures: [denied], media: media({ origins: { [MASTER]: origin(5, ["network-fetch"]) },
      frames: { 5: { documentId: "doc-5", url: "https://player.test/embed/5", generation: 0 } } }), facts: page(true) });
    expect(elsewhere).toMatchObject({ state: "no-media", failure: null });
    // A player that is not playing may not have asked for its stream yet: starting it is the advice.
    const paused = facts(frame(0, { elements: [el("v1", { source: blob })], pointer: pointerAt("v1") }));
    expect(run({ usePointer: true, facts: paused })).toMatchObject({ state: "not-loaded-yet" });
  });

  it("16b. a player that plays from memory, on a page whose script fetched a video whole: the fetched answer is checked, and a whole file is the player's video", () => {
    const FILE = "https://cdn.test/v/clip.mp4";
    const PART = "https://cdn.test/v/seg-1.mp4";
    const playing = el("v1", { source: blob, playing: true, played: true, audible: true });
    const page = (pointed: boolean) => facts(frame(0, { elements: [playing], ...(pointed ? { pointer: pointerAt("v1") } : {}) }));
    const noted = media({ fetched: { [PART]: { frameId: 0, documentId: "doc-0", ip: null }, [FILE]: { frameId: 0, documentId: "doc-0", ip: null } } });
    const asked = { frameId: 0, documentId: "doc-0", frameUrl: PAGE, scope: "element", via: "fetched", retry: false };
    // Nothing is known as this player's video yet: what its document fetched is asked about, newest first, for the popup and for Alt+S.
    for (const pointed of [false, true]) {
      const before = run({ usePointer: pointed, media: noted, facts: page(pointed) });
      expect(before).toMatchObject({ state: "no-media", main: null });
      expect(before.toProbe).toEqual([{ url: FILE, ...asked }, { url: PART, ...asked }]);
    }
    // The check listed the whole file, as a request of the document itself, and let the part go.
    const checked = { descriptors: [direct("file", FILE)], media: media({ fetched: { [FILE]: { frameId: 0, documentId: "doc-0", ip: null } },
      origins: { [FILE]: origin(0, ["network-fetch"]) } }) };
    const popup = run({ ...checked, facts: page(false) });
    expect(popup).toMatchObject({ state: "ready", main: "file", element: { frameId: 0, key: "v1" }, toProbe: [] });
    expect(selectionView(popup)).toMatchObject({ mainId: "file", elementMain: true });
    expect(run({ ...checked, usePointer: true, facts: page(true) })).toMatchObject({ state: "ready", main: "file", reason: "pointer", toProbe: [] });

    // A player whose stream is known is never a reason to look at what else its document fetched.
    const withStream = run({ descriptors: [hls("stream", MASTER)], facts: page(true), usePointer: true,
      media: media({ fetched: noted.fetched, origins: { [MASTER]: origin(0, ["network-fetch"]) } }) });
    expect(withStream).toMatchObject({ state: "ready", main: "stream", toProbe: [] });
    // Nor is a player with an address of its own, or one that has no source yet.
    for (const source of [url(CLIP), { kind: "none" } as const, { kind: "stream" } as const]) {
      const other = run({ usePointer: true, media: noted, facts: facts(frame(0, { elements: [el("v1", { source })], pointer: pointerAt("v1") })) });
      expect(other.toProbe.filter(request => request.via === "fetched"), source.kind).toEqual([]);
    }
    // What another frame's document fetched, what an earlier document of this frame fetched, and what an ad response named are not this player's.
    const elsewhere = run({ usePointer: true, facts: page(true), media: media({ ads: { "https://ads.test/spot.mp4": "vast" },
      fetched: { "https://cdn.test/v/framed.mp4": { frameId: 5, documentId: "doc-5", ip: null }, "https://cdn.test/v/old.mp4": { frameId: 0, documentId: "doc-old", ip: null },
        "https://ads.test/spot.mp4": { frameId: 0, documentId: "doc-0", ip: null } } }) });
    expect(elsewhere.toProbe).toEqual([]);
    // A failed check of a fetched answer is never recorded (background/capture.ts). A failure known for the address
    // another way, as a source the document asked for, is asked again only when the user asks again.
    const refused: DiscoveryFailure = { url: FILE, error: { code: "access_denied", severity: "terminal", phase: "direct", url: FILE, httpStatus: 403, explanation: "forbidden-or-expired-url" } };
    const failed = run({ usePointer: true, failures: [refused], facts: page(true), media: media({ fetched: { [FILE]: { frameId: 0, documentId: "doc-0", ip: null } },
      origins: { [FILE]: origin(0, ["network-fetch"]) } }) });
    expect(failed).toMatchObject({ state: "failed", failure: refused });
    expect(failed.toProbe).toEqual([{ url: FILE, ...asked, retry: true }]);
    // One look asks about a few of them, never about everything a page fetched.
    const many = Object.fromEntries(Array.from({ length: 30 }, (_item, index) => [`https://cdn.test/v/${index}.mp4`, { frameId: 0, documentId: "doc-0", ip: null }]));
    expect(run({ usePointer: true, facts: page(true), media: media({ fetched: many }) }).toProbe.map(request => request.url))
      .toEqual(Array.from({ length: 8 }, (_item, index) => `https://cdn.test/v/${29 - index}.mp4`));
  });

  // A player container whose data names a playlist the server no longer answers, before the user started the video.
  it("16c. a player that has not started, whose data names an address that failed: start playback is the answer, the failure is listed aside", () => {
    const stale = "https://proxy.test/stale/master.m3u8";
    const failure: DiscoveryFailure = { url: stale, error: { code: "server_busy", severity: "terminal", phase: "manifest", url: stale, httpStatus: 522 } };
    const player = el("v1", { groups: [group("g", [stale])] });
    const state = media({ origins: { [stale]: origin(0, ["declared"], 0, "element") } });
    const popup = run({ failures: [failure], media: state, facts: facts(frame(0, { elements: [player] })) });
    const hotkey = run({ usePointer: true, failures: [failure], media: state, facts: facts(frame(0, { elements: [player], pointer: pointerAt("v1") })) });
    for (const selection of [popup, hotkey]) {
      expect(selection).toMatchObject({ state: "not-loaded-yet", main: null, failure: null });
      expect(selection.shownFailures).toEqual([failure]);
    }
    expect(hotkey.reason).toBe("pointer");
    // The same page without a decisive player (two alike): the page's answer is the same.
    const twins = facts(frame(0, { elements: [player, el("v2", { groups: [group("g", [stale])], box: { x: 0, y: 400, width: 640, height: 360 } })] }));
    expect(run({ failures: [failure], media: state, facts: twins })).toMatchObject({ state: "not-loaded-yet", failure: null });
  });

  // A network that answers for the media server itself: the page's own request fails, and so does savemedia's check of it.
  it("16d. a player without a source whose page asked for media and did not get it: that failure is the answer, not 'start playback'", () => {
    const blocked: DiscoveryFailure = { url: MASTER, error: { code: "tls_certificate_rejected", severity: "terminal", phase: "manifest",
      browserDiagnostic: { code: "net::ERR_CERT_AUTHORITY_INVALID", host: "cdn.test", ip: "127.0.0.1", finalHost: null, redirect: null } } };
    const state = media({ origins: { [MASTER]: origin(0, ["timing", "network-fetch"]) } });
    const page = (pointed: boolean, ...more: Parameters<typeof facts>) =>
      facts(frame(0, { elements: [el("v1")], ...(pointed ? { pointer: pointerAt("v1") } : {}) }), ...more);
    const popup = run({ failures: [blocked], media: state, facts: page(false) });
    const hotkey = run({ usePointer: true, failures: [blocked], media: state, facts: page(true) });
    expect(popup).toMatchObject({ state: "failed", failure: blocked });
    expect(hotkey).toMatchObject({ state: "failed", failure: blocked, reason: "pointer" });
    expect(hotkey.shownFailures).toEqual([]);
    // Two players alike, so the page answers: the same failure.
    const twins = facts(frame(0, { elements: [el("v1"), el("v2", { box: { x: 0, y: 400, width: 640, height: 360 } })] }));
    expect(run({ failures: [blocked], media: state, facts: twins })).toMatchObject({ state: "failed", failure: blocked });
    // What another frame's document asked for is not this player's reason.
    const elsewhere = media({ origins: { [MASTER]: origin(5, ["timing", "network-fetch"]) },
      frames: { 5: { documentId: "doc-5", url: "https://player.test/embed/5", generation: 0 } } });
    expect(run({ usePointer: true, failures: [blocked], media: elsewhere, facts: page(true) })).toMatchObject({ state: "not-loaded-yet", failure: null });
    // An ad that plays in a video of its own still explains the wait.
    const withAd = facts(frame(0, { elements: [el("v1"), el("ad", { source: url(CREATIVE), playing: true, box: { x: 0, y: 400, width: 320, height: 180 } })],
      pointer: pointerAt("v1") }));
    expect(run({ usePointer: true, failures: [blocked], media: media({ ads: { [CREATIVE]: "vast" }, origins: { [MASTER]: origin(0, ["timing"]), [CREATIVE]: origin() } }),
      facts: withAd })).toMatchObject({ state: "ad-playing" });
  });

  // On these sites the browser's own media requests are not observed: only a site reader's results are listed.
  it("16e. a site read by a site reader alone: 'nothing found' and 'start playback' give way to the reason, in both build flavours", () => {
    const watch = { url: "https://video.test/watch?v=1" };
    const playing = el("v1", { source: blob, playing: true, played: true, audible: true });
    const pages = {
      "playing through MediaSource": [playing],
      "a player without a source": [el("v1")],
      "a player that has not started": [el("v1", { source: blob })],
    };
    for (const [name, elements] of Object.entries(pages)) {
      const popup = facts(frame(0, { ...watch, elements }));
      const hotkey = facts(frame(0, { ...watch, elements, pointer: pointerAt("v1") }));
      // Without the fact, the answers that hide the reason.
      expect(["no-media", "not-loaded-yet"], name).toContain(run({ facts: popup }).state);
      expect(["no-media", "not-loaded-yet"], name).toContain(run({ facts: hotkey, usePointer: true }).state);
      for (const [site, state] of [["left-out", "site-not-saved"], ["reader", "reader-found-nothing"]] as const) {
        expect(run({ site, facts: popup }), `${name}, ${site}`).toMatchObject({ state, main: null, candidates: [], failure: null });
        expect(run({ site, facts: hotkey, usePointer: true }), `${name}, ${site}`).toMatchObject({ state, main: null, candidates: [] });
      }
    }
    // A page of the site without a player: a store package still says that it saves nothing there; with a reader, the plain answer stays.
    expect(run({ site: "left-out", facts: facts(frame(0, watch)) }).state).toBe("site-not-saved");
    expect(run({ site: "reader", facts: facts(frame(0, watch)) }).state).toBe("no-media");
    expect(run({ site: "left-out" }).state).toBe("site-not-saved");
    // A build without the reader asks for no check of what such a page's players hold; a build with it checks as on any page.
    const held = facts(frame(0, { ...watch, elements: [el("v1", { source: url(CLIP) }), el("v2", { source: url(MASTER), box: { x: 0, y: 400, width: 320, height: 180 } })] }));
    expect(run({ site: "left-out", facts: held })).toMatchObject({ state: "site-not-saved", toProbe: [], listProbe: [] });
    expect(run({ site: "reader", facts: held }).toProbe.map(request => request.url)).toEqual([CLIP]);
    // What a store package would otherwise be told to wait for.
    expect(run({ site: "left-out", facts: facts(frame(0, { ...watch, page: { title: "Talk", namedFile: "Talk 7.mov" } })) }).state).toBe("site-not-saved");
    for (const site of ["left-out", "reader"] as const) {
      // What the reader named is offered as on any page.
      const found = run({ site, descriptors: [direct("file", CLIP)], media: media({ origins: { [CLIP]: origin(0, ["resolver"]) } }),
        facts: facts(frame(0, { ...watch, elements: [playing] })) });
      expect(found, site).toMatchObject({ state: "ready", main: "file" });
      // An image under the pointer is saved as on any page, and a camera stream has no file.
      const picture = "https://video.test/thumb.jpg";
      expect(run({ site, usePointer: true, facts: facts(frame(0, { ...watch, elements: [playing], pointer: { at: 1, x: 5, y: 5, overFrame: null, layers: [image(picture)] } })) }),
        site).toMatchObject({ state: "no-media", image: { url: picture } });
      const camera = facts(frame(0, { ...watch, elements: [el("cam", { source: { kind: "stream" }, playing: true })], pointer: pointerAt("cam") }));
      expect(run({ site, usePointer: true, facts: camera }), site).toMatchObject({ state: "no-media", streamSource: true });
      // A check that failed is still the answer.
      const failure = busy(CLIP);
      expect(run({ site, failures: [failure], facts: facts(frame(0, { ...watch, elements: [el("v1", { source: url(CLIP) })] })) }), site)
        .toMatchObject({ state: "failed", failure });
    }
  });

  it("16b. a camera or screen stream under the pointer has no file to save", () => {
    const selection = run({ usePointer: true, facts: facts(frame(0, { elements: [el("cam", { source: { kind: "stream" } })], pointer: pointerAt("cam") })) });
    expect(selection).toMatchObject({ state: "no-media", streamSource: true });
  });

  it("17. the toolbar count is the number of cards: renditions of one video are one card", () => {
    const rendition = (id: string, address: string) => direct(id, address, { mediaGroup: "g" });
    const selection = run({ descriptors: [rendition("a", "https://cdn.test/a.mp4"), rendition("b", "https://cdn.test/b.mp4"), hls("s", MASTER), drmDescriptor()] });
    expect(selection.cards).toHaveLength(3);
    expect(selectionView(selection).cards).toHaveLength(3);
  });

  it("18. the page's name goes to the page's only direct file when the server gave it none", () => {
    const named = facts(frame(0, { page: { title: "Test pattern", namedFile: "Test pattern 31.mov" },
      elements: [el("v1", { source: url("https://site.test/signed-movie.mov?file=31") })] }));
    const file = direct("file", "https://site.test/signed-movie.mov?file=31", { title: "signed-movie.mov", container: "mov" });
    const origins = { "https://site.test/signed-movie.mov?file=31": origin(), [CLIP]: origin() };
    expect(run({ descriptors: [file], facts: named, media: media({ origins }) })).toMatchObject({ state: "ready", main: "file", mainName: "Test pattern 31.mov" });
    expect(selectionView(run({ descriptors: [file], facts: named, media: media({ origins }) })).mainName).toBe("Test pattern 31.mov");
    // Two direct files: the name could mean either.
    expect(run({ descriptors: [file, direct("other", CLIP)], facts: named, media: media({ origins }) }).mainName).toBeNull();
    // The server named the file itself.
    const serverNamed = { ...file, source: { kind: "direct-url" as const, url: "https://site.test/signed-movie.mov?file=31", headers: { "content-disposition": "attachment; filename=\"Original.mov\"" } } };
    expect(run({ descriptors: [serverNamed], facts: named, media: media({ origins }) }).mainName).toBeNull();
    // A page that declares the file's link is saved through that link, not renamed here.
    const linked = facts(frame(0, { page: { title: "Test pattern", fileDownload: { filename: "Test pattern 31.mov", url: "https://site.test/file/31" } } }));
    expect(run({ descriptors: [file], facts: linked, media: media({ origins }) }).mainName).toBeNull();
    // Whenever something listed can be the named file, nothing says that the file has not arrived.
    for (const descriptors of [[file], [file, direct("other", CLIP)], [serverNamed]]) {
      expect(run({ descriptors, facts: named, media: media({ origins }) }).namedPending).toBeNull();
    }
  });

  it("18b. a page that names a file and plays a preview of another kind: the preview keeps its own name, and the named file is said not to have arrived", () => {
    const PREVIEW = "https://site.test/preview/9f3a.mp4";
    const page = (namedFile: string) => facts(frame(0, { page: { title: namedFile, namedFile },
      elements: [el("v1", { source: url(PREVIEW), playing: true, played: true, muted: true })] }));
    const preview = direct("preview", PREVIEW, { container: "mp4" });
    const state = media({ origins: { [PREVIEW]: origin() } });
    // The bytes are MP4, and the page names a Matroska file: the preview is not that file.
    const mkv = run({ descriptors: [preview], facts: page("Holiday.Trip.2024.1080p.mkv"), media: state });
    expect(mkv).toMatchObject({ state: "ready", main: "preview", mainName: null, namedPending: "Holiday.Trip.2024.1080p.mkv" });
    expect(selectionView(mkv)).toMatchObject({ mainName: null, namedPending: "Holiday.Trip.2024.1080p.mkv" });
    // The same with the pointer on the preview, and for names of other kinds than the bytes.
    expect(run({ descriptors: [preview], media: state, usePointer: true,
      facts: facts({ ...page("Holiday.Trip.2024.1080p.mkv").frames[0]!, pointer: pointerAt("v1") }) }))
      .toMatchObject({ state: "ready", main: "preview", reason: "pointer", mainName: null, namedPending: "Holiday.Trip.2024.1080p.mkv" });
    for (const name of ["Trip.mov", "Trip.webm", "Trip.MKV"]) {
      expect(run({ descriptors: [preview], facts: page(name), media: state }), name).toMatchObject({ mainName: null, namedPending: name });
    }
    // A stream is never the named file either: the page plays an HLS preview of it.
    const stream = run({ descriptors: [hls("stream", MASTER)], facts: facts(frame(0, { page: { title: "Trip.mkv", namedFile: "Trip.mkv" }, elements: [el("v1", { source: blob })] })),
      media: media({ origins: { [MASTER]: origin(0, ["network-fetch"]) } }) });
    expect(stream).toMatchObject({ state: "ready", main: "stream", mainName: null, namedPending: "Trip.mkv" });
    // Bytes of the kind the name says: the name is the file's, as on the page that plays the very file it names.
    for (const [name, container] of [["Trip.mp4", "mp4"], ["Trip.m4v", "mp4"], ["Trip.mp4", "fmp4"], ["Trip.mkv", "mkv"], ["Trip.webm", "webm"], ["Trip.mov", "mov"]] as const) {
      expect(run({ descriptors: [direct("preview", PREVIEW, { container })], facts: page(name), media: state }), `${name} as ${container}`)
        .toMatchObject({ state: "ready", mainName: name, namedPending: null });
    }
    // Nothing listed at all is the state of its own, with its own text.
    expect(run({ facts: facts(frame(0, { page: { title: "Trip.mkv", namedFile: "Trip.mkv" } })) })).toMatchObject({ state: "file-not-received", namedPending: null });
    // A page that names no file never has a pending one.
    expect(run({ descriptors: [preview], facts: facts(frame(0, { elements: [el("v1", { source: url(PREVIEW) })] })), media: state }).namedPending).toBeNull();
  });

  it("checks a visible player's own unverified source, with the page's declared quality and name", () => {
    const declared = group("g", [["https://cdn.test/low.mp4", 480], ["https://cdn.test/high.mp4", 720]]);
    const player = el("v1", { source: url("https://cdn.test/low.mp4"), groups: [declared] });
    const other = el("v2", { source: url("https://cdn.test/other.mp4"), box: { x: 0, y: 500, width: 200, height: 100 } });
    const selection = run({ facts: facts(frame(0, { elements: [player, other] })) });
    expect(selection.toProbe.map(request => [request.url, request.height, request.groupId, request.scope, request.via])).toEqual([
      ["https://cdn.test/low.mp4", 480, "g", "element", "declared"], ["https://cdn.test/high.mp4", 720, "g", "element", "declared"]]);
    expect(selection.listProbe.map(request => request.url)).toEqual(["https://cdn.test/other.mp4"]);
  });

  it("a player whose stream is protected by its manifest is protected, and manifest protection alone is the page's state", () => {
    const widevine = { ...drmDescriptor(), id: "wv" as StreamId, source: { kind: "dash-manifest", manifestUrl: "https://cdn.test/wv.mpd" }, protocol: "dash" } as const;
    const withPlayer = run({ descriptors: [widevine], media: media({ origins: { "https://cdn.test/wv.mpd": origin(0, ["network-fetch"]) } }),
      facts: facts(frame(0, { elements: [el("v1", { source: blob, playing: true })] })) });
    expect(withPlayer).toMatchObject({ state: "protected", main: "wv", candidates: ["wv"] });
    expect(run({ descriptors: [widevine] })).toMatchObject({ state: "protected", main: "wv" });
    expect(run({ descriptors: [dashDescriptor({ variants: [] })] })).toMatchObject({ state: "unsupported" });
  });

  it("offers a complete stream before a single track of it that the page also loaded", () => {
    // A DASH presentation with video and audio, and one of its fragmented MP4 tracks captured as a file of its own.
    const mpd = dashDescriptor({ id: "mpd" as StreamId, pageUrl: PAGE });
    const pair = { ...mpd, audioRenditions: [{ ...mpd.variants[0]!, id: "audio" as never, width: null, height: null, videoCodec: null, audioRenditionId: "a" as never }],
      variants: [{ ...mpd.variants[0]!, audioCodec: null }] };
    const track = direct("track", "https://cdn.test/video_1080.mp4", { container: "fmp4" });
    const selection = run({ descriptors: [track, pair] });
    expect(selection.cards.map(card => card.ids[0]).sort()).toEqual(["mpd", "track"]);
    // The presentation states its quality and carries sound; the lone track does not outrank it.
    expect(selection).toMatchObject({ state: "ready", main: "mpd", candidates: ["mpd"] });
  });

  it("a pointer on an image selects the image, and an image below a canvas selects the page's video", () => {
    const photo = run({ usePointer: true, descriptors: [direct("clip", CLIP)],
      facts: facts(frame(0, { pointer: { at: 1, x: 1, y: 1, overFrame: null, layers: [image("https://site.test/card.png")] } })) });
    expect(photo.image).toEqual({ url: "https://site.test/card.png", pageUrl: PAGE, loaded: false });
    const shown = run({ usePointer: true, descriptors: [],
      facts: facts(frame(0, { pointer: { at: 1, x: 1, y: 1, overFrame: null, layers: [image("http://192.168.1.10/cam.jpg", { loaded: true })] } })) });
    expect(shown.image).toEqual({ url: "http://192.168.1.10/cam.jpg", pageUrl: PAGE, loaded: true });
    const chart = run({ usePointer: true, descriptors: [direct("clip", CLIP)], facts: facts(frame(0, { pointer: { at: 1, x: 1, y: 1, overFrame: null,
      layers: [{ kind: "canvas", feed: { kind: "none" } }, image("https://site.test/photo.png", { belowCanvas: true })] } })) });
    expect(chart).toMatchObject({ image: null, state: "ready", main: "clip" });
  });

  it("names the checks of the element first and of the page after it, one per address, and at most twenty of each kind", () => {
    const file = (name: string) => `https://cdn.test/declared/${name}.mp4`;
    // The player has no source yet. Its own data declares twelve renditions; the page declares fifteen, three of them the same.
    const own = Array.from({ length: 12 }, (_item, index) => file(`own-${index}`));
    const pageWide = [...own.slice(0, 3), ...Array.from({ length: 12 }, (_item, index) => file(`page-${index}`))];
    const player = el("v1", { groups: [group("player", own)] });
    // Twenty-five more players with a file of their own, smaller and below it; one of them plays a rendition the main player declares.
    const others = Array.from({ length: 25 }, (_item, index) => el(`o${String(index).padStart(2, "0")}`, {
      source: url(index === 0 ? own[5]! : file(`other-${index}`)), box: { x: 0, y: 400 + index * 10, width: 100 + index, height: 50 } }));
    const loaded = "https://cdn.test/loaded.mp4";
    const selection = run({ descriptors: [direct("loaded", loaded)], media: media({ origins: { [loaded]: origin() } }),
      facts: facts(frame(0, { elements: [player, ...others], pageGroups: [group("page", pageWide, { proximity: 3, primary: true })] })) });
    expect(selection).toMatchObject({ state: "ready", main: "loaded" });
    // The element's twelve come first. A page source of the same address takes the element's place in the order, with the page's scope.
    expect(selection.toProbe.map(request => [request.url, request.scope])).toEqual([
      ...own.map((address, index) => [address, index < 3 ? "page" : "element"]),
      ...pageWide.slice(3, 11).map(address => [address, "page"]),
    ]);
    expect(selection.toProbe).toHaveLength(20);
    expect(selection.toProbe.every(request => request.groupId === (request.scope === "page" ? "page" : "player"))).toBe(true);
    // The other players' own files are checked only for the popup's list: best player first, none twice, twenty at most.
    expect(selection.listProbe).toHaveLength(20);
    expect(selection.listProbe.every(request => request.scope === "element" && request.via === "element")).toBe(true);
    const listed = selection.listProbe.map(request => request.url);
    expect(listed).not.toContain(own[5]);
    expect(listed).toEqual(Array.from({ length: 20 }, (_item, index) => file(`other-${24 - index}`)));
  });

  it("14b. a canvas that draws a video the page never attached: the one stream its document loaded outside any element is what Alt+S saves", () => {
    const TOUR = "https://cdn.test/vr/tour.mp4";
    const TEASER = "https://cdn.test/teaser.mp4";
    const onCanvas = { at: 1, x: 5, y: 5, overFrame: null, layers: [{ kind: "canvas", feed: { kind: "none" } }] as const };
    // A muted teaser plays in the sidebar: it is the page's only video element.
    const teaser = el("teaser", { source: url(TEASER), playing: true, played: true, muted: true, box: { x: 700, y: 0, width: 320, height: 180 } });
    const base = { descriptors: [direct("tour", TOUR), direct("teaser", TEASER)], media: media({ origins: { [TOUR]: origin(), [TEASER]: origin() } }) };
    const pointed = run({ ...base, usePointer: true, facts: facts(frame(0, { elements: [teaser], pointer: onCanvas })) });
    expect(pointed).toMatchObject({ state: "ready", main: "tour", candidates: ["tour"], reason: "pointer", element: null, image: null });
    // Without the pointer, and with the pointer on the teaser, the teaser is the answer as before.
    expect(run({ ...base, facts: facts(frame(0, { elements: [teaser] })) })).toMatchObject({ state: "ready", main: "teaser" });
    expect(run({ ...base, usePointer: true, facts: facts(frame(0, { elements: [teaser], pointer: pointerAt("teaser") })) }))
      .toMatchObject({ state: "ready", main: "teaser", reason: "pointer" });

    // Two streams outside any element: which one the canvas draws cannot be told, so the page's best video is the answer.
    const second = "https://cdn.test/vr/other.mp4";
    const two = run({ descriptors: [...base.descriptors, direct("other", second)], media: media({ origins: { [TOUR]: origin(), [TEASER]: origin(), [second]: origin() } }),
      usePointer: true, facts: facts(frame(0, { elements: [teaser], pointer: onCanvas })) });
    expect(two).toMatchObject({ state: "ready", main: "teaser" });
    expect(two.reason).not.toBe("pointer");

    // A stream another document loaded is not this canvas's: the frame's own canvas takes the frame's stream.
    const inFrame = { ...base, media: media({ origins: { [TOUR]: origin(4), [TEASER]: origin() } }) };
    const top = frame(0, { elements: [teaser], childFrames: [{ index: 0, box: { x: 0, y: 0, width: 640, height: 360 }, visible: { x: 0, y: 0, width: 640, height: 360 } }] });
    expect(run({ ...inFrame, usePointer: true, facts: facts({ ...top, pointer: onCanvas }) })).toMatchObject({ state: "ready", main: "teaser" });
    expect(run({ ...inFrame, usePointer: true, facts: facts(top, frame(4, { pointer: onCanvas })) })).toMatchObject({ state: "ready", main: "tour", reason: "pointer" });

    // A canvas with nothing behind it and nothing on the page says so plainly: there is no media.
    expect(run({ usePointer: true, facts: facts(frame(0, { pointer: onCanvas })) })).toMatchObject({ state: "no-media", main: null });
    // An ad, a protected or a live stream is never what a canvas "draws".
    const adOnly = run({ descriptors: [direct("tour", TOUR)], media: media({ ads: { [TOUR]: "vast" }, origins: { [TOUR]: origin() } }),
      usePointer: true, facts: facts(frame(0, { pointer: onCanvas })) });
    expect(adOnly).toMatchObject({ state: "no-media", main: null });
  });

  it("14c. a control or a badge above such a canvas: the stream the canvas draws is saved, and an image only where the document loaded none", () => {
    const TOUR = "https://cdn.test/vr/tour.mp4";
    const canvas = { kind: "canvas", feed: { kind: "none" } } as const;
    const over = (...layers: Parameters<typeof image>[]) => ({ at: 1, x: 5, y: 5, overFrame: null, layers: [...layers.map(args => image(...args)), canvas] });
    const base = { descriptors: [direct("tour", TOUR)], media: media({ origins: { [TOUR]: origin() } }), usePointer: true };
    // The player's play button, drawn as a decorative image or a background image above the canvas.
    for (const layers of [[["https://site.test/ui/big-play.png", { decorative: true }]], [["https://site.test/ui/big-play.png"]],
      [["https://site.test/ui/big-play.png", { decorative: true }], ["https://site.test/ui/logo.png", { loaded: true }]]] as Parameters<typeof image>[][]) {
      const pointed = run({ ...base, facts: facts(frame(0, { pointer: over(...layers) })) });
      expect(pointed, JSON.stringify(layers)).toMatchObject({ state: "ready", main: "tour", candidates: ["tour"], reason: "pointer", image: null });
    }
    // The same answer as on the bare canvas beside the control.
    expect(run({ ...base, facts: facts(frame(0, { pointer: over() })) })).toMatchObject({ state: "ready", main: "tour", image: null });
    // A chart or a game: the document loaded no stream, so the badge above the canvas is what the user points at.
    const badge = run({ usePointer: true, facts: facts(frame(0, { pointer: over(["https://site.test/card.png", { loaded: true }]) })) });
    expect(badge).toMatchObject({ state: "no-media", main: null, reason: null, image: { url: "https://site.test/card.png", pageUrl: PAGE, loaded: true } });
    // Several streams outside any element: which one the canvas draws cannot be told, and the image is the target.
    const second = "https://cdn.test/vr/other.mp4";
    const two = run({ descriptors: [direct("tour", TOUR), direct("other", second)], media: media({ origins: { [TOUR]: origin(), [second]: origin() } }),
      usePointer: true, facts: facts(frame(0, { pointer: over(["https://site.test/card.png"]) })) });
    expect(two).toMatchObject({ state: "no-media", main: null, image: { url: "https://site.test/card.png" } });
    // An image below the canvas is still never the target.
    const below = run({ ...base, facts: facts(frame(0, { pointer: { at: 1, x: 5, y: 5, overFrame: null,
      layers: [canvas, image("https://site.test/photo.png", { belowCanvas: true })] } })) });
    expect(below).toMatchObject({ state: "ready", main: "tour", image: null });
  });

  it("6b. a muted autoplaying teaser gives way to a video that is larger or longer, and keeps its place next to neither", () => {
    const origins = { "https://cdn.test/teaser.mp4": origin(), "https://cdn.test/talk.mp4": origin() };
    const base = { descriptors: [direct("teaser", "https://cdn.test/teaser.mp4"), direct("talk", "https://cdn.test/talk.mp4")], media: media({ origins }) };
    const teaser = el("teaser", { source: url("https://cdn.test/teaser.mp4"), playing: true, played: true, muted: true, duration: 30,
      box: { x: 0, y: 0, width: 960, height: 540 } });
    // The article's 20-minute player is smaller than the 30-second teaser above it, but longer: it is the main video.
    const talk = el("talk", { source: url("https://cdn.test/talk.mp4"), duration: 1200, box: { x: 0, y: 600, width: 640, height: 100 } });
    expect(run({ ...base, facts: facts(frame(0, { elements: [teaser, talk] })) })).toMatchObject({ main: "talk", element: { key: "talk" } });
    // A feed's post plays without sound beside a small preview of unknown length: nothing outdoes it, it stays the main video.
    const preview = el("talk", { source: url("https://cdn.test/talk.mp4"), box: { x: 0, y: 600, width: 160, height: 90 } });
    expect(run({ ...base, facts: facts(frame(0, { elements: [teaser, preview] })) })).toMatchObject({ main: "teaser", reason: "playing" });
  });

  it("4c. a playing post and the next post's stream fetched ahead: the last request does not decide whose stream it is", () => {
    const [p1, p2] = ["https://cdn.test/p1.m3u8", "https://cdn.test/p2.m3u8"];
    const post = (key: string, over = {}) => el(key, { source: blob, duration: 30, ...over });
    const base = { descriptors: [hls("p1", p1), hls("p2", p2)], media: media({
      origins: { [p1]: origin(0, ["network-fetch"]), [p2]: origin(0, ["network-fetch"]) },
      timelines: { [p1]: timeline(30), [p2]: timeline(30) },
      // The page requested the next post's playlist after the playing post had buffered to its end.
      activity: { [p1]: { at: 100, frameId: 0, generation: 0 }, [p2]: { at: 200, frameId: 0, generation: 0 } } }) };
    const posts = [post("v1", { playing: true, played: true, muted: true }), post("v2", { render: "offscreen" })];
    const pointed = run({ ...base, usePointer: true, facts: facts(frame(0, { elements: posts, pointer: pointerAt("v1") })) });
    expect(pointed).toMatchObject({ state: "ambiguous", main: null, targetPlaying: true });
    const popup = run({ ...base, facts: facts(frame(0, { elements: posts })) });
    expect(popup).toMatchObject({ state: "ready", element: null });
    expect(popup.cards.every(card => card.element === null)).toBe(true);
    // With one stream left over, the one playing post is its player.
    const one = run({ ...base, descriptors: [hls("p1", p1)], usePointer: true, facts: facts(frame(0, { elements: posts, pointer: pointerAt("v1") })) });
    expect(one).toMatchObject({ state: "ready", main: "p1", element: { key: "v1" } });
  });

  it("4d. one MediaSource player and two streams of this route: Alt+S and the popup say the same about it", () => {
    const [main, promo] = ["https://cdn.test/main.m3u8", "https://cdn.test/promo.m3u8"];
    const base = { descriptors: [hls("main", main), hls("promo", promo)], media: media({
      origins: { [main]: origin(0, ["network-fetch"]), [promo]: origin(0, ["network-fetch"]) },
      activity: { [main]: { at: 200, frameId: 0, generation: 0 }, [promo]: { at: 100, frameId: 0, generation: 0 } } }) };
    const player = el("v1", { source: blob, playing: true, played: true, audible: true });
    const pointed = run({ ...base, usePointer: true, facts: facts(frame(0, { elements: [player], pointer: pointerAt("v1") })) });
    // The player is playing: the answer must not ask the user to start it.
    expect(pointed).toMatchObject({ state: "ambiguous", targetPlaying: true });
    const popup = run({ ...base, facts: facts(frame(0, { elements: [player] })) });
    // The popup offers the page's best stream, without naming it this player's.
    expect(popup).toMatchObject({ state: "ready", element: null });
    expect(selectionView(popup).elementMain).toBe(false);
  });

  it("1b. a pre-roll in a video of its own above the content video: an ad is playing, not 'start playback'", () => {
    const ad = el("ad", { source: url(CREATIVE), playing: true, played: true, audible: true });
    const content = el("content");
    const base = { descriptors: [direct("creative", CREATIVE)], media: media({ ads: { [CREATIVE]: "vast" }, origins: { [CREATIVE]: origin() } }) };
    expect(run({ ...base, facts: facts(frame(0, { elements: [ad, content] })) })).toMatchObject({ state: "ad-playing", main: null });
    const pointed = run({ ...base, usePointer: true, facts: facts(frame(0, { elements: [ad, content],
      pointer: { at: 1, x: 5, y: 5, overFrame: null, layers: [video("ad"), video("content")] } })) });
    expect(pointed).toMatchObject({ state: "ad-playing", reason: "pointer" });
    // Without an ad next to it, the same player has simply not been given its video yet.
    expect(run({ facts: facts(frame(0, { elements: [content] })) })).toMatchObject({ state: "not-loaded-yet" });
  });

  it("1f. a pre-roll in a frame laid over the content player, or over a player frame: one rule says an ad is playing, for the popup and for Alt+S", () => {
    const state = (frameId: number) => ({ descriptors: [direct("creative", CREATIVE)],
      media: media({ ads: { [CREATIVE]: "vast" }, origins: { [CREATIVE]: origin(frameId) } }) });
    const place = (box: { x: number; y: number; width: number; height: number }) => [{ index: 0, box, visible: box }];
    const playingAd = (box?: { x: number; y: number; width: number; height: number }, over: Partial<Parameters<typeof el>[1]> = {}) =>
      el("ad", { source: url(CREATIVE), playing: true, played: true, audible: true, ...(box ? { box } : {}), ...over });

    // The ad's frame covers the player: the empty content player is in the top document, the ad video in the frame.
    const overPlayer = { x: 0, y: 0, width: 640, height: 360 };
    const top = frame(0, { elements: [el("content")], childFrames: place(overPlayer) });
    const adFrame = frame(1, { url: "https://ads.test/slot", viewport: { width: 640, height: 360 }, elements: [playingAd()] });
    const base = state(1);
    expect(run({ ...base, facts: facts(top, adFrame) })).toMatchObject({ state: "ad-playing", main: null });
    // Alt+S with the pointer recorded on the player, and with the pointer recorded inside the ad's frame.
    expect(run({ ...base, usePointer: true, facts: facts({ ...top, pointer: pointerAt("content") }, adFrame) }))
      .toMatchObject({ state: "ad-playing", main: null, reason: "pointer" });
    expect(run({ ...base, usePointer: true, facts: facts({ ...top, pointer: { at: 10, x: 5, y: 5, overFrame: 0, layers: [{ kind: "frame", index: 0 }, video("content")] } },
      { ...adFrame, pointer: pointerAt("ad") }) })).toMatchObject({ state: "ad-playing", main: null });
    // The ad is listed under the ads all along, as the browser loaded it.
    expect(run({ ...base, facts: facts(top, adFrame) }).ads.map(card => card.ids)).toEqual([["creative"]]);

    // The other way round: the page's own ad video lies over an embedded player that has no source yet.
    const adOnPage = frame(0, { elements: [playingAd(overPlayer)], childFrames: place(overPlayer) });
    const playerFrame = frame(1, { viewport: { width: 640, height: 360 }, elements: [el("content")] });
    const reversed = state(0);
    expect(run({ ...reversed, facts: facts(adOnPage, playerFrame) })).toMatchObject({ state: "ad-playing", main: null });
    expect(run({ ...reversed, usePointer: true, facts: facts(adOnPage, { ...playerFrame, pointer: pointerAt("content") }) }))
      .toMatchObject({ state: "ad-playing", main: null, reason: "pointer" });

    // An ad in a frame of its own beside the player (a sidebar ad) says nothing about the player: it still waits for its video.
    const sidebar = { x: 900, y: 0, width: 300, height: 250 };
    const beside = frame(0, { elements: [el("content")], childFrames: place(sidebar) });
    const sidebarAd = frame(1, { url: "https://ads.test/slot", viewport: { width: 300, height: 250 },
      elements: [playingAd({ x: 0, y: 0, width: 300, height: 250 }, { audible: false, muted: true })] });
    expect(run({ ...base, facts: facts(beside, sidebarAd) })).toMatchObject({ state: "not-loaded-yet", main: null });
    expect(run({ ...base, usePointer: true, facts: facts({ ...beside, pointer: pointerAt("content") }, sidebarAd) }))
      .toMatchObject({ state: "not-loaded-yet", main: null, reason: "pointer" });
    // The page's own answer follows the same rule where no player is decisively first: two empty players and that sidebar ad.
    const twin = el("second", { box: { x: 0, y: 400, width: 640, height: 360 } });
    expect(run({ ...base, facts: facts({ ...beside, elements: [el("content"), twin] }, sidebarAd) })).toMatchObject({ state: "not-loaded-yet" });
    expect(run({ ...base, facts: facts({ ...top, elements: [el("content"), twin] }, adFrame) })).toMatchObject({ state: "ad-playing" });
    // An ad that is all the page shows is still an ad that plays.
    expect(run({ ...base, facts: facts(frame(0, { childFrames: place(sidebar) }), sidebarAd) })).toMatchObject({ state: "ad-playing" });
  });

  it("21. a player frame the page removed: what it loaded is no longer listed, saved or counted", () => {
    const old = "https://cdn.test/old.webm";
    const base = { descriptors: [direct("old", old)], facts: facts(frame(0), frame(6, { elements: [el("v1")] })) };
    const origins = { [old]: { ...origin(5), documentId: "doc-5" } };
    // The browser still lists frame 5: its video is the page's.
    const listedFrame = run({ ...base, media: media({ origins, frames: { 5: { documentId: "doc-5", url: "https://player.test/embed/5", generation: 0 } } }) });
    expect(listedFrame.cards.map(card => card.ids)).toEqual([["old"]]);
    // The page replaced the frame: the new player has no video yet, and the old one is not offered in its place.
    const removed = run({ ...base, media: media({ origins, frames: { 5: { documentId: REMOVED_FRAME, url: "https://player.test/embed/5", generation: 0 } } }) });
    expect(removed).toMatchObject({ state: "not-loaded-yet", main: null, cards: [] });
  });
});
