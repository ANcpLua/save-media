import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchExtension, watchExtensionPages, type ExtensionSession } from "./extension-browser";
import { TOAST, findTabId, popupFor as openPopup, toast, toastCard, toastLabel, type View } from "./helpers";

/**
 * Main-video selection and hard page layouts, in a real browser: ads, frames,
 * shadow roots, canvases, route changes, key use, gates and disguised bytes.
 * The test is the user: it moves the pointer, presses Alt+S and clicks what a
 * person would click. savemedia itself never clicks, plays or fetches an ad.
 *
 * Alt+S here is a key event the page receives. The browser's own command
 * (chrome.commands) cannot be pressed from a test; both reach the same
 * function, which a unit test covers (download-best.test.ts).
 *
 * Every clip a test must play is WebM: the headless browser has no H.264.
 */

const here = dirname(fileURLToPath(import.meta.url));
const port = process.env.SAVEMEDIA_FIXTURE_PORT ?? "5174";
const base = `http://127.0.0.1:${port}`;
const fixtureBytes = (name: string) => readFileSync(resolve(here, "media-fixtures", name));
const CLIP = "direct/clip.webm";
const LOW = "low/clip.webm";
const HINTS = {
  notLoaded: "The page has not loaded the video yet. Start playback, then try again.",
  notReceived: "This file has not reached your browser yet. savemedia saves it once your browser receives it.",
};

test.describe("main video and hard layouts", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "chromium-only suite");

  let session: ExtensionSession | undefined;
  let context: BrowserContext | undefined;
  let probe: Page;
  let downloadDir = "";
  let consoleErrors: string[] = [];

  test.beforeAll(async ({ browserName }) => {
    if (browserName !== "chromium") return;
    session = await launchExtension({ name: "main-video", baseURL: base, viewport: { width: 1280, height: 800 },
      args: ["--autoplay-policy=no-user-gesture-required"] });
    ({ context, downloadDir } = session);
    consoleErrors = watchExtensionPages(session, ["pageerror"]);
    probe = await context.newPage();
    await probe.goto(session.popupUrl);
  });

  test.beforeEach(async () => {
    await probe.evaluate(async () => { await chrome.storage.session.clear(); await chrome.downloads.erase({}); });
    await fetch(`${base}/__requests`, { method: "POST" });
  });

  test.afterEach(() => {
    expect(consoleErrors.splice(0), "errors thrown in extension pages").toEqual([]);
    expect(session?.workerErrors.splice(0) ?? [], "errors the extension logged in its service worker").toEqual([]);
  });

  test.afterAll(async () => {
    await session?.close();
  });

  async function open(scenario: string): Promise<Page> {
    const page = await context!.newPage();
    await page.bringToFront();
    await page.goto(`/page/${scenario}.html`);
    await page.waitForLoadState("networkidle");
    return page;
  }

  /** Undefined while the browser and the test disagree about a tab's address, as right after a page changed its own. */
  const tabIdOf = (page: Page) => findTabId(probe, page.url());

  /** The tab's view as the background holds it now. */
  async function view(page: Page): Promise<View> {
    const tabId = await tabIdOf(page);
    return probe.evaluate(id => chrome.runtime.sendMessage({ type: "list", tabId: id }), tabId) as Promise<View>;
  }

  /** The tab's view after the look at the page that opening the popup takes. */
  async function scan(page: Page): Promise<View> {
    const tabId = await tabIdOf(page);
    return probe.evaluate(id => chrome.runtime.sendMessage({ type: "rescan", tabId: id }), tabId) as Promise<View>;
  }

  const popupFor = async (page: Page): Promise<Page> => openPopup(session!, await tabIdOf(page));

  const downloads = () => probe.evaluate(() => chrome.downloads.search({}));
  const requests = async () => await (await fetch(`${base}/__requests`)).json() as { path: string; dest: string; page: string }[];
  const mediaPath = (item: View["descriptors"][number]) => new URL(item.source.url ?? item.source.manifestUrl ?? item.source.elementSrc ?? "x:/").pathname;

  /** Move the pointer there and press Alt+S, as a person would. */
  async function altS(page: Page, x: number, y: number): Promise<void> {
    await page.bringToFront();
    await page.mouse.move(x, y);
    await page.mouse.move(x + 1, y + 1);
    await page.keyboard.press("Alt+KeyS");
  }

  /** The one file this test saved, once Chrome has finished writing it. */
  async function savedFile(page: Page): Promise<Buffer> {
    await expect(toastLabel(page)).toHaveText("Saved", { timeout: 20_000 });
    await expect.poll(async () => (await downloads()).filter(item => item.state === "complete").length).toBe(1);
    const [item] = (await downloads()).filter(entry => entry.state === "complete");
    return readFileSync(item!.filename);
  }

  async function expectSaved(page: Page, fixture: string): Promise<void> {
    expect((await savedFile(page)).equals(fixtureBytes(fixture)), `the saved file should be ${fixture}`).toBe(true);
  }

  const playing = (page: Page, selector = "video") => expect.poll(() => page.evaluate(sel => {
    const video = document.querySelector<HTMLVideoElement>(sel);
    return !!video && video.currentTime > 0;
  }, selector), { message: `${selector} should be playing` }).toBe(true);

  /** The ids of the rows a view lists as the page's media, and as ads. */
  const listedAs = (shown: View) => {
    const path = (id: string) => mediaPath(shown.descriptors.find(item => item.id === id)!);
    return { cards: (shown.selection?.cards ?? []).map(card => card.ids.map(path)), ads: (shown.selection?.ads ?? []).map(card => card.ids.map(path)) };
  };
  const badge = async (page: Page) => probe.evaluate(id => chrome.action.getBadgeText({ tabId: id! }), await tabIdOf(page));
  /** The one file a Save in the popup wrote, once the browser has finished writing it. */
  async function savedFromPopup(): Promise<Buffer> {
    await expect.poll(async () => (await downloads()).filter(item => item.state === "complete").length, { timeout: 20_000 }).toBe(1);
    return readFileSync((await downloads()).find(item => item.state === "complete")!.filename);
  }

  for (const [fixture, adDocument, announced] of [["preroll", "/ads/vast.xml", "a VAST response"], ["preroll-vmap", "/ads/vmap.xml", "a VMAP response"]] as const) {
  test(`pre-roll announced by ${announced}: the declared content is the main video; the ad creative is listed apart, never as Main, and never requested by savemedia on its own`, async () => {
    const page = await open(fixture);
    await page.waitForFunction(() => (window as unknown as { __adStarted?: boolean }).__adStarted === true);
    await playing(page, "#v");
    const popup = await popupFor(page);
    try {
      // The one visible Save is the content's: the ad waits, closed, under Ads (1).
      await expect(popup.getByRole("button", { name: /save/i })).toHaveCount(1);
      await expect(popup.getByTestId("main-badge")).toHaveCount(1);
      const ads = popup.getByTestId("ads");
      await expect(ads.locator(":scope > summary")).toHaveText("Ads (1)");
      expect(await ads.evaluate(node => (node as HTMLDetailsElement).open)).toBe(false);
      await expect(ads.getByTestId("main-badge")).toHaveCount(0);
      const shown = await view(page);
      expect(listedAs(shown)).toEqual({ cards: [["/hls/master.m3u8"]], ads: [["/ads/creative.webm"]] });
      expect(shown.selection).toMatchObject({ state: "ready", elementMain: true });
      // The toolbar counts the page's media. The ad is not one of them.
      expect(await badge(page)).toBe("1");
      await popup.close();
      await altS(page, 320, 180);
      const saved = await savedFile(page);
      // An MP4 box header: the HLS content, remuxed. Never the WebM creative.
      expect(saved.subarray(4, 8).toString()).toBe("ftyp");
      // The ad played on, untouched, and only the page's own player ever asked for the creative.
      expect(await page.evaluate(() => { const v = document.querySelector("video")!; return { paused: v.paused, muted: v.muted, src: new URL(v.src).pathname }; }))
        .toEqual({ paused: false, muted: true, src: "/ads/creative.webm" });
      const creative = (await requests()).filter(request => request.path.startsWith("/ads/creative"));
      expect(creative.length).toBeGreaterThan(0);
      expect(creative.filter(request => request.dest !== "video")).toEqual([]);
      // The page's player, and nobody else, fetched the ad document that names the creative.
      const fetched = (await requests()).filter(request => request.path.startsWith("/ads/") && request.path.endsWith(".xml"));
      expect(fetched.map(request => [request.path, request.page])).toEqual([[adDocument, "ad"]]);
      // The VMAP names a wrapper tag for its second break. It is an address in a document the browser
      // received, and nothing more: neither the page nor savemedia asks for it.
      expect((await requests()).filter(request => request.path.includes("never-requested"))).toEqual([]);
      expect(await page.evaluate(() => (window as unknown as { __untrusted: number }).__untrusted)).toBe(0);
    } finally {
      await popup.close().catch(() => undefined);
      await page.close();
    }
  });
  }

  test("a listed ad is saved when the user saves it from Ads, and only then does savemedia request it", async () => {
    const page = await open("preroll");
    await page.waitForFunction(() => (window as unknown as { __adStarted?: boolean }).__adStarted === true);
    await playing(page, "#v");
    const popup = await popupFor(page);
    try {
      const ads = popup.getByTestId("ads");
      await expect(ads.locator(":scope > summary")).toHaveText("Ads (1)");
      // Listing it cost no request: so far only the page's own player asked for the creative.
      expect((await requests()).filter(request => request.path.startsWith("/ads/creative") && request.dest !== "video")).toEqual([]);
      await ads.locator(":scope > summary").click();
      await expect(ads.getByTestId("ad-badge")).toHaveText("Ad");
      await ads.getByRole("button", { name: "Save", exact: true }).click();
      expect((await savedFromPopup()).equals(fixtureBytes("ads/creative.webm")), "the saved file should be the ad creative").toBe(true);
      await expect(ads.getByTestId("job-complete")).toContainText("Saved to Downloads");
      // The user's Save is the request: now, and only now, savemedia asked the ad's server.
      expect((await requests()).filter(request => request.path.startsWith("/ads/creative") && request.dest !== "video").length).toBeGreaterThan(0);
      // Saving it changed nothing about what it is: still an ad, still not counted, the content still the main video.
      const shown = await view(page);
      expect(listedAs(shown)).toEqual({ cards: [["/hls/master.m3u8"]], ads: [["/ads/creative.webm"]] });
      expect(await badge(page)).toBe("1");
      expect(await page.evaluate(() => (window as unknown as { __untrusted: number }).__untrusted)).toBe(0);
    } finally {
      await popup.close().catch(() => undefined);
      await page.close();
    }
  });

  test("an ad response that names the page's own video hides nothing: the video is listed under Ads and saved from there; Alt+S says an ad is playing", async () => {
    const page = await open("ad-names-main");
    await page.waitForFunction(() => (window as unknown as { __adStarted?: boolean }).__adStarted === true);
    await playing(page, "#v");
    const popup = await popupFor(page);
    try {
      const ads = popup.getByTestId("ads");
      await expect(ads.locator(":scope > summary")).toHaveText("Ads (1)");
      const shown = await view(page);
      expect(listedAs(shown)).toEqual({ cards: [], ads: [["/direct/clip.webm"]] });
      expect(shown.selection).toMatchObject({ state: "ad-playing", mainId: null });
      // Nothing is counted and nothing is offered as the page's video.
      expect(await badge(page)).toBe("");
      await expect(popup.getByTestId("main-badge")).toHaveCount(0);
      await expect(popup.getByTestId("page-hint")).toHaveText("An ad is playing. Try again when the video starts.");
      // savemedia asked the server for nothing: the row is what the browser itself received.
      expect((await requests()).filter(request => request.path === "/direct/clip.webm" && request.dest !== "video")).toEqual([]);

      // Alt+S over the video keeps the answer for a video that plays an ad, and saves nothing.
      await altS(page, 320, 180);
      await expect(toastCard(page)).toHaveText("Not readyAn ad is playing. Try again when the video starts.");
      expect(await downloads()).toEqual([]);

      // The user can still save it: from the list, by the user's own click.
      await popup.bringToFront();
      await ads.locator(":scope > summary").click();
      await ads.getByRole("button", { name: "Save", exact: true }).click();
      expect((await savedFromPopup()).equals(fixtureBytes(CLIP)), "the saved file should be the page's video").toBe(true);
      expect(await page.evaluate(() => (window as unknown as { __untrusted: number }).__untrusted)).toBe(0);
    } finally {
      await popup.close().catch(() => undefined);
      await page.close();
    }
  });

  test("an ad video on the page and the player in a frame: the frame's file is the main video and what Alt+S saves", async () => {
    const page = await open("outstream-frame");
    await playing(page, "#ad");
    const popup = await popupFor(page);
    try {
      await expect(popup.getByTestId("main-badge")).toHaveCount(1);
      const shown = await view(page);
      // The page's own ad video is listed apart: the frame's file is the one card.
      expect(listedAs(shown)).toEqual({ cards: [["/direct/clip.webm"]], ads: [["/ads/creative.webm"]] });
      await popup.close();
      await altS(page, 320, 90 + 180);
      await expectSaved(page, CLIP);
    } finally {
      await popup.close().catch(() => undefined);
      await page.close();
    }
  });

  test("a banner frame over the player: Alt+S on the banner saves the player's file, not the banner", async () => {
    const page = await open("ad-overlay-frame");
    try {
      await altS(page, 320, 315);
      await expectSaved(page, CLIP);
      expect((await downloads()).map(item => item.filename).filter(name => /\.png$/i.test(name))).toEqual([]);
    } finally { await page.close(); }
  });

  test("the page's own banner over a player in a frame: Alt+S on the banner saves the frame's video, not the banner", async () => {
    const page = await open("banner-over-frame");
    try {
      // The pointer is on the page's image, so the frame below never sees it.
      await altS(page, 320, 315);
      await expectSaved(page, CLIP);
      expect((await downloads()).map(item => item.filename).filter(name => /\.png$/i.test(name))).toEqual([]);
    } finally { await page.close(); }
  });

  test("a frame that dispatches pointer events of its own does not draw Alt+S away from the video under the pointer", async () => {
    const page = await open("forged-pointer");
    try {
      const frame = page.frames().find(item => item.url().endsWith("/page/forged-pointer-frame.html"))!;
      await page.bringToFront();
      await page.mouse.move(320, 180);
      await page.mouse.move(321, 181);
      // The frame's script has dispatched its events after the user's last move: its record would be the newest.
      const before = await frame.evaluate(() => (window as unknown as { __forged: number }).__forged);
      await expect.poll(() => frame.evaluate(() => (window as unknown as { __forged: number }).__forged)).toBeGreaterThan(before + 2);
      await page.keyboard.press("Alt+KeyS");
      await expectSaved(page, CLIP);
    } finally { await page.close(); }
  });

  test("a page that tells the bridge it plays a file it never loaded makes savemedia request nothing", async () => {
    const page = await open("forged-capture");
    try {
      await page.waitForFunction(() => (window as unknown as { __forged?: number }).__forged === 2);
      // Two looks at the page pass through the service worker after the forged messages did.
      await scan(page);
      const shown = await scan(page);
      expect(shown.descriptors).toEqual([]);
      expect(shown.failures ?? []).toEqual([]);
      expect((await requests()).filter(request => request.path.includes("forged"))).toEqual([]);
    } finally { await page.close(); }
  });

  for (const [scenario, fixture] of [["canvas-mirror", CLIP], ["canvas-child", LOW], ["canvas-unattached", CLIP]] as const) {
    test(`Alt+S over a canvas saves the video it draws (${scenario}), never a picture of the canvas`, async () => {
      const page = await open(scenario);
      try {
        // A video outside the document is known only by its requests.
        if (scenario === "canvas-unattached") await expect.poll(async () => (await view(page)).descriptors.length).toBe(1);
        else await playing(page, "#src");
        await altS(page, 160, 90);
        await expectSaved(page, fixture);
        expect(await downloads()).toHaveLength(1);
      } finally { await page.close(); }
    });
  }

  test("a canvas fed by a video the page never attached, next to a teaser in a video element: each saves its own video", async () => {
    for (const [y, fixture] of [[90, CLIP], [180 + 20 + 90, LOW]] as const) {
      await probe.evaluate(() => chrome.downloads.erase({}));
      const page = await open("canvas-unattached-teaser");
      try {
        // The canvas's video is no element: it is known only by the request the page made for it.
        await expect.poll(async () => (await view(page)).descriptors.map(mediaPath).sort()).toEqual(["/direct/clip.webm", "/low/clip.webm"]);
        await playing(page, "#teaser");
        // Without the pointer, the teaser is the page's one video element and its main video.
        expect((await scan(page)).selection).toMatchObject({ state: "ready", elementMain: true });
        await altS(page, 160, y);
        await expectSaved(page, fixture);
        expect(await downloads()).toHaveLength(1);
      } finally { await page.close(); }
    }
  });

  test("Alt+S on a control the player draws above its canvas saves the video the canvas draws, never the control's picture", async () => {
    // A play button drawn as a background image, and a logo in an image element, both above the canvas.
    for (const x of [80, 240]) {
      // Each control is its own case: the second press is not a second copy of the first save.
      await probe.evaluate(async () => { await chrome.storage.session.clear(); await chrome.downloads.erase({}); });
      const page = await open("canvas-unattached-control");
      try {
        await expect.poll(async () => (await view(page)).descriptors.length).toBe(1);
        await altS(page, x, 90);
        await expectSaved(page, CLIP);
        expect(await downloads()).toHaveLength(1);
      } finally { await page.close(); }
    }
  });

  test("a page that names a file and plays a preview of another kind: the preview keeps its own name, and the popup says the named file has not arrived", async () => {
    const page = await open("named-preview");
    try {
      await playing(page, "#v");
      const popup = await popupFor(page);
      const hint = popup.getByTestId("named-file-pending");
      await expect(hint).toHaveText("The file this page names (Holiday.Trip.2024.1080p.mkv) has not reached your browser yet. "
        + "What is listed here is what your browser did receive. savemedia saves the named file once your browser receives it.", { timeout: 20_000 });
      // The preview is listed with its Save, and is not called by the named file's name.
      const card = popup.locator("[data-main]");
      await expect(card.getByRole("button", { name: "Save", exact: true })).toHaveCount(1);
      await expect(card).not.toContainText("Holiday");
      expect((await view(page)).selection).toMatchObject({ state: "ready", mainName: null, namedPending: "Holiday.Trip.2024.1080p.mkv" });
      await popup.close();

      await altS(page, 320, 180);
      // What is saved is the preview, under its own name.
      expect((await savedFile(page)).equals(fixtureBytes("direct/clip.mp4")), "the saved file is the preview the page played").toBe(true);
      // The save was not given the page's name for the file: a save that is carries it as its file name.
      // (The unit test of the same layout pins the file's own name; a headless browser writes under a name of its own.)
      const saves = Object.values((await view(page)).statuses ?? {});
      expect(saves.map(status => [status.phase, status.fileName])).toEqual([["complete", undefined]]);
    } finally { await page.close(); }
  });

  test("two canvas players on one page: each canvas saves its own video", async () => {
    for (const [y, fixture] of [[90, CLIP], [180 + 20 + 90, LOW]] as const) {
      await probe.evaluate(() => chrome.downloads.erase({}));
      const page = await open("canvas-two");
      try {
        await altS(page, 160, y);
        await expectSaved(page, fixture);
      } finally { await page.close(); }
    }
  });

  test("a chart canvas over a photo saves neither: the photo below a canvas is not the target", async () => {
    const page = await open("canvas-chart");
    try {
      await altS(page, 160, 90);
      await expect(toastCard(page)).toHaveText("Nothing to saveNo media detected on this page.");
      expect(await downloads()).toEqual([]);
    } finally { await page.close(); }
  });

  test("Alt+S twice on the same image is one file and one question (rule 11)", async () => {
    const page = await open("image-verify");
    const cdp = await context!.newCDPSession(page);
    await cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
    const saved = async () => (await downloads()).filter(entry => entry.state === "complete");
    try {
      const tabId = await tabIdOf(page);
      const state = () => probe.evaluate(([id, url]) => chrome.runtime.sendMessage({ type: "current-save-state", tabId: id, pageUrl: url }),
        [tabId, page.url()] as const) as Promise<{ prompt: { id: string; filename: string } | null }>;
      const box = (await page.locator("#plain").boundingBox())!;
      await altS(page, box.x + 50, box.y + 50);
      await expect(toastCard(page)).toHaveText("Savedplain.svg");
      expect(await saved()).toHaveLength(1);

      // The second press asks before a second copy and saves nothing by itself.
      await altS(page, box.x + 50, box.y + 50);
      await expect.poll(async () => (await state()).prompt?.filename, { message: "a repeat question should be open" }).toBe("plain.svg");
      // A third press while the question is open changes nothing.
      await altS(page, box.x + 50, box.y + 50);
      const { prompt } = await state();
      expect((await downloads()).length).toBe(1);
      expect(await probe.evaluate(id => chrome.runtime.sendMessage({ type: "answer-repeat-save", id, allow: false }), prompt!.id)).toEqual({ ok: true });
      expect((await state()).prompt).toBeNull();
      expect((await downloads()).length).toBe(1);

      // "Save another copy" is the user's own choice: only then is a second file made.
      await altS(page, box.x + 50, box.y + 50);
      await expect.poll(async () => (await state()).prompt !== null).toBe(true);
      await probe.evaluate(id => chrome.runtime.sendMessage({ type: "answer-repeat-save", id, allow: true }), (await state()).prompt!.id);
      await expect.poll(async () => (await saved()).length).toBe(2);
      for (const item of await saved()) rmSync(item.filename, { force: true });
    } finally {
      await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloadDir });
      await page.close();
    }
  });

  test("an image is saved only when its bytes are an image: pages, programs, archives and script are refused", async () => {
    const page = await open("image-verify");
    const before = readdirNames(downloadDir);
    // Keep Chrome's own file names, which the page's feedback reports.
    const cdp = await context!.newCDPSession(page);
    await cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
    try {
      for (const [id, text] of [
        ["fake", "Not an image. The address sent a web page, so savemedia did not save it."],
        ["setup", "Not an image. The address sent a program or an archive, so savemedia did not save it."],
        ["archive", "Not an image. The address sent a program or an archive, so savemedia did not save it."],
        ["active", "Not an image. The address sent text or a script, so savemedia did not save it."],
      ] as const) {
        const box = (await page.locator(`#${id}`).boundingBox())!;
        await altS(page, box.x + 50, box.y + 50);
        await expect(toastCard(page)).toHaveText(`Not saved${text}`);
      }
      expect(await downloads()).toEqual([]);
      // Not one byte of them reached the Downloads folder.
      expect(readdirNames(downloadDir)).toEqual(before);
      // A plain SVG of the same shape is an image and is saved, byte for byte, under a name savemedia built.
      const box = (await page.locator("#plain").boundingBox())!;
      await altS(page, box.x + 50, box.y + 50);
      await expect(toastCard(page)).toHaveText("Savedplain.svg");
      const [item] = (await downloads()).filter(entry => entry.state === "complete");
      expect(readFileSync(item!.filename).equals(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="teal"/></svg>'))).toBe(true);
      rmSync(item!.filename, { force: true });
    } finally {
      await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloadDir });
      await page.close();
    }
  });

  test("a program served as a video is refused at the check: no Save, nothing in Downloads", async () => {
    const page = await open("file-exe");
    const popup = await popupFor(page);
    try {
      await expect(popup.getByTestId("discovery-failure").getByTestId("failure-title")).toHaveText("This isn't a video savemedia can save");
      await expect(popup.getByTestId("discovery-failure")).toHaveAttribute("data-tone", "unusable");
      await expect(popup.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
      await popup.close();
      await altS(page, 320, 180);
      await expect(toastLabel(page)).toHaveText("Not saved");
      expect(await downloads()).toEqual([]);
    } finally {
      await popup.close().catch(() => undefined);
      await page.close();
    }
  });

  test("Ctrl+S is the page's and the browser's: no save, no toast, the key is not taken. Alt+S is one save.", async () => {
    const page = await open("webm");
    try {
      await page.mouse.move(320, 180);
      await page.keyboard.press("Control+KeyS");
      await page.keyboard.press("Meta+KeyS");
      await page.keyboard.press("Alt+Shift+KeyS");
      await page.waitForTimeout(700);
      await expect(toast(page)).toHaveCount(0);
      expect(await downloads()).toEqual([]);
      expect(Object.keys((await view(page)).statuses ?? {})).toEqual([]);
      const keys = await page.evaluate(() => (window as unknown as { __keys: { code: string; ctrl: boolean; alt: boolean; prevented: boolean }[] }).__keys);
      expect(keys.filter(key => key.code === "KeyS").map(key => key.prevented)).toEqual([false, false, false]);

      // One Alt+S: one "Saving", one job, one file.
      const labels: string[] = [];
      await page.exposeFunction("__label", (label: string) => { labels.push(label); });
      await page.evaluate(selector => new MutationObserver(() => {
        const label = document.querySelector(selector)?.shadowRoot?.querySelector(".k")?.textContent;
        if (label) (window as unknown as { __label(label: string): void }).__label(label);
      }).observe(document.body, { childList: true, subtree: true }), TOAST);
      await altS(page, 320, 180);
      await expectSaved(page, CLIP);
      expect(Object.values((await view(page)).statuses ?? {}).map(status => status.phase)).toEqual(["complete"]);
      expect(await downloads()).toHaveLength(1);
      // The bridge took that key: the page's own listener never received a fourth S.
      expect((await page.evaluate(() => (window as unknown as { __keys: { code: string }[] }).__keys)).filter(key => key.code === "KeyS")).toHaveLength(3);
      expect(await page.evaluate(() => (window as unknown as { __mediaEvents: string[] }).__mediaEvents)).toEqual([]);
    } finally { await page.close(); }
  });

  // The player's data names a playlist the server no longer answers. Before the user starts the video that
  // failure is not the answer: "the server is busy, try again in a few minutes" hides that starting playback is what helps.
  test("a player that has not started, whose data names a playlist that fails: start playback is the advice, the failure is listed aside, and the played video is saved", async () => {
    const page = await open("gate-stale");
    const popup = await popupFor(page);
    try {
      await expect(popup.getByTestId("page-hint")).toHaveText(HINTS.notLoaded);
      const unavailable = popup.getByTestId("unavailable-sources");
      await expect(unavailable.locator("summary").first()).toHaveText("Unavailable sources (1)");
      expect(await unavailable.evaluate(element => (element as HTMLDetailsElement).open)).toBe(false);
      await popup.close();
      await altS(page, 320, 180);
      await expect(toastCard(page)).toHaveText(`Not ready${HINTS.notLoaded}`);
      expect(await downloads()).toEqual([]);
      await page.locator("#start").click();
      await altS(page, 320, 180);
      await expectSaved(page, CLIP);
    } finally {
      await popup.close().catch(() => undefined);
      await page.close();
    }
  });

  test("a gated player says the page has not loaded the video yet, and is saved once the user started it", async () => {
    const page = await open("gate");
    const popup = await popupFor(page);
    try {
      await expect(popup.getByTestId("page-hint")).toHaveText(HINTS.notLoaded);
      await popup.close();
      await altS(page, 320, 180);
      await expect(toastCard(page)).toHaveText(`Not ready${HINTS.notLoaded}`);
      expect(await downloads()).toEqual([]);
      // The test is the user: it clicks the page's own control. savemedia never does.
      expect(await page.evaluate(() => (window as unknown as { __untrusted: number }).__untrusted)).toBe(0);
      await page.locator("#start").click();
      await altS(page, 320, 180);
      await expectSaved(page, CLIP);
      expect(await page.evaluate(() => (window as unknown as { __untrusted: number }).__untrusted)).toBe(0);
    } finally {
      await popup.close().catch(() => undefined);
      await page.close();
    }
  });

  test("a poster of a player that makes its video only on Play: Alt+S on it saves no picture and says the video has not loaded yet", async () => {
    const page = await open("lazy-poster");
    try {
      await altS(page, 100, 100);
      await expect(toastCard(page)).toHaveText(`Not ready${HINTS.notLoaded}`);
      expect(await downloads()).toEqual([]);
      // Neither the embed page the metadata names nor anything else was requested for the press.
      expect((await requests()).map(request => request.path).filter(path => path !== "/pointer/card.png" && path !== "/favicon.ico")).toEqual([]);
      // The test is the user: it clicks the page's own control. savemedia never does.
      await page.locator("#start").click();
      await altS(page, 100, 100);
      await expectSaved(page, CLIP);
      expect(await page.evaluate(() => (window as unknown as { __untrusted: number }).__untrusted)).toBe(0);
    } finally { await page.close(); }
  });

  test("an article whose lead photo is its og:image, with an embedded video further down: Alt+S on the photo saves the photo", async () => {
    const page = await open("article-embed");
    try {
      // The embedded player has loaded its video. The photo the pointer is on is still a picture, not that video's still.
      await expect.poll(async () => (await scan(page)).descriptors.map(mediaPath)).toEqual(["/direct/clip.webm"]);
      await altS(page, 100, 100);
      const saved = await savedFile(page);
      expect(saved.equals(Buffer.from(await (await fetch(`${base}/pointer/card.png`)).arrayBuffer()))).toBe(true);
    } finally { await page.close(); }
  });

  test("a fake paywall over a loaded video: the video is saved without any click on the page", async () => {
    const page = await open("paywall");
    try {
      await altS(page, 320, 300);
      await expectSaved(page, CLIP);
      expect(await page.evaluate(() => {
        const state = window as unknown as { __untrusted: number; __unlockClicks: number; __mediaEvents: string[] };
        return { untrusted: state.__untrusted, unlock: state.__unlockClicks, media: state.__mediaEvents, paused: document.querySelector("video")!.paused };
      })).toEqual({ untrusted: 0, unlock: 0, media: [], paused: true });
    } finally { await page.close(); }
  });

  test("a page that names a file it has not handed over says so, and never points at a button", async () => {
    const page = await open("named-no-link");
    const popup = await popupFor(page);
    try {
      await expect(popup.getByTestId("page-hint")).toHaveText(HINTS.notReceived);
      await expect(popup.locator("main")).not.toContainText(/button/i);
      await popup.close();
      await altS(page, 200, 200);
      await expect(toastCard(page)).toHaveText(`Not ready${HINTS.notReceived}`);
      expect(await downloads()).toEqual([]);
    } finally {
      await popup.close().catch(() => undefined);
      await page.close();
    }
  });

  test("a route change inside the page: only the new route's video is listed and saved", async () => {
    const page = await open("spa");
    try {
      await expect.poll(async () => (await scan(page)).descriptors.map(mediaPath)).toEqual(["/direct/clip.webm"]);
      await page.evaluate(() => (window as unknown as { go(n: number): void }).go(2));
      // Before anyone looks again: the toolbar count and the list follow the new route by themselves. What the look
      // on the first route found the player holding is not counted next to the new video.
      await expect.poll(async () => listedAs(await view(page)).cards).toEqual([["/low/clip.webm"]]);
      await expect.poll(() => badge(page)).toBe("1");
      await expect.poll(async () => (await scan(page)).descriptors.map(mediaPath)).toEqual(["/low/clip.webm"]);
      expect(await badge(page)).toBe("1");
      await altS(page, 320, 180);
      await expectSaved(page, LOW);
      // A same-document navigation through the Navigation API is a route change too.
      await page.evaluate(() => (window as unknown as { navigateTo(n: number): Promise<unknown> }).navigateTo(3));
      await expect.poll(async () => {
        const after = await scan(page);
        return mediaPath(after.descriptors.find(item => item.id === after.selection?.mainId) ?? after.descriptors[0]!);
      }).toBe("/direct/clip.webm");
    } finally { await page.close(); }
  });

  test("Save on the popup's main card after the page changed its own address saves that card, and every answer names the page as it is now", async () => {
    const page = await open("player-webm");
    try {
      const opened = page.url();
      const tabId = await tabIdOf(page);
      const before = await scan(page);
      expect(before.pageUrl).toBe(opened);
      const ids = before.selection!.cards[0]!.ids;
      // The popup stays open on the address it read when it opened. The page moves its own address on, as a feed or a player does.
      await page.evaluate(() => history.pushState({}, "", "?t=5"));
      const send = (message: object) => probe.evaluate(msg => chrome.runtime.sendMessage(msg), message) as Promise<View>;
      const saved = await send({ type: "download-page", tabId, pageUrl: opened, ids });
      expect(saved.notSaved).toBeUndefined();
      expect(saved.pageUrl).toBe(page.url());
      expect((await savedFromPopup()).equals(fixtureBytes(CLIP))).toBe(true);
      // A place inside the same page is the same page, also without a card to go by.
      await probe.evaluate(() => chrome.downloads.erase({}));
      await page.evaluate(() => { location.hash = "chapter-2"; });
      const fragment = await send({ type: "download-page", tabId, pageUrl: page.url().replace(/#.*/, ""), allowRepeat: true });
      expect(fragment.notSaved).toBeUndefined();
      expect((await savedFromPopup()).equals(fixtureBytes(CLIP))).toBe(true);
      // Another page than the tab shows, and no card of it left: nothing is saved, and the answer says why.
      await probe.evaluate(() => chrome.downloads.erase({}));
      const stale = await send({ type: "download-page", tabId, pageUrl: `${new URL(opened).origin}/page/elsewhere.html`, allowRepeat: true });
      expect(stale.notSaved).toBe("page-changed");
      expect(await downloads()).toEqual([]);
    } finally { await page.close(); }
  });

  for (const scenario of ["shadow-open", "shadow-closed"] as const) {
    test(`a player inside a ${scenario.replace("shadow-", "")} shadow root is the main video, with its preview, and Alt+S saves it`, async () => {
      const page = await open(scenario);
      const popup = await popupFor(page);
      try {
        await expect(popup.getByTestId("main-badge")).toHaveCount(1);
        await expect(popup.getByTestId("preview-thumb")).toHaveCount(1);
        expect((await view(page)).selection).toMatchObject({ state: "ready", elementMain: true });
        await popup.close();
        await altS(page, 320, 180);
        await expectSaved(page, CLIP);
      } finally {
        await popup.close().catch(() => undefined);
        await page.close();
      }
    });
  }

  for (const [scenario, x, y, fixture] of [["srcdoc-player", 320, 180, CLIP], ["about-blank-player", 320, 180, LOW], ["nested-frames", 340, 200, CLIP]] as const) {
    test(`a player in a ${scenario.replace("-player", "")} frame is found as the main video, and Alt+S over it saves it`, async () => {
      const page = await open(scenario);
      const popup = await popupFor(page);
      try {
        await expect(popup.getByTestId("main-badge")).toHaveCount(1);
        await expect(popup.getByRole("button", { name: /save/i })).toHaveCount(1);
        await popup.close();
        await altS(page, x, y);
        await expectSaved(page, fixture);
      } finally {
        await popup.close().catch(() => undefined);
        await page.close();
      }
    });
  }

  test("asking what the browser could play, and attaching keys to a clear video, protect nothing: the video is saved", async () => {
    for (const [scenario, flag] of [["eme-probe", "__probed"], ["eme-attached", "__attached"]] as const) {
      // Both pages play the same file: a new session, so the second save is not held for a repeat-save answer.
      await probe.evaluate(async () => { await chrome.storage.session.clear(); await chrome.downloads.erase({}); });
      const page = await open(scenario);
      const popup = await popupFor(page);
      try {
        const state = await page.waitForFunction(name => {
          const win = window as unknown as Record<string, unknown>;
          return win[name] === true ? "ok" : typeof win.__emeError === "string" ? `error: ${win.__emeError}` : false;
        }, flag);
        test.skip(String(await state.jsonValue()).startsWith("error") && scenario === "eme-attached", "this browser has no ClearKey for WebM");
        await expect(popup.getByRole("button", { name: /save/i })).toHaveCount(1);
        await expect(popup.getByTestId("drm-card")).toHaveCount(0);
        expect((await view(page)).descriptors.filter(item => item.drm)).toEqual([]);
        await popup.close();
        await altS(page, 320, 180);
        await expectSaved(page, CLIP);
      } finally {
        await popup.close().catch(() => undefined);
        await page.close();
      }
    }
  });

  test("a licence request through the player's keys marks that player protected: Not saved, never Nothing to save", async () => {
    const page = await open("eme-keyed");
    const state = await page.waitForFunction(() => {
      const win = window as unknown as { __requested?: boolean; __emeError?: string };
      return win.__requested ? "ok" : win.__emeError ? `error: ${win.__emeError}` : false;
    });
    test.skip(String(await state.jsonValue()).startsWith("error"), `this browser has no ClearKey for WebM: ${await state.jsonValue()}`);
    const popup = await popupFor(page);
    try {
      await expect(popup.getByTestId("drm-card")).toHaveCount(1);
      const shown = await view(page);
      expect(shown.selection?.state).toBe("protected");
      expect(shown.descriptors.filter(item => item.drm)).toHaveLength(1);
      await popup.close();
      await altS(page, 320, 180);
      await expect(toastLabel(page)).toHaveText("Not saved");
      expect(await downloads()).toEqual([]);
    } finally {
      await popup.close().catch(() => undefined);
      await page.close();
    }
  });

  test("metadata that names an embed page is no error next to the working player in the frame", async () => {
    const page = await open("og-embed");
    const popup = await popupFor(page);
    try {
      await expect(popup.getByRole("button", { name: /save/i })).toHaveCount(1);
      await expect(popup.getByText("Unavailable sources")).toHaveCount(0);
      const shown = await view(page);
      expect(shown.failures ?? []).toEqual([]);
      expect(shown.descriptors.map(mediaPath)).toEqual(["/direct/clip.webm"]);
    } finally {
      await popup.close();
      await page.close();
    }
  });

  test("a live stream is labelled and has no Save; Alt+S saves the finished video next to it", async () => {
    const page = await open("live-and-vod");
    await page.waitForFunction(() => (window as unknown as { __liveFetched?: boolean }).__liveFetched === true);
    const popup = await popupFor(page);
    try {
      await expect.poll(async () => (await view(page)).selection?.cards.map(card => card.live)).toEqual([false, true]);
      await popup.getByText(/Other media/).click();
      await expect(popup.getByTestId("live-badge")).toHaveCount(1);
      await expect(popup.getByTestId("live-card")).toBeVisible();
      await expect(popup.getByRole("button", { name: /save/i })).toHaveCount(1);
      await popup.close();
      await altS(page, 320, 180);
      await expectSaved(page, CLIP);
    } finally {
      await popup.close().catch(() => undefined);
      await page.close();
    }
  });

  test("a page that fetches a whole video file and plays it from memory: the popup lists it as the main video, and Alt+S saves the file", async () => {
    const page = await open("fetch-blob");
    try {
      await playing(page, "#v");
      expect(await page.evaluate(() => (document.getElementById("v") as HTMLVideoElement).currentSrc.startsWith("blob:"))).toBe(true);
      // The look at the page that opening the popup takes finds the file the script fetched.
      const shown = await scan(page);
      expect(shown.descriptors.map(mediaPath)).toEqual(["/direct/clip.mp4"]);
      expect(shown.selection).toMatchObject({ state: "ready", elementMain: true });
      expect(shown.failures ?? []).toEqual([]);
      const popup = await popupFor(page);
      await expect(popup.locator("[data-main]").getByRole("button", { name: "Save", exact: true })).toHaveCount(1, { timeout: 20_000 });
      await expect(popup.getByText("No media detected on this page.")).toHaveCount(0);
      await popup.close();
      // Alt+S over the playing video saves the same bytes the page fetched.
      await altS(page, 320, 180);
      expect((await savedFile(page)).equals(fixtureBytes("direct/clip.mp4")), "the saved file is the file the page fetched").toBe(true);
      expect(await downloads()).toHaveLength(1);
    } finally { await page.close(); }
  });

  test("Alt+S right after such a page starts playing, before any popup was opened, saves the file with one press", async () => {
    const page = await open("fetch-blob");
    try {
      await playing(page, "#v");
      await altS(page, 320, 180);
      expect((await savedFile(page)).equals(fixtureBytes("direct/clip.mp4")), "the saved file is the file the page fetched").toBe(true);
    } finally { await page.close(); }
  });

  test("a player that is fed piece by piece without a playlist: its init section and fragments are looked at once and never listed", async () => {
    const page = await open("mse-pieces");
    try {
      await page.waitForFunction(() => (window as unknown as { __piecesFetched?: boolean }).__piecesFetched === true);
      const own = async () => (await requests()).filter(request => request.path.startsWith("/hls-fmp4-mp4/") && request.page !== "pieces").map(request => request.path).sort();
      expect(await own()).toEqual([]);
      const shown = await scan(page);
      expect(shown.descriptors).toEqual([]);
      expect(shown.failures ?? []).toEqual([]);
      // One check each, of the first bytes. They are parts of a stream, so nothing is listed.
      expect(await own()).toEqual(["/hls-fmp4-mp4/title-init.mp4", "/hls-fmp4-mp4/title-part-1.mp4", "/hls-fmp4-mp4/title-part-2.mp4"]);
      // Looking again, and pressing Alt+S, asks about none of them a second time and saves nothing.
      expect((await scan(page)).descriptors).toEqual([]);
      await altS(page, 320, 180);
      await expect(toastLabel(page)).not.toHaveText("", { timeout: 20_000 });
      await expect(toastLabel(page)).not.toHaveText(/Saving|Saved/);
      expect(await own()).toHaveLength(3);
      expect(await downloads()).toEqual([]);
      expect((await view(page)).descriptors).toEqual([]);
    } finally { await page.close(); }
  });

  test("MediaSource feed: each post is matched to its own stream, and Alt+S over a post starts that post's stream", async () => {
    const page = await open("mse-feed");
    try {
      test.skip(!await page.evaluate(() => (window as unknown as { __mse: boolean }).__mse), "this browser cannot append WebM VP8 to a MediaSource");
      await page.waitForFunction(() => {
        const win = window as unknown as { __feedReady?: boolean; __feedError?: string };
        return win.__feedReady === true || typeof win.__feedError === "string";
      });
      test.skip(await page.evaluate(() => typeof (window as unknown as { __feedError?: string }).__feedError === "string"), "the MediaSource fixture could not append its clip");
      await expect.poll(async () => (await scan(page)).descriptors.length).toBe(3);
      const first = await scan(page);
      // The post in view is the main video, by its own duration. Document order is never used.
      expect(mediaPath(first.descriptors.find(item => item.id === first.selection?.mainId)!)).toBe("/feed/1/media.m3u8");
      expect(first.selection).toMatchObject({ state: "ready", elementMain: true });
      await page.locator("#p2").scrollIntoViewIfNeeded();
      const box = (await page.locator("#p2").boundingBox())!;
      await altS(page, box.x + 100, box.y + 100);
      await expect(toastLabel(page)).toHaveText(/Saving|Saved/, { timeout: 20_000 });
      const shown = await view(page);
      const startedIds = Object.keys(shown.statuses ?? {});
      expect(startedIds).toHaveLength(1);
      expect(mediaPath(shown.descriptors.find(item => item.id === startedIds[0])!)).toBe("/feed/2/media.m3u8");
    } finally { await page.close(); }
  });

  test("an HLS interstitial asset is listed under Ads once the page's own player loaded it, and requested by savemedia only when the user saves it", async () => {
    const page = await open("hls-interstitial");
    let popup: Page | undefined;
    try {
      await page.waitForFunction(() => (window as unknown as { __assetFetched?: boolean }).__assetFetched === true);
      await expect.poll(async () => listedAs(await view(page)).ads, { message: "the asset the player loaded should be listed as an ad" })
        .toEqual([["/ads/asset/media.m3u8"]]);
      const shown = await scan(page);
      expect(listedAs(shown)).toEqual({ cards: [["/hls-interstitial/media.m3u8"]], ads: [["/ads/asset/media.m3u8"]] });
      expect(await badge(page)).toBe("1");
      const asset = (await requests()).filter(request => request.path.startsWith("/ads/asset/"));
      expect(asset.length).toBeGreaterThan(0);
      expect(asset.filter(request => request.page !== "player")).toEqual([]);

      // The user's own Save of the ad: its playlist is read now, and the stream is saved as a video file.
      popup = await popupFor(page);
      const ads = popup.getByTestId("ads");
      await expect(ads.locator(":scope > summary")).toHaveText("Ads (1)");
      await ads.locator(":scope > summary").click();
      await ads.getByRole("button", { name: "Save", exact: true }).click();
      expect((await savedFromPopup()).subarray(4, 8).toString()).toBe("ftyp");
      expect((await requests()).filter(request => request.path.startsWith("/ads/asset/") && request.page !== "player").length).toBeGreaterThan(0);
    } finally {
      await popup?.close().catch(() => undefined);
      await page.close();
    }
  });

  test("a page restored from the back-forward cache lists its video again", async () => {
    // The test runner starts every browser with the back-forward cache switched off, so this test has a
    // browser of its own that keeps it. A page that is not restored fails the test: a skip would hide it.
    const own = await launchExtension({ name: "main-video-bfcache", baseURL: base, viewport: { width: 1280, height: 800 },
      ignoreDefaultArgs: ["--disable-back-forward-cache"] });
    try {
      const extensionPage = await own.context.newPage();
      await extensionPage.goto(own.popupUrl);
      const listed = async (page: Page) => {
        const tabId = await findTabId(extensionPage, page.url());
        const shown = await extensionPage.evaluate(id => chrome.runtime.sendMessage({ type: "list", tabId: id }), tabId) as View;
        return shown.descriptors.map(mediaPath);
      };
      const page = await own.context.newPage();
      await page.bringToFront();
      await page.goto("/page/webm.html");
      await page.waitForLoadState("networkidle");
      await expect.poll(() => listed(page)).toEqual(["/direct/clip.webm"]);
      await page.evaluate(() => addEventListener("pageshow", event => { (window as unknown as { __persisted: boolean }).__persisted = (event as PageTransitionEvent).persisted; }));
      await page.goto("/page/negative.html");
      await expect.poll(() => listed(page), { message: "the other page has no video" }).toEqual([]);
      // A restore fires no load event, so the step back waits for the navigation alone.
      await page.goBack({ waitUntil: "commit" });
      await page.waitForFunction(() => (window as unknown as { __persisted?: boolean }).__persisted !== undefined);
      expect(await page.evaluate(() => (window as unknown as { __persisted?: boolean }).__persisted), "the page should come back from the back-forward cache").toBe(true);
      expect(new URL(page.url()).pathname).toBe("/page/webm.html");
      await expect.poll(() => listed(page)).toEqual(["/direct/clip.webm"]);
      expect(own.workerErrors, "errors the extension logged in its service worker").toEqual([]);
    } finally { await own.close(); }
  });

  test("a video in fullscreen is the main video over a larger one on the page", async () => {
    const page = await context!.newPage();
    try {
      await page.bringToFront();
      await page.goto("/page/webm.html");
      // The browser's own controls take a click on the video, so the page has a button for fullscreen.
      await page.evaluate(local => {
        const extra = document.createElement("video");
        extra.id = "small";
        extra.src = local;
        extra.width = 160;
        extra.height = 90;
        extra.controls = true;
        const full = document.createElement("button");
        full.id = "full";
        full.textContent = "Fullscreen";
        full.addEventListener("click", () => { void extra.requestFullscreen(); });
        document.body.append(extra, full);
      }, "/low/clip.webm");
      const before = await scan(page);
      expect(mediaPath(before.descriptors.find(item => item.id === before.selection?.mainId)!), "the larger video is the main one before fullscreen").toBe("/direct/clip.webm");
      await page.locator("#full").click();
      await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null), { message: "the small video should be in fullscreen" }).toBe("small");
      const shown = await scan(page);
      expect(mediaPath(shown.descriptors.find(item => item.id === shown.selection?.mainId)!)).toBe("/low/clip.webm");
    } finally { await page.close(); }
  });
});

function readdirNames(dir: string): string[] {
  // Chrome keeps no partial files for a save that never started.
  return existsSync(dir) ? readdirSync(dir).filter(name => !name.startsWith(".")) : [];
}
