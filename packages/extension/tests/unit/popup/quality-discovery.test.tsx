import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { discoverPageMedia } from "../../../src/content/discovery";
import { createCaptureHandler } from "../../../src/background/capture";
import { createRouter } from "../../../src/background/router";
import { discoverPageMediaForTab } from "../../../src/background/download-best";
import type { PopupToBackgroundMessage } from "../../../src/types/messages";
import { App } from "../../../src/popup/App";
import { rankDescriptors } from "../../../src/popup/preview-match";
import { directDescriptor } from "./helpers/descriptors";
import type { StreamId } from "@savemedia/core";

describe("progressive quality discovery to download", () => {
  it("groups verified alternatives, excludes a denied quality and downloads the selected URL", async () => {
    const doc = document.implementation.createHTMLDocument("fixture");
    doc.body.innerHTML = `<script type="application/json">{"sources":[
      {"file":"https://cdn.example/clip_480p.mp4/?token=low","label":"480p"},
      {"file":"https://cdn.example/clip_720p.mp4/?token=high","label":"720p"},
      {"file":"https://cdn.example/clip_1080p.mp4/?token=denied","label":"1080p"}
    ]}</script>`;
    const downloads = { download: vi.fn(async () => 1) };
    const router = createRouter({ downloads, runtime: { sendMessage: vi.fn() }, ensureEngineHost: vi.fn(async () => undefined) });
    const pageUrl = "https://player.example/watch/1";
    for (let n = 0; n < 20; n++) {
      const url = `https://cdn.example/recommendation-${n}.mp4`;
      doc.body.insertAdjacentHTML("beforeend", `<a href="${url}" data-preview="${url}">Recommended</a>`);
      router.addDescriptor(1, directDescriptor({ id: `preview-${n}` as StreamId, pageUrl, mediaGroup: `preview-${n}`,
        source: { kind: "direct-url", url, headers: {} } }));
    }
    expect(router.listDescriptors(1)).toHaveLength(20);
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50, 0, 0, 0, 0]);
    const fetched: string[] = [];
    const capture = createCaptureHandler({
      onDescriptor: (tabId, descriptor) => { router.addDescriptor(tabId, descriptor); },
      fetchFn: async url => { fetched.push(url); return {
        status: url.includes("denied") ? 403 : 200,
        headers: { forEach: cb => cb("video/mp4", "content-type") },
        text: async () => "",
        clone: () => ({ arrayBuffer: async () => bytes.buffer }),
      }; },
    });
    const media = discoverPageMedia(doc, pageUrl);
    await discoverPageMediaForTab({ router, handleCapture: capture,
      tabs: { query: async () => [], sendMessage: (_id, _msg, cb) => cb({ pageUrl, urls: media.map(item => item.url), media }) },
      runtime: { lastError: () => null, sendMessage: vi.fn() },
    }, 1, pageUrl);
    expect(fetched).toHaveLength(3);
    expect(fetched.every(url => url.includes("/clip_"))).toBe(true);
    expect(router.listDescriptors(1)).toHaveLength(2);
    render(<App skipFetch initialDescriptors={router.listDescriptors(1)} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(Array.from(select.options, option => option.text)).toEqual(["720p", "480p"]);
    fireEvent.click(screen.getByRole("button", { name: /^download$/i }));
    const msg = vi.mocked(chrome.runtime.sendMessage).mock.calls.at(-1)![0] as unknown as PopupToBackgroundMessage;
    await router.handlePopupMessage(msg);
    expect(downloads.download).toHaveBeenLastCalledWith(expect.objectContaining({ url: "https://cdn.example/clip_720p.mp4/?token=high" }));

    fireEvent.change(select, { target: { value: select.options[1]!.value } });
    fireEvent.click(screen.getByRole("button", { name: /^download$/i }));
    await router.handlePopupMessage(vi.mocked(chrome.runtime.sendMessage).mock.calls.at(-1)![0] as unknown as PopupToBackgroundMessage);
    expect(downloads.download).toHaveBeenLastCalledWith(expect.objectContaining({ url: "https://cdn.example/clip_480p.mp4/?token=low" }));
  });

  it("keeps unrelated player groups and ungrouped direct files separate", () => {
    const descriptors = [
      directDescriptor({ id: "a-low" as StreamId, mediaGroup: "player-a" }),
      directDescriptor({ id: "a-high" as StreamId, mediaGroup: "player-a" }),
      directDescriptor({ id: "b" as StreamId, mediaGroup: "player-b" }),
      directDescriptor({ id: "unrelated" as StreamId }),
    ];
    const groups = rankDescriptors(descriptors, null);
    expect(groups).toHaveLength(3);
    expect(groups[0]!.alternatives?.map(d => d.id)).toEqual(["a-high"]);
    expect(groups[1]!.alternatives).toBeUndefined();
    expect(groups[2]!.alternatives).toBeUndefined();
  });
});
