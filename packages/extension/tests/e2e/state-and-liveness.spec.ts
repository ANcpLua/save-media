// What survives when the browser stops savemedia's service worker, when the
// engine document goes away, and when a tab was open before the extension
// was (re)loaded. Each test drives the real extension in headless Chromium
// against a loopback server that can hold a media response back.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchExtension, type ExtensionSession } from "./extension-browser";
import { collectWorkerErrors, extensionWorker, stopExtensionWorker } from "./extension-worker";
import { answerWithRange, downloadRequest, popupFor, tabIdOf as tabOf, toastLabel, type View } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));
const CLIP = readFileSync(join(here, "media-fixtures/direct/clip.mp4"));
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/**
 * /page.html plays /slow.mp4. The engine's part requests (they carry
 * If-Range) are held while the gate is closed; the page's own requests and
 * the first check always pass.
 */
function gatedServer() {
  let open = true;
  /** While set, /late.html drops the connection: the tab then shows the browser's own error page, which no extension can read. */
  let dropLate = false;
  const held: (() => void)[] = [];
  let aborted = 0;
  const serve = (req: IncomingMessage, res: ServerResponse): void => answerWithRange(req, res, CLIP);
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/late.html" && dropLate) { req.socket.destroy(); return; }
    if (path === "/page.html" || path === "/late.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>State fixture</title><video src="/slow.mp4" preload="metadata" controls width="640" height="360"></video>`);
      return;
    }
    if (path !== "/slow.mp4") { res.writeHead(404); res.end(); return; }
    if (open || req.headers["if-range"] === undefined) { serve(req, res); return; }
    let done = false;
    req.socket.once("close", () => { if (!done) aborted++; });
    held.push(() => { done = true; if (!res.destroyed) serve(req, res); });
  });
  return {
    server,
    close: (): void => { open = false; },
    release: (): void => { open = true; for (const go of held.splice(0)) go(); },
    held: (): number => held.length,
    aborted: (): number => aborted,
    dropLate: (value: boolean): void => { dropLate = value; },
    reset: (): void => { open = true; dropLate = false; held.length = 0; aborted = 0; },
  };
}

test.describe("state, engine liveness and unreachable pages", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "uses the Chromium extension runtime");

  const gate = gatedServer();
  let context: BrowserContext;
  let extensionId = "";
  let base = "";
  let session: ExtensionSession | undefined;
  let workerErrors: string[] = [];
  /** An extension page that stays open: it asks the background what a test needs to know. */
  let probe: Page;

  async function launch(): Promise<void> {
    session = await launchExtension({ name: "state", viewport: { width: 1280, height: 800 } });
    ({ context, extensionId } = session);
    workerErrors = collectWorkerErrors(context, () => extensionId);
    probe = await context.newPage();
    await probe.goto(session.popupUrl);
  }

  test.beforeAll(async ({ browserName }) => {
    if (browserName !== "chromium") return;
    await new Promise<void>(done => gate.server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(gate.server.address() as { port: number }).port}`;
    await launch();
  });

  test.beforeEach(async () => {
    gate.reset();
    // Each test starts without receipts of earlier saves: the fixture's one file would otherwise be "already saved".
    await probe.evaluate(async () => {
      await chrome.downloads.erase({});
      await chrome.storage.session.remove(Object.keys(await chrome.storage.session.get(null)).filter(key => key.startsWith("sm1:saved:")));
    });
  });

  test.afterEach(async () => {
    gate.release();
    for (const page of context.pages()) if (page !== probe) await page.close().catch(() => undefined);
    expect(workerErrors.splice(0), "errors the extension logged in its service worker").toEqual([]);
  });

  test.afterAll(async () => {
    await session?.close();
    await new Promise<void>(done => gate.server.close(() => done()));
  });

  const tabIdOf = (url: string): Promise<number> => tabOf(probe, url);
  const ask = <T,>(message: object): Promise<T> => probe.evaluate(msg => chrome.runtime.sendMessage(msg), message) as Promise<T>;
  const completed = () => probe.evaluate(async () => (await chrome.downloads.search({})).filter(item => item.state === "complete").map(item => item.filename));
  const allDownloads = () => probe.evaluate(async () => (await chrome.downloads.search({})).length);

  /** A page of the fixture with its one video listed, and the id the background gave that video. */
  async function openPage(path = "/page.html"): Promise<{ page: Page; tabId: number; url: string; id: string }> {
    const page = await context.newPage();
    const url = `${base}${path}?run=${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await page.goto(url);
    await page.bringToFront();
    const tabId = await tabIdOf(url);
    let view!: View;
    await expect.poll(async () => { view = await ask<View>({ type: "rescan", tabId }); return view.descriptors.length; }, { message: "the page's video should be listed" }).toBe(1);
    return { page, tabId, url, id: view.descriptors[0]!.id };
  }

  /** The popup's request to save a listed video, under the fixture file's name. */
  const save = (id: string) => downloadRequest(id, "clip.mp4");
  const statusOf = async (tabId: number, id: string) => (await ask<View>({ type: "list", tabId })).statuses?.[id];
  const stopWorker = () => stopExtensionWorker(context, extensionId, probe);
  const defaultTitle = (tabId: number) => extensionWorker(context, extensionId).then(worker => worker.evaluate(id => chrome.action.getTitle({ tabId: id }), tabId));

  test("the list and Save survive a worker restart: same ids, one file, nothing listed twice", async () => {
    const { tabId, id } = await openPage();
    const before = (await ask<View>({ type: "list", tabId })).descriptors.map(item => item.id);
    expect(id).toMatch(/^stream-[0-9a-f]{16}$/);

    await stopWorker();
    // The popup's next request starts a new worker, which reads the list back.
    const after = (await ask<View>({ type: "list", tabId })).descriptors.map(item => item.id);
    expect(after).toEqual(before);

    expect(await ask(save(id))).toEqual({ type: "download-result", outcome: "started" });
    await expect.poll(completed).toHaveLength(1);
    expect(sha256(readFileSync((await completed())[0]!))).toBe(sha256(CLIP));
    await expect.poll(async () => (await statusOf(tabId, id))?.phase).toBe("complete");

    for (let look = 0; look < 3; look++) expect((await ask<View>({ type: "rescan", tabId })).descriptors.map(item => item.id)).toEqual(before);
    expect(await allDownloads()).toBe(1);
    // A row the background no longer knows is answered as expired, not started and not failed.
    expect(await ask(save("stream-0000000000000000"))).toEqual({ type: "download-result", outcome: "listing-expired" });
  });

  test("a running save survives a worker restart: one file, the right bytes, the toolbar button back to its default", async () => {
    const { tabId, id } = await openPage();
    gate.close();
    expect(await ask(save(id))).toMatchObject({ outcome: "started" });
    await expect.poll(gate.held, { message: "the engine should be waiting for the file's bytes" }).toBeGreaterThan(0);
    expect(await defaultTitle(tabId)).not.toBe("savemedia");

    await stopWorker();
    gate.release();
    await expect.poll(completed, { timeout: 20_000 }).toHaveLength(1);
    expect(sha256(readFileSync((await completed())[0]!))).toBe(sha256(CLIP));
    await expect.poll(async () => (await statusOf(tabId, id))?.phase).toBe("complete");
    await expect.poll(() => defaultTitle(tabId)).toBe("savemedia");
    expect(await allDownloads()).toBe(1);
    // With nothing left to do, the engine document is closed again.
    await expect.poll(async () => (await extensionWorker(context, extensionId)).evaluate(async () =>
      (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType] })).length)).toBe(0);
  });

  test("Alt+S, then a worker restart: the page still gets its Saved toast", async () => {
    const { page } = await openPage();
    gate.close();
    await page.mouse.move(320, 180);
    await page.keyboard.press("Alt+KeyS");
    await expect.poll(gate.held).toBeGreaterThan(0);
    await stopWorker();
    gate.release();
    await expect(toastLabel(page)).toHaveText("Saved", { timeout: 20_000 });
    await expect.poll(completed).toHaveLength(1);
  });

  test("Cancel after a worker restart stops the save: the request is dropped, nothing is written", async () => {
    const { tabId, id } = await openPage();
    gate.close();
    await ask(save(id));
    await expect.poll(gate.held).toBeGreaterThan(0);
    await stopWorker();
    expect(await ask({ type: "cancel", streamId: id })).toEqual({ ok: true });
    // The user's own cancel is a neutral end: the save is cancelled, with no error.
    await expect.poll(async () => (await statusOf(tabId, id))?.phase, { timeout: 20_000 }).toBe("cancelled");
    expect((await statusOf(tabId, id))?.error).toBeUndefined();
    await expect.poll(gate.aborted).toBeGreaterThan(0);
    gate.release();
    expect(await allDownloads()).toBe(0);
    await expect.poll(() => defaultTitle(tabId)).toBe("savemedia");
  });

  test("an engine document that goes away fails its save in plain words, and saving again works", async () => {
    const { tabId, url, id } = await openPage();
    const popup = await popupFor(session!, tabId);
    gate.close();
    await ask(save(id));
    await expect.poll(gate.held).toBeGreaterThan(0);

    // Closed from outside the engine channel, as a crash or memory pressure would.
    await (await extensionWorker(context, extensionId)).evaluate(() => chrome.offscreen.closeDocument());

    await expect.poll(async () => (await statusOf(tabId, id))?.error).toMatchObject({ code: "engine_stopped", when: "running" });
    await expect(popup.getByTestId("job-error").getByTestId("failure-title")).toHaveText("The save stopped before it finished");
    await expect(popup.getByTestId("job-error").getByText("engine_stopped", { exact: true })).toBeHidden();
    // It happened while the popup was open: a screen reader is told once, as an alert, in the same plain words.
    await expect(popup.getByRole("alert")).toHaveText(
      "The save stopped before it finished. Your browser closed the part of savemedia that was saving the file. Save it again.");
    await expect(popup.getByRole("button", { name: "Retry save" })).toBeVisible();
    await expect.poll(() => defaultTitle(tabId)).toBe("savemedia");
    expect(await allDownloads()).toBe(0);

    // The reservation was released: the same file can be saved again, and is.
    gate.release();
    expect(await ask(save(id))).toMatchObject({ outcome: "started" });
    await expect.poll(completed, { timeout: 20_000 }).toHaveLength(1);
    expect(sha256(readFileSync((await completed())[0]!))).toBe(sha256(CLIP));
    expect(url).toContain("/page.html");
  });

  test("saving twice is one file and one question; looking again changes nothing (rule 11)", async () => {
    const { page, tabId, url, id } = await openPage();
    await page.mouse.move(320, 180);
    await page.keyboard.press("Alt+KeyS");
    await expect(toastLabel(page)).toHaveText("Saved", { timeout: 20_000 });
    await expect.poll(completed).toHaveLength(1);

    await page.keyboard.press("Alt+KeyS");
    // The second press asks before a second copy and saves nothing by itself.
    let question: { id: string; filename: string } | null = null;
    await expect.poll(async () => {
      question = (await ask<{ prompt: { id: string; filename: string } | null }>({ type: "current-save-state", tabId, pageUrl: url })).prompt;
      return question !== null;
    }, { message: "a repeat question should be open" }).toBe(true);
    expect(await allDownloads()).toBe(1);
    expect(await ask({ type: "answer-repeat-save", id: question!.id, allow: false })).toEqual({ ok: true });
    expect((await ask<{ prompt: unknown }>({ type: "current-save-state", tabId, pageUrl: url })).prompt).toBeNull();

    const listed = (await ask<View>({ type: "list", tabId })).descriptors.map(item => item.id);
    expect(listed).toEqual([id]);
    for (let look = 0; look < 3; look++) expect((await ask<View>({ type: "rescan", tabId, retryFailed: true })).descriptors.map(item => item.id)).toEqual(listed);
    expect(await allDownloads()).toBe(1);
  });

  // Whether a refusal is handed to the Local downloader is not checked here: the Local downloader is off in every
  // e2e profile, so a hand-over could not be seen. download-best.test.ts covers that rule.
  test("a page with only protected media still refuses after a worker restart", async () => {
    // The shared fixture server's page: a DASH manifest that declares Widevine.
    const url = `http://127.0.0.1:${process.env.SAVEMEDIA_FIXTURE_PORT ?? 5174}/page/widevine.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.bringToFront();
    const tabId = await tabIdOf(url);
    let view!: View;
    await expect.poll(async () => { view = await ask<View>({ type: "rescan", tabId }); return view.descriptors.length; }).toBe(1);
    expect(view.descriptors[0]!.drm).toMatchObject({ reason: "cdm_required" });

    await stopWorker();
    await page.mouse.move(200, 200);
    await page.keyboard.press("Alt+KeyS");
    await expect(toastLabel(page)).toHaveText("Not saved");
    const after = await ask<View>({ type: "list", tabId });
    expect(after.descriptors.map(item => [item.id, item.drm?.reason])).toEqual([[view.descriptors[0]!.id, "cdm_required"]]);
    expect(await allDownloads()).toBe(0);
  });

  test("a page's content script cannot ask what the popup asks", async () => {
    const { page, tabId, id } = await openPage();
    // The extension's own content script world in the page: what a compromised renderer controls.
    const session = await context.newCDPSession(page);
    const worlds: { id: number; origin: string; auxData?: { type?: string } }[] = [];
    session.on("Runtime.executionContextCreated", event => { worlds.push(event.context as never); });
    await session.send("Runtime.enable");
    const world = worlds.find(item => item.origin === `chrome-extension://${extensionId}` && item.auxData?.type === "isolated");
    expect(world, "the content script's world should be found").toBeDefined();
    const send = async (message: object): Promise<string> => {
      const result = await session.send("Runtime.evaluate", { contextId: world!.id, awaitPromise: true, returnByValue: true,
        expression: `chrome.runtime.sendMessage(${JSON.stringify(message)}).then(reply => JSON.stringify(reply === undefined ? null : reply), error => "error: " + error.message)` });
      return String(result.result.value);
    };
    // The same world can speak for its page: that is its job.
    expect(await send({ type: "frame-active", reason: "load", url: page.url() })).toMatch(/^\{"altS":(true|false)\}$/);
    // None of the popup's requests is answered or carried out.
    expect(await send({ type: "list", tabId })).toBe("null");
    expect(await send({ type: "rescan", tabId })).toBe("null");
    expect(await send(save(id))).toBe("null");
    expect(await send({ type: "cancel", streamId: id })).toBe("null");
    expect(await send({ type: "local-settings", patch: { enabled: true, fallbackOnHotkey: true } })).toBe("null");
    expect(await send({ type: "local-download", tabId, pageUrl: "https://evil.example/" })).toBe("null");
    expect(await send({ type: "export-save-diagnostics", tabId, pageUrl: page.url() })).toBe("null");
    // Nor does it reach the engine document.
    expect(await send({ type: "engine-connect" })).toBe("null");
    // The saved settings are out of its reach as well: it can neither switch the local downloader on nor read what is set.
    const storage = async (expression: string): Promise<string> => String((await session.send("Runtime.evaluate", { contextId: world!.id,
      awaitPromise: true, returnByValue: true, expression: `(async () => { try { return await (${expression}); } catch (error) { return "refused: " + error.message; } })()` })).result.value);
    expect(await storage(`chrome.storage.local.set({ localDownloader: { enabled: true, quality: "best", cookies: "auto", fallbackOnHotkey: true } }).then(() => "written")`))
      .toMatch(/^refused: /);
    expect(await storage(`chrome.storage.local.get(null).then(items => "read " + Object.keys(items).length)`)).toMatch(/^refused: /);
    await session.detach();
    expect(await statusOf(tabId, id)).toBeUndefined();
    expect(await allDownloads()).toBe(0);
    const local = await ask<{ settings: { enabled: boolean }; jobs: unknown[] }>({ type: "local-status" });
    expect(local.settings.enabled).toBe(false);
    expect(local.jobs).toEqual([]);
  });

  /** A new tab that shows the browser's own error page for an address of the fixture: its server drops the connection. */
  async function openFailingPage(): Promise<{ page: Page; tabId: number; url: string }> {
    gate.dropLate(true);
    const known = new Set(await probe.evaluate(async () => (await chrome.tabs.query({})).map(tab => tab.id)));
    const page = await context.newPage();
    const url = `${base}/late.html?run=${Date.now()}`;
    await page.goto(url).catch(() => undefined);
    let tabId = -1;
    await expect.poll(async () => {
      const tab = (await probe.evaluate(async () => (await chrome.tabs.query({})).map(item => ({ id: item.id, url: item.url, status: item.status }))))
        .find(item => item.id !== undefined && !known.has(item.id));
      tabId = tab?.id ?? -1;
      return tab ? `${tab.url} ${tab.status}` : "";
    }, { message: "the tab should have finished loading the address that fails" }).toBe(`${url} complete`);
    return { page, tabId, url };
  }

  test("a page that did not load says so with Reload page, also after a worker restart, and lists nothing of the page before it", async () => {
    // A page with a video, then a navigation in the same tab that fails: the tab shows the browser's error page.
    const { page, tabId } = await openPage();
    gate.dropLate(true);
    const failing = `${base}/late.html?run=${Date.now()}`;
    await page.goto(failing).catch(() => undefined);
    await expect.poll(async () => (await ask<View>({ type: "rescan", tabId })).reach, { message: "the failed navigation should be known" }).toBe("load-failed");
    // What the page before it had loaded is gone with it.
    expect((await ask<View>({ type: "list", tabId })).descriptors).toEqual([]);
    expect(await extensionWorker(context, extensionId).then(worker => worker.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tabId))).toBe("");

    await stopWorker();
    const popup = await popupFor(session!, tabId);
    const notice = popup.getByTestId("page-reach");
    await expect(notice).toContainText("This page did not load. Reload it, then try again.");
    await expect(notice).toContainText("Your browser shows its own error page in this tab.");
    await expect(popup.getByText("Your browser does not let extensions read this page.")).toHaveCount(0);
    await expect(popup.getByText("No media detected on this page.")).toHaveCount(0);

    // The address answers now. The button reloads the tab, and the popup looks again when the load ends.
    gate.dropLate(false);
    await notice.getByRole("button", { name: "Reload page" }).click();
    await expect(popup.getByTestId("page-reach")).toHaveCount(0, { timeout: 15_000 });
    await expect(popup.getByRole("button", { name: /save/i }).first()).toBeVisible();
    const after = await ask<View>({ type: "rescan", tabId });
    expect(after.reach).toBe("reachable");
    expect(after.descriptors).toHaveLength(1);
  });

  test("a tab whose page savemedia cannot read says to reload it, and Reload page brings its video", async () => {
    // A tab without a working content script that this worker never saw load: what a tab that was open
    // before an install or an update is. Here the tab shows the browser's own error page (no extension can
    // read that), and everything the worker stored about the tab is gone with a new worker, as after an update.
    const { tabId } = await openFailingPage();
    await probe.evaluate(id => chrome.storage.session.remove(["sm1:loaded", `sm1:media:${id}`]), tabId);
    await stopWorker();

    const popup = await popupFor(session!, tabId);
    await expect(popup.getByTestId("page-reach")).toContainText("Reload this page so savemedia can see it.");
    await expect(popup.getByText("No media detected on this page.")).toHaveCount(0);
    expect((await ask<View>({ type: "rescan", tabId })).reach).toBe("needs-reload");

    // The page can be loaded now. The button reloads the tab, and the popup looks again when the load ends.
    gate.dropLate(false);
    await popup.getByRole("button", { name: "Reload page" }).click();
    await expect(popup.getByTestId("page-reach")).toHaveCount(0, { timeout: 15_000 });
    await expect(popup.getByRole("button", { name: /save/i }).first()).toBeVisible();
    const after = await ask<View>({ type: "rescan", tabId });
    expect(after.reach).toBe("reachable");
    expect(after.descriptors).toHaveLength(1);

    // A page of the browser itself is named as such.
    const blank = await context.newPage();
    const blankId = await tabIdOf("about:blank");
    const other = await popupFor(session!, blankId);
    await expect(other.getByTestId("page-reach")).toContainText("savemedia checks web pages. This page belongs to the browser.");
    await blank.close();
  });

  // The browser tells a test only what the worker writes to its console. An error nothing caught there is
  // therefore logged like the worker's other errors (util/uncaught.ts), and every suite's check sees it.
  test("an error nothing caught in the service worker is logged with the extension's other errors", async () => {
    const worker = await extensionWorker(context, extensionId);
    await worker.evaluate(() => {
      setTimeout(() => { throw new Error("thrown in a listener"); }, 0);
      void Promise.reject(new RangeError("nobody handles this"));
    });
    await expect.poll(() => workerErrors.length).toBe(2);
    const logged = workerErrors.splice(0);
    for (const line of logged) expect(line).toMatch(/^\[savemedia:bg\] uncaught error/);
    // The session's own list, which every suite checks after each test, holds the same two.
    expect(session!.workerErrors.splice(0)).toHaveLength(2);
  });
});
