// @vitest-environment-options {"url":"https://player.example/watch/1"}
import { emptyTabMediaState } from "../../../src/util/tab-media-state";
import { engineStub } from "../helpers/engine";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { collectFrameFacts } from "../../../src/content/frame-facts";
import { elementKeys } from "../../../src/content/media-tree";
import { createCaptureHandler } from "../../../src/background/capture";
import { createRouter } from "../../../src/background/router";
import { scanTab } from "../../../src/background/download-best";
import { createTabMediaStore, urlsOf } from "../../../src/background/tab-media";
import { select, selectionView } from "../../../src/selection/main-video";
import { MAIN_BRIDGE_TAG, type PopupToBackgroundMessage } from "../../../src/types/messages";
import type { TabFacts } from "../../../src/types/page-facts";
import { App } from "../../../src/popup/App";
import { directDescriptor } from "./helpers/descriptors";
import type { StreamId } from "@savemedia/core";

describe("progressive quality discovery to download", () => {
  it("groups verified alternatives, excludes a denied quality and downloads the selected URL", async () => {
    const pageUrl = "https://player.example/watch/1";
    // The page declares its player's renditions as data. The key names are the page's own: nothing reads them.
    document.body.innerHTML = `<script type="application/json">{"quellen":[
      {"datei":"https://cdn.example/clip_480p.mp4?token=low","label":"480p"},
      {"datei":"https://cdn.example/clip_720p.mp4?token=high","label":"720p"},
      {"datei":"https://cdn.example/clip_1080p.mp4?token=denied","label":"1080p"}
    ]}</script>`;
    for (let n = 0; n < 20; n++) {
      const url = `https://cdn.example/recommendation-${n}.mp4`;
      document.body.insertAdjacentHTML("beforeend", `<a href="${url}" data-preview="${url}">Recommended</a><video hidden preload="none" src="${url}"></video>`);
    }
    const downloads = { download: vi.fn(async () => 1) };
    const { sent: sendToEngine, engine } = engineStub();
    const router = createRouter({ downloads, engine });
    const save = async (msg: PopupToBackgroundMessage) => { if (msg.type === "download") await router.startDownload(msg.streamId, msg.choice); };
    const store = createTabMediaStore();
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50, 0, 0, 0, 0]);
    const fetched: string[] = [];
    const capture = createCaptureHandler({
      onDescriptor: (tabId, descriptor, origin) => {
        if (origin) store.recordOrigin(tabId, urlsOf(descriptor)[0]!, origin);
        router.addDescriptor(tabId, descriptor);
      },
      onFailure: (tabId, failure, origin) => {
        if (origin) store.recordOrigin(tabId, failure.url, origin);
        router.setDiscoveryFailure(tabId, failure);
      },
      fetchFn: async url => { fetched.push(url); return {
        status: url.includes("denied") ? 403 : 200,
        headers: { forEach: cb => cb("video/mp4", "content-type") },
        text: async () => "",
        clone: () => ({ arrayBuffer: async () => bytes.buffer }),
      }; },
    });
    const frame = collectFrameFacts(document, { pointer: false, thumbnails: false, pointerRecord: null, keyOf: elementKeys(), keyed: new WeakMap(), fileSaveProblem: null });
    const facts: TabFacts = { reachable: true, frames: [{ ...frame, frameId: 0, documentId: "doc-0" }] };
    const selectNow = (tabId: number, given: TabFacts, usePointer: boolean) => select({ descriptors: router.descriptors(tabId), failures: router.failures(tabId),
      media: store.tab(tabId), jobs: router.activeJobs(tabId), facts: given, usePointer });
    const scan = await scanTab({
      collect: async () => facts,
      select: selectNow,
      probe: (tabId, request, retryFailed) => capture(tabId, { type: "capture", payload: { [MAIN_BRIDGE_TAG]: true, kind: "media-source", url: request.url, pageUrl,
        ...(request.groupId ? { quality: { groupId: request.groupId, ...(request.height ? { height: request.height } : {}) } } : {}) } },
        { origin: { frameId: 0, documentId: "doc-0", via: [request.via === "fetched" ? "network-fetch" : request.via], scope: request.scope }, retryFailed }),
    }, 1, { pointer: false, thumbnails: false, retryFailed: false, list: true });

    // The three declared renditions were checked. No recommendation link and no hidden preview was requested.
    expect(fetched).toHaveLength(3);
    expect(fetched.every(url => url.includes("/clip_"))).toBe(true);
    expect(router.descriptors(1)).toHaveLength(2);
    expect(scan.selection).toMatchObject({ state: "ready", cards: [{ live: false }] });
    expect(scan.selection.candidates).toHaveLength(2);

    render(<App skipFetch initialDescriptors={router.descriptors(1)} initialSelection={selectionView(scan.selection)} />);
    const choice = screen.getByRole("combobox") as HTMLSelectElement;
    expect(Array.from(choice.options, option => option.text)).toEqual(["720p", "480p"]);
    fireEvent.click(screen.getByRole("button", { name: /^(⬇ )?save$/i }));
    const msg = vi.mocked(chrome.runtime.sendMessage).mock.calls.at(-1)![0] as unknown as PopupToBackgroundMessage;
    await save(msg);
    expect(sendToEngine).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "start-job", descriptor: expect.objectContaining({
        source: expect.objectContaining({ url: "https://cdn.example/clip_720p.mp4?token=high" }),
      }),
    }));
    expect(downloads.download).not.toHaveBeenCalled();

    fireEvent.change(choice, { target: { value: choice.options[1]!.value } });
    fireEvent.click(screen.getByRole("button", { name: /^(⬇ )?save$/i }));
    await save(vi.mocked(chrome.runtime.sendMessage).mock.calls.at(-1)![0] as unknown as PopupToBackgroundMessage);
    expect(sendToEngine).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "start-job", descriptor: expect.objectContaining({
        source: expect.objectContaining({ url: "https://cdn.example/clip_480p.mp4?token=low" }),
      }),
    }));
    expect(downloads.download).not.toHaveBeenCalled();
  });

  it("keeps unrelated player groups and ungrouped direct files separate cards", () => {
    const descriptors = [
      directDescriptor({ id: "a-low" as StreamId, mediaGroup: "player-a" }),
      directDescriptor({ id: "a-high" as StreamId, mediaGroup: "player-a" }),
      directDescriptor({ id: "b" as StreamId, mediaGroup: "player-b" }),
      directDescriptor({ id: "unrelated" as StreamId }),
    ];
    const selection = select({ descriptors, failures: [], jobs: new Set(), facts: null, usePointer: false,
      media: emptyTabMediaState() });
    expect(selection.cards.map(card => [...card.ids].sort())).toEqual([["a-high", "a-low"], ["b"], ["unrelated"]]);
  });
});
