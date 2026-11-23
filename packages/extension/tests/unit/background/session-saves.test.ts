import { beforeEach, describe, expect, it, vi } from "vitest";
import { restartWorker, storedSession } from "../../setup";
import { createSessionStore, type SessionArea } from "../../../src/background/state/session-store";
import { readStoredState } from "../../../src/background/state/records";
import type { ConfirmRequest } from "../../../src/background/state/records";

type Saves = typeof import("../../../src/background/session-saves");

const PAGE = "https://site.example/watch";
const IDENTITY = ["direct-url", "https://cdn.example/clip.mp4"];
const request: ConfirmRequest = { kind: "stream", streamId: "stream-1" as never, origin: "hotkey", file: null,
  choice: { outputMode: "Original", filename: "clip.mp4", variantId: null, audioRenditionId: null } };

/** A worker instance: the module loaded fresh, wired to the browser's session storage, with what is stored imported. */
async function worker(redispatch = vi.fn(async (_request: ConfirmRequest) => undefined)) {
  const chromeMock = restartWorker();
  Object.assign(chromeMock.tabs, { get: vi.fn(async () => ({ url: PAGE, active: false, windowId: 1 })) });
  vi.mocked(chromeMock.runtime.sendMessage).mockImplementation((() => Promise.resolve(false)) as never);
  const saves: Saves = await import("../../../src/background/session-saves");
  const store = createSessionStore(chromeMock.storage.session as unknown as SessionArea);
  const stored = readStoredState(await store.load());
  saves.configureSaves({ store, redispatch });
  saves.importSaves({ prompts: stored.prompts, activeReceipts: [] });
  return { saves, store, redispatch, chromeMock };
}

/** Waits until the question for the page is open, and returns it. */
function opened(saves: Saves) {
  return vi.waitFor(() => {
    const prompt = saves.repeatPrompt(1, PAGE);
    if (!prompt) throw new Error("no question is open yet");
    return prompt;
  });
}

describe("one save per file, and a question before a second copy", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("refuses a second reservation of a file that is being saved, and frees it when the save ends", async () => {
    const { saves } = await worker();
    const [first, second] = await Promise.all([saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4"), saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4")]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4")).toBeNull();
    await (first ?? second)!.finish(false);
    // The save failed: no receipt, so the next one starts without a question.
    const again = await saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4");
    expect(again).not.toBeNull();
    expect(saves.repeatPrompt(1, PAGE)).toBeNull();
  });

  it("keeps a receipt across a worker restart and asks before a second copy", async () => {
    const first = await worker();
    const permit = await first.saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4");
    await permit!.finish(true);
    expect(Object.keys(storedSession()).some(key => key.startsWith("sm1:saved:"))).toBe(true);

    const { saves } = await worker();
    const pending = saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4", { request });
    const prompt = await opened(saves);
    expect(prompt).toMatchObject({ filename: "clip.mp4", tabId: 1, pageUrl: PAGE });
    // While the question is open, the same file is not reserved twice.
    expect(await saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4")).toBeNull();
    expect(await saves.answerRepeat(prompt!.id, true)).toEqual({ ok: true });
    expect(await pending).not.toBeNull();
    expect(saves.repeatPrompt(1, PAGE)).toBeNull();
  });

  it("a declined repeat releases the reservation; an unknown answer says so", async () => {
    const first = await worker();
    await (await first.saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4"))!.finish(true);
    const pending = first.saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4");
    const prompt = await opened(first.saves);
    expect(await first.saves.answerRepeat("no-such-question", true)).toEqual({ ok: false });
    expect(await first.saves.answerRepeat(prompt.id, false)).toEqual({ ok: true });
    expect(await pending).toBeNull();
    // Declined, not stuck: the next Save asks again.
    const next = first.saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4");
    await opened(first.saves);
    first.saves.dismissRepeats(1);
    expect(await next).toBeNull();
  });

  it("no clock ends an open question: it stays until it is answered or the tab leaves the page", async () => {
    vi.useFakeTimers();
    try {
      const { saves } = await worker();
      await (await saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4"))!.finish(true);
      const pending = saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4");
      await opened(saves);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(saves.repeatPrompt(1, PAGE)).not.toBeNull();
      saves.dismissRepeats(2);
      expect(saves.repeatPrompt(1, PAGE)).not.toBeNull();
      saves.dismissRepeats(1);
      expect(await pending).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("keeps the question about an image across a worker restart, and starts that image again, not the page's video", async () => {
    const image = ["image", "https://site.example/img/card.png"];
    const asked: ConfirmRequest = { kind: "image", tabId: 1, pageUrl: PAGE, image: { url: image[1]!, pageUrl: PAGE, loaded: true } };
    const first = await worker();
    await (await first.saves.reserveSave(image, 1, PAGE, "card.png"))!.finish(true);
    void first.saves.reserveSave(image, 1, PAGE, "card.png", { request: asked });
    const id = (await opened(first.saves)).id;
    await first.store.durable();

    const second = await worker();
    expect(second.saves.repeatPrompt(1, PAGE)).toMatchObject({ id, filename: "card.png" });
    expect(await second.saves.answerRepeat(id, true)).toEqual({ ok: true });
    expect(second.redispatch.mock.calls).toEqual([[asked]]);
  });

  it("an answer that arrives after a worker restart starts the stored request again, once, without a second question", async () => {
    const first = await worker();
    await (await first.saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4"))!.finish(true);
    void first.saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4", { request });
    const id = (await opened(first.saves)).id;
    await first.store.durable();

    // The worker restarts while the question is open. Nothing waits for the answer any more.
    const reserved: unknown[] = [];
    const second = await worker(vi.fn(async again => {
      reserved.push(await second.saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4", { request: again }));
    }));
    expect(second.saves.repeatPrompt(1, PAGE)).toMatchObject({ id, filename: "clip.mp4" });
    expect(await second.saves.answerRepeat(id, true)).toEqual({ ok: true });
    expect(second.redispatch).toHaveBeenCalledExactlyOnceWith(request);
    expect(reserved).toHaveLength(1);
    expect(reserved[0]).not.toBeNull();
    expect(second.saves.repeatPrompt(1, PAGE)).toBeNull();
    await second.store.durable();
    expect(storedSession()["sm1:prompts"]).toEqual([]);
  });

  it("an open question is still the file's only question after a worker restart: the same Save shows it again, and one answer starts the save", async () => {
    const first = await worker();
    await (await first.saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4"))!.finish(true);
    void first.saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4", { request });
    const id = (await opened(first.saves)).id;
    await first.store.durable();

    const reserved: unknown[] = [];
    const second = await worker(vi.fn(async again => {
      reserved.push(await second.saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4", { request: again }));
    }));
    const shown = vi.mocked(second.chromeMock.runtime.sendMessage);
    shown.mockClear();
    // The user presses Save, or Alt+S, on the same file again.
    expect(await second.saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4", { request })).toBeNull();
    expect(await second.saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4", { request })).toBeNull();
    await second.store.durable();
    expect(storedSession()["sm1:prompts"]).toHaveLength(1);
    expect(second.saves.repeatPrompt(1, PAGE)).toMatchObject({ id });
    // The open question was put in front of the user again, each time.
    expect(shown.mock.calls.filter(call => (call[0] as { type?: string }).type === "repeat-save-changed")).toHaveLength(2);
    // One answer is enough, and the confirmed save is not refused as "already being saved".
    expect(await second.saves.answerRepeat(id, true)).toEqual({ ok: true });
    expect(reserved).toHaveLength(1);
    expect(reserved[0]).not.toBeNull();
    await second.store.durable();
    expect(storedSession()["sm1:prompts"]).toEqual([]);
  });

  it("a restored question that is declined, or whose tab leaves the page, frees the file for a later save", async () => {
    for (const end of ["declined", "navigated"] as const) {
      const first = await worker();
      const other = [...IDENTITY, end];
      await (await first.saves.reserveSave(other, 1, PAGE, "clip.mp4"))!.finish(true);
      void first.saves.reserveSave(other, 1, PAGE, "clip.mp4", { request });
      const id = (await opened(first.saves)).id;
      await first.store.durable();
      const second = await worker();
      if (end === "declined") expect(await second.saves.answerRepeat(id, false)).toEqual({ ok: true });
      else second.saves.dismissRepeats(1);
      expect(second.redispatch).not.toHaveBeenCalled();
      // The next Save asks its own question instead of being refused without a word.
      void second.saves.reserveSave(other, 1, PAGE, "clip.mp4", { request });
      expect((await opened(second.saves)).id).not.toBe(id);
      second.saves.dismissRepeats(1);
    }
  });

  it("tells the tab's observer once when a question is put, and shows an open question again instead of asking twice", async () => {
    const { saves, store, chromeMock } = await worker();
    const onQuestion = vi.fn();
    saves.configureSaves({ store, onQuestion });
    await (await saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4"))!.finish(true);
    const pending = saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4", { request });
    const prompt = await opened(saves);
    expect(onQuestion).toHaveBeenCalledExactlyOnceWith(1);
    const shown = vi.mocked(chromeMock.runtime.sendMessage);
    shown.mockClear();
    expect(await saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4", { request })).toBeNull();
    expect(onQuestion).toHaveBeenCalledOnce();
    expect(saves.repeatPrompt(1, PAGE)).toMatchObject({ id: prompt.id });
    expect(shown).toHaveBeenCalledWith({ type: "repeat-save-changed", tabId: 1, pageUrl: PAGE });
    expect(await saves.answerRepeat(prompt.id, true)).toEqual({ ok: true });
    expect(await pending).not.toBeNull();
  });

  it("asks nothing when the user already chose another copy in the popup: one confirmation, never two", async () => {
    const { saves } = await worker();
    await (await saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4"))!.finish(true);
    const again = await saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4", { request, allowRepeat: true });
    expect(again).not.toBeNull();
    expect(saves.repeatPrompt(1, PAGE)).toBeNull();
    await again!.finish(true);
    // Alt+S carries no such answer: it still asks.
    void saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4", { request });
    expect(await opened(saves)).toMatchObject({ filename: "clip.mp4" });
  });

  it("says in the page where the question waits when the popup cannot be opened, and again on each press while it is open", async () => {
    const { saves, store, chromeMock } = await worker();
    await (await saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4"))!.finish(true);
    const toTab = vi.fn();
    Object.assign(chromeMock.tabs, { sendMessage: toTab });
    void saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4", { request });
    await opened(saves);
    await vi.waitFor(() => expect(toTab).toHaveBeenCalled());
    expect(toTab.mock.calls[0]!.slice(0, 3)).toEqual([1, { type: "hotkey-feedback", outcome: "asked", detail: "Click the savemedia icon to save another copy." },
      { frameId: 0 }]);
    // The same press again shows the same words again, and asks nothing new.
    expect(await saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4", { request })).toBeNull();
    await vi.waitFor(() => expect(toTab).toHaveBeenCalledTimes(2));
    expect(toTab.mock.calls[1]![1]).toEqual(toTab.mock.calls[0]![1]);
    // Wired to the background, the toolbar button is told too.
    const onAsked = vi.fn();
    saves.configureSaves({ store, onAsked });
    expect(await saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4", { request })).toBeNull();
    await vi.waitFor(() => expect(onAsked).toHaveBeenCalledExactlyOnceWith(1));
    expect(toTab).toHaveBeenCalledTimes(2);
  });

  it("keeps a receipt in memory when the browser's storage refuses it: a finished file is never a failure", async () => {
    const { saves, chromeMock } = await worker();
    chromeMock.storage.session.set.mockRejectedValueOnce(new Error("quota"));
    const permit = await saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4");
    await expect(permit!.finish(true)).resolves.toBeUndefined();
    void saves.reserveSave(IDENTITY, 1, PAGE, "clip.mp4");
    expect(await opened(saves)).toMatchObject({ filename: "clip.mp4" });
  });

  it("knows a page's named file as saved, and a restored save's permit writes its receipt", async () => {
    const first = await worker();
    expect(await first.saves.savedThisSession(PAGE, "Clip 31.mov")).toBe(false);
    const permit = await first.saves.reserveSave(first.saves.namedFileIdentity(PAGE, "Clip 31.mov"), 1, PAGE, "Clip 31.mov");
    expect(permit!.resumeKey).not.toBe(permit!.receiptKey);
    await first.store.durable();

    const second = await worker();
    // The job record carried the permit's data across the restart.
    await second.saves.permitFrom({ receiptKey: permit!.receiptKey!, resumeKey: permit!.resumeKey ?? null }).finish(true);
    expect(await second.saves.savedThisSession(PAGE, "Clip 31.mov")).toBe(true);
    await second.store.durable();
    expect(await (await worker()).saves.savedThisSession(PAGE, "Clip 31.mov")).toBe(true);
  });
});
