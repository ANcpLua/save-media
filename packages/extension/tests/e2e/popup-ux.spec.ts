// How the popup, the toolbar button and the Alt+S toast behave while things
// happen: a first look that takes a moment, a save that runs, is cancelled,
// fails or is repeated, and a toast over a fullscreen player. Each test
// drives the real extension in headless Chromium against a loopback server
// that can hold a response back.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchExtension, type ExtensionSession } from "./extension-browser";
import { collectWorkerErrors, extensionWorker } from "./extension-worker";
import { answerWithRange, beginRangeAnswer, popupFor as openPopup, tabIdOf as tabOf, toast, toastCard, toastDetail, toastLabel, type View } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));
const CLIP = readFileSync(join(here, "media-fixtures/direct/clip.mp4"));

/**
 * /page.html plays /slow.mp4, /delayed.html declares /delayed.mp4,
 * /refused.html plays /refused.mp4 and /fullscreen.html has a player that
 * can go fullscreen. While the gate is closed, the engine's part requests
 * for /slow.mp4 (they carry If-Range) get the first half of what they asked
 * for and then nothing; every request for /delayed.mp4 gets nothing at all.
 * /refused.mp4 passes its check and refuses the engine's part requests.
 * /stream.html plays the playlist /stream/media.m3u8, which answers until the
 * test lets it expire and is refused from then on.
 */
function fixture() {
  let open = true;
  let playlistExpired = false;
  const held: (() => void)[] = [];
  const serve = (req: IncomingMessage, res: ServerResponse): void => answerWithRange(req, res, CLIP);
  const video = (source: string, preload = "metadata"): string =>
    `<video src="${source}" preload="${preload}" controls width="640" height="360"></video>`;
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const html = path === "/page.html" ? video("/slow.mp4")
      : path === "/delayed.html" ? video("/delayed.mp4", "none")
        : path === "/refused.html" ? video("/refused.mp4")
          : path === "/missing.html" ? video("/missing.mp4", "none")
          : path === "/stream.html" ? video("/stream/media.m3u8")
            : path === "/fullscreen.html" ? `<div id="player" style="width:640px;height:360px;background:#000">${video("/slow.mp4")}
              <button id="full" onclick="document.getElementById('player').requestFullscreen()">Fullscreen</button></div>` : null;
    if (html !== null) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Popup fixture</title>${html}`);
      return;
    }
    if (path === "/stream/media.m3u8") {
      if (playlistExpired) { res.writeHead(403, { "content-type": "text/plain" }); res.end("expired"); return; }
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" });
      res.end("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nseg0.ts\n#EXT-X-ENDLIST\n");
      return;
    }
    if (path === "/delayed.mp4") {
      if (open) { serve(req, res); return; }
      held.push(() => { if (!res.destroyed) serve(req, res); });
      return;
    }
    if (path === "/refused.mp4") {
      if (req.headers["if-range"] === undefined) { serve(req, res); return; }
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("no");
      return;
    }
    if (path !== "/slow.mp4") { res.writeHead(404, { "content-type": "text/plain" }); res.end("gone"); return; }
    if (open || req.headers["if-range"] === undefined) { serve(req, res); return; }
    // Half of the part arrives, so the save shows progress; the rest waits for the gate.
    const { start, end } = beginRangeAnswer(req, res, CLIP);
    const middle = start + Math.floor((end - start + 1) / 2);
    res.write(CLIP.subarray(start, middle));
    held.push(() => { if (!res.destroyed) res.end(CLIP.subarray(middle, end + 1)); });
  });
  return {
    server,
    close: (): void => { open = false; },
    release: (): void => { open = true; for (const go of held.splice(0)) go(); },
    held: (): number => held.length,
    expirePlaylist: (): void => { playlistExpired = true; },
    reset: (): void => { open = true; held.length = 0; playlistExpired = false; },
  };
}

test.describe("the popup, the toolbar button and the toast while things happen", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "uses the Chromium extension runtime");

  const gate = fixture();
  let context: BrowserContext;
  let extensionId = "";
  let base = "";
  let session: ExtensionSession | undefined;
  let workerErrors: string[] = [];
  let probe: Page;

  test.beforeAll(async ({ browserName }) => {
    if (browserName !== "chromium") return;
    await new Promise<void>(done => gate.server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(gate.server.address() as { port: number }).port}`;
    session = await launchExtension({ name: "ux", viewport: { width: 1280, height: 800 } });
    ({ context, extensionId } = session);
    workerErrors = collectWorkerErrors(context, () => extensionId);
    probe = await context.newPage();
    await probe.goto(session.popupUrl);
  });

  test.beforeEach(async () => {
    gate.reset();
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
  const completed = () => probe.evaluate(async () => (await chrome.downloads.search({})).filter(item => item.state === "complete").length);
  const allDownloads = () => probe.evaluate(async () => (await chrome.downloads.search({})).length);
  const titleOf = (tabId: number) => extensionWorker(context, extensionId).then(worker => worker.evaluate(id => chrome.action.getTitle({ tabId: id }), tabId));

  /** A fixture page, by itself. */
  async function openPage(path: string): Promise<{ page: Page; tabId: number; url: string }> {
    const page = await context.newPage();
    const url = `${base}${path}?run=${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await page.goto(url);
    await page.bringToFront();
    return { page, tabId: await tabIdOf(url), url };
  }

  const popupFor = (tabId: number): Promise<Page> => openPopup(session!, tabId);

  test("says that it is checking the page while the first look runs, then announces what it found", async () => {
    gate.close();
    const { tabId } = await openPage("/delayed.html");
    const popup = await popupFor(tabId);
    await expect(popup.getByTestId("page-loading")).toHaveText("Checking this page…");
    await expect(popup.getByTestId("media-list")).toHaveAttribute("aria-busy", "true");
    await expect(popup.getByRole("button", { name: "Checking…" })).toBeDisabled();
    await expect(popup.getByTestId("page-empty")).toHaveCount(0);
    // Nothing is announced while it looks: the regions are there, and empty.
    await expect(popup.getByRole("status")).toHaveCount(1);
    await expect(popup.getByRole("alert")).toHaveCount(1);
    await expect(popup.getByRole("status")).toHaveText("");
    gate.release();
    await expect(popup.getByTestId("page-loading")).toHaveCount(0);
    await expect(popup.getByRole("button", { name: "Save", exact: true })).toHaveCount(1);
    await expect(popup.getByTestId("media-list")).toHaveAttribute("aria-busy", "false");
    await expect(popup.getByRole("status")).toHaveText("Found 1 item.");
    await expect(popup.getByRole("alert")).toHaveText("");
  });

  test("shows a failure that was there when it opened without reading it out, and has no live region besides its two", async () => {
    const { tabId } = await openPage("/missing.html");
    const popup = await popupFor(tabId);
    const failure = popup.getByTestId("discovery-failure");
    await expect(failure.getByTestId("failure-title")).toHaveText("The server refused the file");
    await expect(failure.getByTestId("failure-body")).toHaveText("The server no longer has this file.");
    await expect(popup.getByRole("status")).toHaveCount(1);
    await expect(popup.getByRole("alert")).toHaveCount(1);
    expect(await popup.locator("[aria-live]").count()).toBe(1);
    await expect(popup.getByRole("alert")).toHaveText("");
    await expect(popup.getByRole("status")).toHaveText("1 source could not be checked.");
    // The one appeal to the user's conscience: once, in the footer, outside every live region.
    await expect(popup.getByText("Save only what you have the right to keep.", { exact: true })).toHaveCount(1);
    await expect(popup.locator("footer").getByTestId("conscience-line")).toBeVisible();
    await expect(popup.locator("footer")).not.toContainText(/detected/);
  });

  test("a save that fails while the popup is open is read out once as an alert, in the words the card shows", async () => {
    const { tabId } = await openPage("/refused.html");
    const popup = await popupFor(tabId);
    await popup.getByRole("button", { name: "Save", exact: true }).click();
    const error = popup.getByTestId("job-error");
    await expect(error.getByTestId("failure-title")).toHaveText("The server refused access", { timeout: 20_000 });
    await expect(popup.getByRole("alert")).toHaveText(
      "The server refused access. The server refused this file. Its link may have expired. Reload the page, start playback, then try again.");
    await expect(popup.getByRole("alert")).not.toContainText(/403|access_denied|HTTP/);
    // The hint comes first (reload, start playback), so the button does not promise that a retry helps.
    await expect(popup.getByTestId("item-action")).toHaveText("Save");
    await expect(popup.getByRole("button", { name: "Retry save" })).toHaveCount(0);
    expect(await allDownloads()).toBe(0);
  });

  test("a playlist that answered when the video was found and is refused as the save starts: said plainly, with what to do, and no guess why", async () => {
    const { page, tabId } = await openPage("/stream.html");
    const popup = await popupFor(tabId);
    await expect(popup.getByRole("button", { name: "Save", exact: true })).toBeVisible({ timeout: 20_000 });
    // The playlist answered for the page and for the look at it. From now on the server refuses it.
    gate.expirePlaylist();
    await popup.getByRole("button", { name: "Save", exact: true }).click();
    const error = popup.getByTestId("job-error");
    await expect(error.getByTestId("failure-title")).toHaveText("The video's playlist no longer answers", { timeout: 20_000 });
    await expect(error.getByTestId("failure-body")).toHaveText("This video's playlist answered when savemedia found it, but the server refused it when the save started.");
    await expect(error.getByTestId("failure-hint")).toHaveText("Play the video on the page again, then save.");
    await expect(popup.getByRole("alert")).toHaveText("The video's playlist no longer answers. "
      + "This video's playlist answered when savemedia found it, but the server refused it when the save started. Play the video on the page again, then save.");
    // No reason is guessed, and the status stays under Technical details.
    await expect(popup.getByRole("alert")).not.toContainText(/expired|403|session|HTTP/);
    await expect(error.getByText("403", { exact: true })).toBeHidden();
    await error.getByText("Technical details", { exact: true }).click();
    await expect(error.getByText("403", { exact: true })).toBeVisible();
    await expect(error.getByText("Playlist, read again as the save started", { exact: true })).toBeVisible();
    await expect(popup.getByRole("button", { name: "Retry save" })).toHaveCount(0);
    expect(await allDownloads()).toBe(0);
    await popup.close();

    // Alt+S says the same in one line.
    await page.bringToFront();
    await page.mouse.move(320, 180);
    await page.keyboard.press("Alt+KeyS");
    await expect(toastDetail(page)).toHaveText("The video's playlist no longer answers. Play the video on the page again, then save.", { timeout: 20_000 });
    expect(await allDownloads()).toBe(0);
  });

  test("a running save shows a named progress bar, plain progress and a toolbar title in lowercase; cancel ends it quietly", async () => {
    const { tabId } = await openPage("/page.html");
    const popup = await popupFor(tabId);
    const action = popup.getByTestId("item-action");
    await expect(action).toHaveText("Save");
    gate.close();
    await action.click();
    await expect.poll(gate.held).toBeGreaterThan(0);
    const bar = popup.getByRole("progressbar", { name: "Download progress" });
    await expect(bar).toBeVisible();
    await expect(popup.getByTestId("progress-label")).toHaveText("Downloading");
    await expect(popup.getByTestId("progress-bytes")).toHaveText(/^\d+(\.\d+)? (B|KB) of \d+(\.\d+)? KB$/);
    await expect(popup.getByTestId("progress")).not.toContainText(/segment|\d+\/\d+|…/);
    await expect(popup.getByTestId("close-hint")).toHaveText("You can close this popup. The save continues.");
    // The same button, now Cancel.
    await expect(action).toHaveText("Cancel");
    await expect.poll(() => titleOf(tabId)).toMatch(/^savemedia · Downloading · \d+% of \d+(\.\d+)? KB$/);

    await action.click();
    // The user's own cancel is not a failure: no error, no retry, no alert.
    await expect(popup.getByTestId("job-cancelled")).toHaveText("Cancelled");
    await expect(action).toHaveText("Save");
    await expect(popup.getByTestId("job-error")).toHaveCount(0);
    await expect(popup.getByRole("button", { name: "Retry save" })).toHaveCount(0);
    await expect(popup.getByRole("alert")).toHaveText("");
    await expect(popup.getByRole("status")).toHaveText("Save cancelled");
    await expect.poll(() => titleOf(tabId)).toBe("savemedia");
    gate.release();
    expect(await allDownloads()).toBe(0);
    const view = await ask<View>({ type: "list", tabId });
    expect(Object.values(view.statuses ?? {})).toEqual([{ phase: "cancelled" }]);
  });

  test("Save another copy in the popup saves at once: the click is the answer, and no question follows", async () => {
    const { tabId, url } = await openPage("/page.html");
    const popup = await popupFor(tabId);
    const action = popup.getByTestId("item-action");
    await action.click();
    // The name is the one the browser gave the file (the test browser names downloads itself).
    await expect(popup.getByTestId("job-complete")).toHaveText(/^Saved to Downloads: \S+/, { timeout: 20_000 });
    await expect.poll(completed).toBe(1);
    await expect(popup.getByRole("status")).toHaveText(/^Saved to Downloads: \S+$/);
    await expect(action).toHaveText("Save another copy");
    await action.click();
    await expect.poll(completed, { timeout: 20_000 }).toBe(2);
    await expect(popup.getByTestId("repeat-save")).toHaveCount(0);
    expect((await ask<{ prompt: unknown }>({ type: "current-save-state", tabId, pageUrl: url })).prompt).toBeNull();
  });

  test("the Alt+S toast labels the state and names the object; a second press on a running save changes nothing", async () => {
    const { page, tabId } = await openPage("/page.html");
    await expect.poll(async () => (await ask<View>({ type: "rescan", tabId })).descriptors.length).toBe(1);
    gate.close();
    await page.mouse.move(320, 180);
    await page.keyboard.press("Alt+KeyS");
    await expect(toastLabel(page)).toHaveText("Saving");
    await expect(toastDetail(page)).toHaveText(/^This video · \d+(\.\d+)? KB$/);
    // The card is for the eye. A screen reader gets one line, from a region that was there before the text.
    await expect(toastCard(page)).toHaveAttribute("aria-hidden", "true");
    await expect(toast(page).locator('[role="status"]')).toHaveText(/^Saving: This video · /);
    await expect(toast(page).locator('[role="alert"]')).toHaveText("");
    // While the toast shows, the toolbar button says the same.
    await expect.poll(() => titleOf(tabId)).toMatch(/^savemedia · (Saving: This video|Downloading|Starting|Checking the file)/);

    await expect.poll(gate.held).toBeGreaterThan(0);
    await page.keyboard.press("Alt+KeyS");
    await expect(toastDetail(page)).toHaveText("Already in progress");
    await expect(toastLabel(page)).toHaveText("Saving");
    expect(Object.keys((await ask<View>({ type: "list", tabId })).statuses ?? {})).toHaveLength(1);
    gate.release();
    await expect(toastLabel(page)).toHaveText("Saved", { timeout: 20_000 });
    await expect(toastDetail(page)).not.toHaveText(/^(Saved|Already in progress|This video)/);
    await expect.poll(completed).toBe(1);
    expect(await toast(page).count()).toBe(1);
  });

  test("the toast stays above a player that is fullscreen", async () => {
    const { page } = await openPage("/fullscreen.html");
    await page.locator("#full").click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null)).toBe("player");
    gate.close();
    await page.mouse.move(320, 180);
    await page.keyboard.press("Alt+KeyS");
    await expect(toastLabel(page)).toHaveText("Saving");
    // A popover that is open is in the browser's top layer, above the fullscreen element.
    expect(await toast(page).evaluate(host => host.matches(":popover-open"))).toBe(true);
    await expect(toastCard(page)).toBeVisible();
    // Leaving and entering fullscreen while it shows keeps it on top.
    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    expect(await toast(page).evaluate(host => host.matches(":popover-open"))).toBe(true);
    gate.release();
    await expect(toastLabel(page)).toHaveText("Saved", { timeout: 20_000 });
  });
});
