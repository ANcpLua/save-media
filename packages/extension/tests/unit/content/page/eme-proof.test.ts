import { describe, expect, it, vi } from "vitest";
import { EME_EVENT, installEmeProof } from "../../../../src/content/page/eme-proof";

/** A page's EME objects, enough to drive the wrappers the way a player does. */
function scope() {
  const calls: string[] = [];
  class MediaKeySession { generateRequest(_type: string, _data: unknown): Promise<void> { calls.push("generateRequest"); return Promise.resolve(); } }
  class MediaKeys { createSession(): MediaKeySession { calls.push("createSession"); return new MediaKeySession(); } }
  class MediaKeySystemAccess {
    constructor(readonly keySystem: string) {}
    createMediaKeys(): Promise<MediaKeys> { calls.push("createMediaKeys"); return Promise.resolve(new MediaKeys()); }
  }
  const setMediaKeys = vi.fn(function (this: HTMLMediaElement, _keys: unknown) { calls.push("setMediaKeys"); return Promise.resolve(); });
  const mediaElement = { prototype: { setMediaKeys } as unknown as object };
  const events: { target: EventTarget; detail: { via: string; keySystem: string | null } }[] = [];
  document.addEventListener(EME_EVENT, event => {
    events.push({ target: event.target!, detail: JSON.parse((event as CustomEvent<string>).detail) });
  });
  const given = { MediaKeySystemAccess, MediaKeys, MediaKeySession, HTMLMediaElement: mediaElement, document, CustomEvent };
  installEmeProof(given);
  const attach = (video: Element, keys: unknown) => (mediaElement.prototype as { setMediaKeys(keys: unknown): Promise<void> }).setMediaKeys.call(video, keys);
  return { MediaKeySystemAccess, calls, events, attach, setMediaKeys };
}

function video(): HTMLVideoElement {
  const element = document.createElement("video");
  document.body.append(element);
  return element;
}

describe("proof that a media element used a key", () => {
  it("asking what the browser could play, creating keys and attaching them report nothing", async () => {
    const { MediaKeySystemAccess, events, attach } = scope();
    const requestMediaKeySystemAccess = vi.fn(async (keySystem: string) => new MediaKeySystemAccess(keySystem));
    const access = await requestMediaKeySystemAccess("com.widevine.alpha");
    const keys = await access.createMediaKeys();
    await attach(video(), keys);
    await attach(video(), null);
    keys.createSession();
    expect(events).toEqual([]);
  });

  it("a licence request reports the element the keys are attached to, with the key system", async () => {
    const { MediaKeySystemAccess, events, attach } = scope();
    const element = video();
    const keys = await new MediaKeySystemAccess("org.w3.clearkey").createMediaKeys();
    await Promise.resolve();
    await attach(element, keys);
    await keys.createSession().generateRequest("keyids", new Uint8Array(1));
    expect(events).toEqual([{ target: element, detail: { via: "license-request", keySystem: "org.w3.clearkey" } }]);
  });

  it("a licence request made before the keys reach an element reports the document, then the element once attached", async () => {
    const { MediaKeySystemAccess, events, attach } = scope();
    const keys = await new MediaKeySystemAccess("com.widevine.alpha").createMediaKeys();
    await Promise.resolve();
    await keys.createSession().generateRequest("cenc", new Uint8Array(1));
    expect(events.map(event => event.target)).toEqual([document]);
    const element = video();
    await attach(element, keys);
    expect(events.at(-1)).toEqual({ target: element, detail: { via: "license-request", keySystem: "com.widevine.alpha" } });
  });

  it("returns what the page's own methods return, calls each once, and never throws into the page", async () => {
    const { MediaKeySystemAccess, calls, attach, setMediaKeys } = scope();
    const access = new MediaKeySystemAccess("org.w3.clearkey");
    const keys = await access.createMediaKeys();
    const session = keys.createSession();
    expect(session.constructor.name).toBe("MediaKeySession");
    await expect(session.generateRequest("keyids", new Uint8Array(1))).resolves.toBeUndefined();
    const element = video();
    await expect(attach(element, keys)).resolves.toBeUndefined();
    expect(setMediaKeys).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["createMediaKeys", "createSession", "generateRequest", "setMediaKeys"]);
    // A broken dispatch must not reach the page's call.
    const dispatch = vi.spyOn(document, "dispatchEvent").mockImplementation(() => { throw new Error("blocked"); });
    expect(() => keys.createSession().generateRequest("keyids", new Uint8Array(1))).not.toThrow();
    dispatch.mockRestore();
  });

  it("installs on a page without EME support without failing", () => {
    expect(() => installEmeProof({ document, CustomEvent })).not.toThrow();
  });
});
