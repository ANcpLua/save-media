import { describe, expect, it, vi } from "vitest";
import { createImageSaver, type ImageSaveDeps } from "../../../src/background/image-save";
import type { BackgroundToEngineMessage, EngineEvent } from "../../../src/types/messages";

type Reply = (streamId: string) => EngineEvent;

/** An engine that answers every image job with the given reply. */
function saver(reply: Reply | null, overrides: Partial<ImageSaveDeps> = {}) {
  const sent: BackgroundToEngineMessage[] = [];
  const deps = {
    mirrorReferer: vi.fn(async () => undefined),
    download: vi.fn(async (_blobUrl: string, filename: string) => filename),
    release: vi.fn(),
    newId: () => "1",
    startEngine: vi.fn(async (msg: Extract<BackgroundToEngineMessage, { type: "start-image" }>) => {
      sent.push(msg);
      if (reply) queueMicrotask(() => { instance.handleEngineMessage(reply(msg.streamId)); });
    }),
    ...overrides,
  };
  const instance = createImageSaver(deps);
  return { instance, deps, sent };
}

const image = { url: "https://site.example/pointer/card.png", pageUrl: "https://site.example/page" };

describe("verified image save", () => {
  it("has the engine fetch the image once and saves the Blob it verified, under the name the engine built", async () => {
    const { instance, deps, sent } = saver(streamId => ({ type: "image-complete", streamId, blobUrl: "blob:chrome-extension://x/1", filename: "card.png" }));
    expect(await instance.save(image)).toEqual({ kind: "saved", filename: "card.png" });
    expect(sent).toEqual([{ type: "start-image", streamId: "image:1", url: image.url, pageUrl: image.pageUrl }]);
    expect(deps.mirrorReferer).toHaveBeenCalledWith(image.url, image.pageUrl);
    expect(deps.startEngine).toHaveBeenCalledTimes(1);
    // Only the Blob reaches the download manager: the image address is never handed to it.
    expect(deps.download).toHaveBeenCalledWith("blob:chrome-extension://x/1", "card.png");
    expect(deps.release).toHaveBeenCalledWith("blob:chrome-extension://x/1");
    expect(instance.busy()).toBe(false);
  });

  it.each(["page", "program", "data", "unknown"] as const)("never calls the download manager when the bytes are %s, not an image", async received => {
    const { instance, deps } = saver(streamId => ({ type: "image-refused", streamId, received }));
    expect(await instance.save(image)).toEqual({ kind: "refused", received });
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.release).not.toHaveBeenCalled();
  });

  it("reports the engine's failure, and a failed download, without a file", async () => {
    const error = { code: "http_error", severity: "terminal", phase: "direct", url: image.url, httpStatus: 500 } as const;
    const failed = saver(streamId => ({ type: "image-failed", streamId, error }));
    expect(await failed.instance.save(image)).toEqual({ kind: "failed", error });
    const interrupted = saver(streamId => ({ type: "image-complete", streamId, blobUrl: "blob:chrome-extension://x/2", filename: "card.png" }),
      { download: vi.fn(async () => { throw new Error("USER_CANCELED"); }) });
    expect(await interrupted.instance.save(image)).toEqual({ kind: "failed", error: null });
    expect(interrupted.deps.release).toHaveBeenCalledWith("blob:chrome-extension://x/2");
    const offline = saver(null, { startEngine: vi.fn(async () => { throw new Error("no engine"); }) });
    expect(await offline.instance.save(image)).toEqual({ kind: "failed", error: null });
  });

  it("verifies a data: image through the engine too, without a Referer rule", async () => {
    const { instance, deps, sent } = saver(streamId => ({ type: "image-complete", streamId, blobUrl: "blob:chrome-extension://x/3", filename: "image.png" }));
    expect(await instance.save({ url: "data:image/png;base64,iVBORw0KGgo=", pageUrl: image.pageUrl })).toEqual({ kind: "saved", filename: "image.png" });
    expect(sent[0]).toMatchObject({ type: "start-image", url: "data:image/png;base64,iVBORw0KGgo=" });
    expect(deps.mirrorReferer).not.toHaveBeenCalled();
  });

  it("does not ask the engine for an image that lives only in the page, or one inside the user's network from a public page", async () => {
    const { instance, deps, sent } = saver(null);
    expect(await instance.save({ url: "blob:https://site.example/1", pageUrl: image.pageUrl })).toEqual({ kind: "page-only" });
    expect(await instance.save({ url: "http://192.168.1.1/admin/logo.png", pageUrl: "https://evil.example/" })).toEqual({ kind: "local-network" });
    // A local server the browser was answered from in another origin's name does not open this one.
    expect(await instance.save({ url: "http://192.168.1.1/admin/logo.png", pageUrl: "https://evil.example/", localOrigins: ["http://192.168.1.10"] }))
      .toEqual({ kind: "local-network" });
    expect(sent).toEqual([]);
    expect(deps.startEngine).not.toHaveBeenCalled();
  });

  it("asks the engine for an image on a local server the browser itself was answered from in the tab, and hands it those origins", async () => {
    const { instance, sent } = saver(streamId => ({ type: "image-complete", streamId, blobUrl: "blob:chrome-extension://x/4", filename: "cam.jpg" }));
    expect(await instance.save({ url: "http://192.168.1.10/cam.jpg", pageUrl: "https://dash.example/home", localOrigins: ["http://192.168.1.10"] }))
      .toEqual({ kind: "saved", filename: "cam.jpg" });
    expect(sent[0]).toMatchObject({ type: "start-image", url: "http://192.168.1.10/cam.jpg", pageUrl: "https://dash.example/home",
      localOrigins: ["http://192.168.1.10"] });
  });

  // Image requests are not observed, so the picture the page shows is the browser's answer from that origin.
  it("asks the engine for an image at a local address that a public page shows, and for no other image of that page", async () => {
    const { instance, sent, deps } = saver(streamId => ({ type: "image-complete", streamId, blobUrl: "blob:chrome-extension://x/5", filename: "cam.jpg" }));
    const camera = { url: "http://192.168.1.10/cam.jpg", pageUrl: "https://status.example/" };
    expect(await instance.save({ ...camera, loaded: true })).toEqual({ kind: "saved", filename: "cam.jpg" });
    // The engine gets that one origin, so a redirect to another local server is still refused there.
    expect(sent).toEqual([{ type: "start-image", streamId: "image:1", ...camera, localOrigins: ["http://192.168.1.10"] }]);

    // A broken image, and one whose state is not known, opens nothing.
    expect(await instance.save({ ...camera, loaded: false })).toEqual({ kind: "local-network" });
    expect(await instance.save(camera)).toEqual({ kind: "local-network" });
    // The shown picture opens its own origin for its own save: nothing is remembered for the next image.
    expect(await instance.save({ url: "http://192.168.1.10/other.jpg", pageUrl: camera.pageUrl })).toEqual({ kind: "local-network" });
    expect(deps.startEngine).toHaveBeenCalledTimes(1);
  });

  it("adds a shown image's origin to those the browser was answered from, once", async () => {
    const { instance, sent } = saver(streamId => ({ type: "image-complete", streamId, blobUrl: "blob:chrome-extension://x/6", filename: "cam.jpg" }));
    await instance.save({ url: "http://192.168.1.10/cam.jpg", pageUrl: "https://status.example/", loaded: true, localOrigins: ["http://192.168.1.20"] });
    await instance.save({ url: "http://192.168.1.10/cam.jpg", pageUrl: "https://status.example/", loaded: true, localOrigins: ["http://192.168.1.10"] });
    expect(sent.map(message => (message as { localOrigins?: readonly string[] }).localOrigins)).toEqual([
      ["http://192.168.1.20", "http://192.168.1.10"], ["http://192.168.1.10"]]);
  });

  it("keeps the engine open while an image is being saved, and releases an answer nobody waits for", async () => {
    let answer!: () => void;
    const { instance, deps } = saver(null);
    const pending = instance.save(image);
    await vi.waitFor(() => expect(deps.startEngine).toHaveBeenCalled());
    expect(instance.busy()).toBe(true);
    answer = () => instance.handleEngineMessage({ type: "image-refused", streamId: "image:1", received: "page" });
    answer();
    await pending;
    expect(instance.busy()).toBe(false);
    expect(instance.handleEngineMessage({ type: "image-complete", streamId: "image:gone", blobUrl: "blob:chrome-extension://x/9", filename: "x.png" })).toBe(true);
    expect(deps.release).toHaveBeenCalledWith("blob:chrome-extension://x/9");
    expect(instance.handleEngineMessage({ type: "idle" })).toBe(false);
  });

  it("gives up the images of a tab that went on to another page: the engine is told to end them and the engine is free again", async () => {
    const cancel = vi.fn();
    let id = 0;
    const { instance, deps } = saver(null, { cancel, newId: () => String(++id) });
    const left = instance.save({ ...image, tabId: 7 });
    const other = instance.save({ ...image, tabId: 8 });
    await vi.waitFor(() => expect(deps.startEngine).toHaveBeenCalledTimes(2));
    instance.leftPage(7);
    expect(await left).toEqual({ kind: "left-page" });
    expect(cancel.mock.calls).toEqual([["image:1"]]);
    expect(instance.busy()).toBe(true);
    // The engine's late word about the image that was given up settles nothing and frees its Blob.
    expect(instance.handleEngineMessage({ type: "image-failed", streamId: "image:1", error: { code: "user_cancelled", severity: "terminal" } })).toBe(true);
    instance.handleEngineMessage({ type: "image-refused", streamId: "image:2", received: "page" });
    expect(await other).toEqual({ kind: "refused", received: "page" });
    expect(instance.busy()).toBe(false);
  });

  it("adds what the browser reported about the image request to a network failure", async () => {
    const error = { code: "network_unreachable", severity: "terminal", phase: "direct", url: "https://site.example", during: "request" } as const;
    const explained = { ...error, browserDiagnostic: { host: "site.example", code: "net::ERR_CERT_AUTHORITY_INVALID", ip: null, finalHost: null, redirect: null } };
    const explainNetwork = vi.fn(() => explained);
    const { instance } = saver(streamId => ({ type: "image-failed", streamId, error }), { explainNetwork, now: () => 1234 });
    expect(await instance.save({ ...image, tabId: 7 })).toEqual({ kind: "failed", error: explained });
    expect(explainNetwork).toHaveBeenCalledWith(error, { since: 1234, address: image.url, pageUrl: image.pageUrl, tabId: 7 });
  });

  it("fails an image the engine was fetching when the engine goes away, and one it could not be opened for", async () => {
    const { instance, deps } = saver(null);
    const pending = instance.save(image);
    await vi.waitFor(() => expect(deps.startEngine).toHaveBeenCalled());
    instance.engineLost();
    expect(await pending).toMatchObject({ kind: "failed", error: { code: "engine_stopped" } });
    expect(instance.busy()).toBe(false);

    const closed = saver(null, { startEngine: vi.fn(async () => { throw new Error("engine unavailable"); }) });
    expect(await closed.instance.save(image)).toEqual({ kind: "failed", error: null });
    expect(closed.instance.busy()).toBe(false);
  });
});
