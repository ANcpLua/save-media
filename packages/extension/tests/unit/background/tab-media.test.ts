import { describe, expect, it } from "vitest";
import { createTabMediaStore, put, urlsOf } from "../../../src/background/tab-media";
import { directDescriptor, hlsDescriptor } from "../popup/helpers/descriptors";
import type { StreamId } from "@savemedia/core";

const origin = (generation: number, frameId = 0) => ({ frameId, documentId: "doc", generation, via: ["network-media"], scope: null }) as const;

describe("tab media store", () => {
  it("marks ads once: a second mark of the same address reports nothing new", () => {
    const store = createTabMediaStore();
    expect(store.markAds(1, ["https://ads.test/a.mp4#t", "https://ads.test/b.mp4"], "vast")).toEqual(["https://ads.test/a.mp4", "https://ads.test/b.mp4"]);
    expect(store.markAds(1, ["https://ads.test/a.mp4", "https://ads.test/c.mp4"], "vmap")).toEqual(["https://ads.test/c.mp4"]);
    expect(store.isAd(1, "https://ads.test/a.mp4#again")).toBe(true);
    expect(store.isAd(2, "https://ads.test/a.mp4")).toBe(false);
    expect(store.tab(1).ads["https://ads.test/a.mp4"]).toBe("vast");
  });

  it("merges where an address was seen: union of ways, latest frame, highest generation", () => {
    const store = createTabMediaStore();
    store.recordOrigin(1, "https://cdn.test/a.m3u8?_HLS_msn=4", origin(2));
    store.recordOrigin(1, "https://cdn.test/a.m3u8", { frameId: 3, documentId: null, generation: 1, via: ["declared"], scope: "page" });
    expect(store.originOf(1, ["https://cdn.test/a.m3u8"])).toEqual({ frameId: 3, documentId: "doc", generation: 2, via: ["network-media", "declared"], scope: "page" });
    expect(store.originOf(1, ["https://cdn.test/other"])).toBeNull();
  });

  it("notes a request for a segment as activity of the stream that owns it", () => {
    let now = 100;
    const store = createTabMediaStore(() => now);
    const media = hlsDescriptor({ id: "media" as StreamId, source: { kind: "hls-manifest", manifestUrl: "https://cdn.test/v/media.m3u8", type: "media" },
      variants: [{ ...hlsDescriptor().variants[0]!, segmentRef: { kind: "hls-segments", playlistUrl: "https://cdn.test/v/media.m3u8",
        initSegmentUrl: "https://cdn.test/v/init.mp4", segmentUrls: ["https://cdn.test/v/seg1.m4s"], encryption: null } }] });
    store.indexOwners(1, media);
    expect(store.touch(1, "https://cdn.test/v/seg1.m4s", 0, 2)).toBe(true);
    expect(store.tab(1).activity).toEqual({ "https://cdn.test/v/media.m3u8": { at: 100, frameId: 0, generation: 2 } });
    now = 200;
    expect(store.touch(1, "https://cdn.test/v/media.m3u8?_HLS_msn=9", 4, 3)).toBe(true);
    expect(store.tab(1).activity["https://cdn.test/v/media.m3u8"]).toEqual({ at: 200, frameId: 4, generation: 3 });
    expect(store.touch(1, "https://cdn.test/unrelated.js", 0, 0)).toBe(false);
  });

  it("gives a protected element the same descriptor id every time, and keeps a key system once known", () => {
    const store = createTabMediaStore();
    const first = store.upsertElementDrm(7, 0, "doc-a", "v2", null, null);
    const again = store.upsertElementDrm(7, 0, "doc-a", "v2", "com.widevine.alpha", "https://cdn.test/a.mp4");
    const later = store.upsertElementDrm(7, 0, "doc-a", "v2", null, null);
    expect(again.id).toBe(first.id);
    expect(later).toEqual({ id: first.id, keySystem: "com.widevine.alpha", elementSrc: "https://cdn.test/a.mp4", frameId: 0 });
    expect(store.upsertElementDrm(7, 0, "doc-a", "v3", null, null).id).not.toBe(first.id);
    expect(store.upsertElementDrm(7, 2, null, null, null, null).id).toBe("protected:7:frame-2/document");
  });

  it("remembers what the browser itself received, with the server address", () => {
    const store = createTabMediaStore();
    expect(store.received(1, "https://cdn.test/a.mp4")).toBeNull();
    store.noteReceived(1, "https://cdn.test/a.mp4", "93.184.216.34", 3);
    store.noteReceived(1, "https://cdn.test/b.mp4", null);
    expect(store.received(1, "https://cdn.test/a.mp4#t=4")).toEqual({ ip: "93.184.216.34", frameId: 3 });
    expect(store.received(1, "https://cdn.test/b.mp4")).toEqual({ ip: null, frameId: 0 });
    expect(store.received(1, "constructor")).toBeNull();
  });

  it("keeps the origins the browser itself was answered from inside the user's network, per document", () => {
    const changes: string[] = [];
    const store = createTabMediaStore(Date.now, (_tabId, part) => changes.push(part));
    expect(store.localOrigin(1, "http://192.168.1.10/movie.mp4")).toBe(false);
    // It says whether the origin is new for the tab: a source that waited for it can be checked again.
    expect(store.noteLocalOrigin(1, "http://192.168.1.10/movie.mp4")).toBe(true);
    expect(store.noteLocalOrigin(1, "http://192.168.1.10/other/clip.mp4?x=1")).toBe(false);
    expect(store.noteLocalOrigin(1, "https://media.public-site.net:8443/a.m3u8")).toBe(true);
    // Not an address of a server: nothing is noted.
    expect(store.noteLocalOrigin(1, "blob:https://site.test/1")).toBe(false);
    expect(store.noteLocalOrigin(1, "constructor")).toBe(false);
    // The same origin again is no change to store.
    expect(changes).toEqual(["received", "received"]);
    // The origin is scheme, host and port: another port or scheme is another server.
    expect(store.localOrigin(1, "http://192.168.1.10/any/path.ts")).toBe(true);
    expect(store.localOrigin(1, "http://192.168.1.10:8080/movie.mp4")).toBe(false);
    expect(store.localOrigin(1, "https://192.168.1.10/movie.mp4")).toBe(false);
    expect(store.localOrigin(1, "https://media.public-site.net:8443/seg1.ts")).toBe(true);
    expect(store.localOrigin(2, "http://192.168.1.10/movie.mp4")).toBe(false);
    expect(store.localOrigins(1)).toEqual(["http://192.168.1.10", "https://media.public-site.net:8443"]);
    expect(store.localOrigins(9)).toEqual([]);
    // A new document starts with none: what another page loaded says nothing about this one.
    store.reset(1);
    expect(store.localOrigins(1)).toEqual([]);
  });

  it("keeps at most a bounded number of those origins, the latest ones", () => {
    const store = createTabMediaStore();
    for (let index = 0; index < 80; index++) store.noteLocalOrigin(1, `http://10.0.0.${index}/v.mp4`);
    expect(store.localOrigins(1)).toHaveLength(64);
    expect(store.localOrigin(1, "http://10.0.0.0/v.mp4")).toBe(false);
    expect(store.localOrigin(1, "http://10.0.0.79/v.mp4")).toBe(true);
  });

  it("resets everything about the old document but keeps the frame record", () => {
    const store = createTabMediaStore();
    store.tab(1).topDocument = "doc-b";
    store.tab(1).frames[0] = { documentId: "doc-b", url: "https://site.test/", generation: 0 };
    store.markAds(1, ["https://ads.test/a.mp4"], "vast");
    store.recordTimeline(1, "https://cdn.test/a.m3u8", { live: true, durationSeconds: 4, maxSegmentSeconds: 2 });
    store.reset(1);
    expect(store.tab(1)).toMatchObject({ topDocument: "doc-b", frames: { 0: { documentId: "doc-b" } }, ads: {}, timelines: {} });
  });

  it("keeps the last facts without their thumbnails", () => {
    const store = createTabMediaStore();
    store.setFacts(1, { reachable: true, frames: [{ frameId: 0, documentId: "d", url: "https://site.test/", top: true, path: [], viewport: { width: 1, height: 1 },
      childFrames: [], pageGroups: [], pointer: null, elements: [{ key: "v1", source: { kind: "none" }, groups: [], render: "visible",
        box: { x: 0, y: 0, width: 1, height: 1 }, visible: null, canvas: null, playing: false, played: false, audible: false, muted: false, duration: null,
        live: false, pip: false, fullscreen: false, keyed: null, width: 1, height: 1, poster: null, thumbnail: "data:image/jpeg;base64,AAAA" }] }] });
    expect(store.tab(1).facts?.frames[0]?.elements[0]).not.toHaveProperty("thumbnail");
  });

  it("lists a master's variant playlists among its addresses, so facts about them reach the master", () => {
    const master = hlsDescriptor();
    expect(urlsOf(master)).toEqual(["https://example.com/master.m3u8"]);
    const two = hlsDescriptor({ variants: [{ ...master.variants[0]!, segmentRef: { kind: "hls-segments", playlistUrl: "https://example.com/720.m3u8?_HLS_skip=YES",
      initSegmentUrl: null, segmentUrls: [], encryption: null } }] });
    expect(urlsOf(two)).toEqual(["https://example.com/master.m3u8", "https://example.com/720.m3u8"]);
    expect(urlsOf(directDescriptor({ source: { kind: "direct-url", url: "https://a.test/go", finalUrl: "https://cdn.test/a.mp4#x", headers: {} } })))
      .toEqual(["https://a.test/go", "https://cdn.test/a.mp4"]);
  });

  it("indexes a long stream in constant work per address, and only a sample of its segments", () => {
    const store = createTabMediaStore();
    const base = hlsDescriptor().variants[0]!;
    const track = (name: string) => ({ ...base, id: `${name}` as typeof base.id, segmentRef: { kind: "hls-segments" as const,
      playlistUrl: `https://cdn.test/${name}.m3u8`, initSegmentUrl: `https://cdn.test/${name}/init.mp4`,
      segmentUrls: Array.from({ length: 20_000 }, (_, index) => `https://cdn.test/${name}/seg${index}.m4s`), encryption: null } });
    const long = hlsDescriptor({ id: "long" as StreamId, variants: [track("a"), track("b"), track("c")] });
    const small = hlsDescriptor({ id: "small" as StreamId, source: { kind: "hls-manifest", manifestUrl: "https://cdn.test/small.m3u8", type: "media" }, variants: [] });
    store.indexOwners(1, small);
    const started = performance.now();
    store.indexOwners(1, long);
    // 60,000 segment addresses: the old insert listed every key each time and took seconds.
    expect(performance.now() - started).toBeLessThan(500);
    const owners = store.tab(1).owners;
    expect(Object.keys(owners).length).toBeLessThanOrEqual(1100);
    // The stream's own addresses and its init sections are all there, and the tab's other stream was not pushed out.
    expect(owners["https://cdn.test/a.m3u8"]).toBe("https://example.com/master.m3u8");
    expect(owners["https://cdn.test/c/init.mp4"]).toBe("https://example.com/master.m3u8");
    expect(owners["https://cdn.test/small.m3u8"]).toBe("https://cdn.test/small.m3u8");
    // The sample is even: the page's requests keep reaching an indexed segment late in the stream.
    const late = Object.keys(owners).filter(key => /\/c\/seg1[5-9]\d{3}\.m4s$/.test(key));
    expect(late.length).toBeGreaterThan(20);
    expect(store.touch(1, late[0]!, 0, 0)).toBe(true);
  });

  it("drops the oldest entries above a limit, and a refreshed key counts as new", () => {
    const record: Record<string, number> = {};
    for (let index = 0; index < 5; index++) put(record, `k${index}`, index, 3);
    expect(Object.keys(record)).toEqual(["k2", "k3", "k4"]);
    put(record, "k2", 20, 3);
    put(record, "k5", 5, 3);
    expect(record).toEqual({ k2: 20, k4: 4, k5: 5 });
    // A record read back from storage keeps working: its own key order is its age.
    const stored: Record<string, number> = { a: 1, b: 2, c: 3 };
    put(stored, "d", 4, 3);
    expect(Object.keys(stored)).toEqual(["b", "c", "d"]);
    // Many refreshes of few keys do not grow anything.
    for (let index = 0; index < 10_000; index++) put(record, `k${index % 2}`, index, 3);
    expect(Object.keys(record).length).toBe(3);
  });

  it("a frame's ad mark cannot hide what another frame already loaded", () => {
    const store = createTabMediaStore();
    Object.assign(store.tab(1).frames, { 0: { documentId: "top", url: "https://news.test/", generation: 0, parent: -1 },
      4: { documentId: "ad", url: "https://ads.test/frame", generation: 0, parent: 0 },
      9: { documentId: "inner", url: "https://ads.test/inner", generation: 0, parent: 4 } });
    // The top page plays its story; the browser received it in frame 0.
    store.noteReceived(1, "https://cdn.news.test/story.mp4", "93.184.216.34", 0);
    expect(store.markAds(1, ["https://cdn.news.test/story.mp4"], "vast", 4)).toEqual([]);
    expect(store.isAd(1, "https://cdn.news.test/story.mp4")).toBe(false);
    // The same frame speaks for its own media and for the frames inside it, also after they loaded.
    store.noteReceived(1, "https://ads.test/own.mp4", null, 4);
    store.noteReceived(1, "https://ads.test/inner.mp4", null, 9);
    expect(store.markAds(1, ["https://ads.test/own.mp4", "https://ads.test/inner.mp4"], "vast", 4)).toHaveLength(2);
    // The top page may mark anything in its tab.
    expect(store.markAds(1, ["https://cdn.news.test/story.mp4"], "vast", 0)).toHaveLength(1);
    // An ad schedule comes before its media: a mark for an address nobody loaded yet holds, whoever plays it later.
    expect(store.markAds(1, ["https://ads.test/creative.mp4"], "vast", 9)).toEqual(["https://ads.test/creative.mp4"]);
    store.noteReceived(1, "https://ads.test/creative.mp4", null, 0);
    expect(store.isAd(1, "https://ads.test/creative.mp4")).toBe(true);
    // A file the top page's script fetched whole and plays from memory is the top page's, just as a received one.
    store.noteFetched(1, "https://cdn.news.test/main.mp4", 0, "top", "93.184.216.34");
    expect(store.markAds(1, ["https://cdn.news.test/main.mp4"], "vast", 4)).toEqual([]);
    expect(store.isAd(1, "https://cdn.news.test/main.mp4")).toBe(false);
  });

  it("keeps what a document's scripts fetched whole until it is checked, per document, and gives it back with the document", () => {
    const changes: string[] = [];
    const store = createTabMediaStore(Date.now, (_tabId, part) => changes.push(part));
    store.tab(1).topDocument = "doc-a";
    store.noteFetched(1, "https://cdn.test/v/clip.mp4#t=2", 0, "doc-a", "93.184.216.34");
    store.noteFetched(1, "https://cdn.test/v/part.mp4", 3, "doc-3");
    expect(store.tab(1).fetched).toEqual({ "https://cdn.test/v/clip.mp4": { frameId: 0, documentId: "doc-a", ip: "93.184.216.34" },
      "https://cdn.test/v/part.mp4": { frameId: 3, documentId: "doc-3", ip: null } });
    // The server that answered is in the note, and the answer is not added to what the tab received.
    expect(store.fetched(1, "https://cdn.test/v/clip.mp4#again")?.ip).toBe("93.184.216.34");
    expect(store.fetched(1, "https://cdn.test/v/never.mp4")).toBeNull();
    expect(store.tab(1).received).toEqual({});
    expect(changes).toEqual(["received", "received"]);
    // The same answer again changes nothing that is stored.
    store.noteFetched(1, "https://cdn.test/v/clip.mp4", 0, "doc-a", "93.184.216.34");
    expect(changes).toHaveLength(2);
    // A part of a stream is let go once it was looked at, and an address that was never noted is no change.
    store.forgetFetched(1, "https://cdn.test/v/part.mp4");
    store.forgetFetched(1, "https://cdn.test/v/never.mp4");
    expect(Object.keys(store.tab(1).fetched)).toEqual(["https://cdn.test/v/clip.mp4"]);
    expect(changes).toHaveLength(3);
    // Another page, and back to the same document: the browser repeats no request, and the note is the document's.
    store.leaveTopDocument(1);
    store.tab(1).topDocument = "doc-b";
    store.reset(1);
    expect(store.tab(1).fetched).toEqual({});
    store.leaveTopDocument(1);
    store.tab(1).topDocument = "doc-a";
    store.reset(1);
    expect(store.tab(1).fetched).toEqual({ "https://cdn.test/v/clip.mp4": { frameId: 0, documentId: "doc-a", ip: "93.184.216.34" } });
    // A worker that starts again reads it back with what the browser received.
    const again = createTabMediaStore();
    again.importTab(1, { received: { received: {}, earlier: [], fetched: store.tab(1).fetched } });
    expect(again.tab(1).fetched).toEqual(store.tab(1).fetched);
    again.importTab(2, { received: { received: {}, earlier: [] } });
    expect(again.tab(2).fetched).toEqual({});
    // A page cannot grow the record without end: the oldest notes go first, and a note that was let go is not counted.
    for (let index = 0; index < 200; index++) store.noteFetched(1, `https://cdn.test/v/${index}.mp4`, 0, "doc-a");
    expect(Object.keys(store.tab(1).fetched)).toHaveLength(64);
    expect(store.tab(1).fetched["https://cdn.test/v/199.mp4"]).toBeDefined();
    expect(store.tab(1).fetched["https://cdn.test/v/clip.mp4"]).toBeUndefined();
  });

  it("stores a tab's first fetched notes and keeps the notes of a player fed piece by piece in memory: no stored change per piece", () => {
    const changes: string[] = [];
    const store = createTabMediaStore(Date.now, (_tabId, part) => changes.push(part));
    // One hour of two-second pieces, each a video answer a script fetched.
    for (let piece = 0; piece < 1800; piece++) store.noteFetched(1, `https://cdn.test/v/seg-${piece}.mp4?token=${piece}`, 0, "doc-a", "93.184.216.34");
    // As many notes as one look asks about were stored; the others are in memory, newest last, within the limit.
    expect(changes).toEqual(Array.from({ length: 8 }, () => "received"));
    expect(Object.keys(store.tab(1).fetched)).toHaveLength(64);
    expect(store.fetched(1, "https://cdn.test/v/seg-1799.mp4?token=1799")).toEqual({ frameId: 0, documentId: "doc-a", ip: "93.184.216.34" });
    expect(store.tab(1).received).toEqual({});
    // A note the user's look let go is a stored change, and so is a first note in the room it leaves.
    for (const url of Object.keys(store.tab(1).fetched).slice(0, 57)) store.forgetFetched(1, url);
    expect(changes).toHaveLength(8 + 57);
    store.noteFetched(1, "https://cdn.test/v/file.mp4", 0, "doc-a", null);
    expect(changes).toHaveLength(8 + 57 + 1);
  });

  it("gives a document restored from the back-forward cache back what the browser received for it", () => {
    const store = createTabMediaStore();
    store.tab(1).topDocument = "doc-a";
    store.noteReceived(1, "https://cdn.test/a.m3u8", "93.184.216.34", 0);
    store.noteReceived(1, "http://192.168.1.10/movie.mp4", "192.168.1.10", 0);
    store.noteLocalOrigin(1, "http://192.168.1.10/movie.mp4");
    // The tab goes to another page: the frame tracker lets the store know before it names the new document.
    store.leaveTopDocument(1);
    store.tab(1).topDocument = "doc-b";
    store.reset(1);
    expect(store.received(1, "https://cdn.test/a.m3u8")).toBeNull();
    expect(store.localOrigin(1, "http://192.168.1.10/movie.mp4")).toBe(false);
    store.noteReceived(1, "https://cdn.test/b.m3u8", null, 0);
    // Back: the same document again, and the browser repeats no request.
    store.leaveTopDocument(1);
    store.tab(1).topDocument = "doc-a";
    store.reset(1);
    expect(store.received(1, "https://cdn.test/a.m3u8")).toEqual({ ip: "93.184.216.34", frameId: 0 });
    expect(store.received(1, "https://cdn.test/b.m3u8")).toBeNull();
    // The local server it was answered from is the same document's too.
    expect(store.localOrigin(1, "http://192.168.1.10/movie.mp4")).toBe(true);
    // A new load of the same address is a new document: nothing is carried over.
    store.leaveTopDocument(1);
    store.tab(1).topDocument = "doc-a2";
    store.reset(1);
    expect(store.received(1, "https://cdn.test/a.m3u8")).toBeNull();
    expect(store.localOrigin(1, "http://192.168.1.10/movie.mp4")).toBe(false);
  });

  it("keeps the local origins of a document that received no media, so the page restored from the back-forward cache is still known as reached there", () => {
    const store = createTabMediaStore();
    store.tab(1).topDocument = "doc-a";
    // Only the page's own origin was noted: the browser was answered for the document from inside the network.
    store.noteLocalOrigin(1, "https://wiki.corp.example/training.html");
    store.leaveTopDocument(1);
    store.tab(1).topDocument = "doc-b";
    store.reset(1);
    expect(store.localOrigin(1, "https://wiki.corp.example/x")).toBe(false);
    store.leaveTopDocument(1);
    store.tab(1).topDocument = "doc-a";
    store.reset(1);
    expect(store.localOrigin(1, "https://wiki.corp.example/files/training.webm")).toBe(true);
  });

  it("says when its stored parts change: activity only when a selection could answer differently, facts whenever they are collected", () => {
    let now = 100;
    const changes: string[] = [];
    const store = createTabMediaStore(() => now, (_tabId, part) => { changes.push(part); });
    const stream = (name: string) => hlsDescriptor({ id: name as StreamId, source: { kind: "hls-manifest", manifestUrl: `https://cdn.test/${name}.m3u8`, type: "media" },
      variants: [{ ...hlsDescriptor().variants[0]!, segmentRef: { kind: "hls-segments", playlistUrl: `https://cdn.test/${name}.m3u8`, initSegmentUrl: null,
        segmentUrls: [`https://cdn.test/${name}/1.ts`, `https://cdn.test/${name}/2.ts`], encryption: null } }] });
    store.indexOwners(1, stream("a"));
    store.indexOwners(1, stream("b"));
    changes.length = 0;
    const activity = () => changes.filter(part => part === "activity").length;
    store.touch(1, "https://cdn.test/a/1.ts", 0, 0);
    expect(activity()).toBe(1);
    // The player goes on requesting the same stream on the same route: nothing a selection reads changes.
    now = 200;
    store.touch(1, "https://cdn.test/a/2.ts", 0, 0);
    expect(activity()).toBe(1);
    expect(store.tab(1).activity["https://cdn.test/a.m3u8"]).toEqual({ at: 200, frameId: 0, generation: 0 });
    // Another stream becomes the latest, the first one again, and then the route changes.
    store.touch(1, "https://cdn.test/b/1.ts", 0, 0);
    store.touch(1, "https://cdn.test/a/1.ts", 0, 0);
    store.touch(1, "https://cdn.test/a/2.ts", 0, 1);
    expect(activity()).toBe(4);
    store.setFacts(1, { reachable: true, frames: [] });
    expect(changes.at(-1)).toBe("facts");
  });

  it("gives a restarted worker the activity and the facts the worker before it had, and a new document neither", () => {
    const store = createTabMediaStore();
    const activity = { "https://cdn.test/a.m3u8": { at: 5, frameId: 0, generation: 2 } };
    const facts = { reachable: true, frames: [] };
    store.importTab(1, { activity, facts });
    expect(store.tab(1).activity).toEqual(activity);
    expect(store.tab(1).facts).toEqual(facts);
    store.reset(1);
    expect(store.tab(1).activity).toEqual({});
    expect(store.tab(1).facts).toBeNull();
  });

  it("gives a restarted worker the mark of a failed navigation, and a new document clears it", () => {
    const store = createTabMediaStore();
    const stored = { topDocument: "doc-e", frames: {}, ads: {}, assetLists: [], timelines: {}, elementDrm: {} };
    store.importTab(1, { media: { ...stored, loadFailed: true } });
    expect(store.tab(1).loadFailed).toBe(true);
    // A record written without the mark reads as a page that loaded.
    store.importTab(2, { media: stored });
    expect(store.tab(2).loadFailed).toBe(false);
    store.reset(1);
    expect(store.tab(1).loadFailed).toBe(false);
  });

  it("keeps the Referer page of the first check that found an address, whoever names the address later", () => {
    const store = createTabMediaStore();
    const seen = (frameId: number, referrer?: string) => ({ frameId, documentId: "doc", generation: 0, via: ["network-media" as const], scope: null,
      ...(referrer ? { referrer } : {}) });
    store.recordOrigin(1, "https://cdn.test/clip.mp4", seen(4, "https://player.vendor.test"));
    store.recordOrigin(1, "https://cdn.test/clip.mp4", seen(9, "https://ads.test"));
    store.recordOrigin(1, "https://cdn.test/clip.mp4", seen(0));
    expect(store.originOf(1, ["https://cdn.test/clip.mp4"])).toMatchObject({ frameId: 0, referrer: "https://player.vendor.test" });
  });
});
