// @vitest-environment node
//
// A save job may request an address and be answered from another one: a redirect. The rule for where a
// public page's job may be sent (runner.ts) holds for where its answers come from too. These tests run
// the real runner and the real jobs over a stubbed fetch whose answers carry the address a followed
// redirect leaves on them.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserChoice } from "@savemedia/core";
import { createEngineRunner } from "../../../src/engine/runner";
import { downloadJob } from "../../../src/engine/download";
import type { EngineToBackgroundMessage } from "../../../src/types/messages";
import { directDescriptor, hlsDescriptor } from "../popup/helpers/descriptors";

const PAGE = "https://news.example/story";
const segment = new Uint8Array(readFileSync(resolve(__dirname, "../../e2e/media-fixtures/transport/timed-id3.ts")));
const playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nhttps://cdn.example/seg1.ts\n#EXT-X-ENDLIST\n";
const choice: UserChoice = { outputMode: "Original", filename: "x.mp4", variantId: null, audioRenditionId: null };

let originalFetch: typeof fetch;
let originalCreateObjectURL: typeof URL.createObjectURL;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = vi.fn(() => "blob:saved");
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectURL;
});

/** An answer that came from `url`, as a followed redirect leaves it on the response. */
function answeredFrom(url: string, body: BodyInit, init: ResponseInit = {}): Response {
  return Object.defineProperty(new Response(body, init), "url", { value: url });
}

/** Serves each request by the first route whose key its address ends with; records what was requested. */
function serve(routes: Record<string, () => Response>): string[] {
  const requested: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    const route = Object.entries(routes).find(([suffix]) => url.endsWith(suffix));
    if (!route) throw new Error(`unexpected ${url}`);
    return route[1]();
  }) as unknown as typeof fetch;
  return requested;
}

async function run(descriptor = hlsDescriptor({ pageUrl: PAGE }), localOrigins?: readonly string[]): Promise<EngineToBackgroundMessage[]> {
  const sendMessage = vi.fn();
  const runner = createEngineRunner({ runtime: { sendMessage }, downloadJob });
  await runner.start(descriptor.id, descriptor, choice, undefined, localOrigins);
  return sendMessage.mock.calls.map(call => call[0] as EngineToBackgroundMessage);
}

const outcome = (messages: readonly EngineToBackgroundMessage[]) => messages.find(message => message.type === "failed" || message.type === "complete");

describe("a save job whose request a redirect leads into the user's network", () => {
  it("uses nothing of a segment answered from there, and saves nothing", async () => {
    const requested = serve({
      ".m3u8": () => new Response(playlist),
      "seg1.ts": () => answeredFrom("http://192.168.1.1/seg1.ts", segment as BodyInit),
    });
    const messages = await run();
    expect(outcome(messages)).toMatchObject({ type: "failed", error: { code: "private_network_target", severity: "terminal", host: "192.168.1.1" } });
    expect(messages.some(message => message.type === "complete")).toBe(false);
    // Asked once: the refusal is final, not a failure to retry.
    expect(requested).toEqual(["https://example.com/master.m3u8", "https://cdn.example/seg1.ts"]);
  });

  it("uses nothing of a playlist answered from there: no segment it names is requested", async () => {
    const requested = serve({ ".m3u8": () => answeredFrom("http://10.0.0.5/live/master.m3u8", playlist) });
    expect(outcome(await run())).toMatchObject({ type: "failed", error: { code: "private_network_target", host: "10.0.0.5" } });
    expect(requested).toEqual(["https://example.com/master.m3u8"]);
  });

  it("uses nothing of an AES-128 key answered from there", async () => {
    const keyed = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://keys.example/k\"\n#EXTINF:10.0,\nhttps://cdn.example/seg1.ts\n#EXT-X-ENDLIST\n";
    serve({
      ".m3u8": () => new Response(keyed),
      "seg1.ts": () => new Response(new Uint8Array(32) as BodyInit),
      "/k": () => answeredFrom("http://192.168.1.1/key.bin", new Uint8Array(16) as BodyInit),
    });
    expect(outcome(await run())).toMatchObject({ type: "failed", error: { code: "private_network_target", host: "192.168.1.1" } });
  });

  it("uses nothing of a direct file answered from there", async () => {
    const requested = serve({ "clip.mp4": () => answeredFrom("http://192.168.1.1/clip.mp4", new Uint8Array(4096) as BodyInit,
      { status: 206, headers: { "content-range": "bytes 0-4095/100000", "content-type": "video/mp4" } }) });
    const messages = await run(directDescriptor({ pageUrl: PAGE }));
    expect(outcome(messages)).toMatchObject({ type: "failed", error: { code: "private_network_target", host: "192.168.1.1" } });
    expect(requested).toHaveLength(1);
  });

  it("saves the stream when the browser itself was answered from that server for this tab", async () => {
    serve({
      ".m3u8": () => new Response(playlist),
      "seg1.ts": () => answeredFrom("http://192.168.1.1/seg1.ts", segment as BodyInit),
    });
    expect(outcome(await run(undefined, ["http://192.168.1.1"]))).toMatchObject({ type: "complete", filename: "x.mp4" });
  });

  it("saves the stream of a page that is inside the user's network itself", async () => {
    serve({
      ".m3u8": () => new Response(playlist),
      "seg1.ts": () => answeredFrom("http://192.168.1.1/seg1.ts", segment as BodyInit),
    });
    expect(outcome(await run(hlsDescriptor({ pageUrl: "http://192.168.1.20/library" })))).toMatchObject({ type: "complete" });
  });
});
