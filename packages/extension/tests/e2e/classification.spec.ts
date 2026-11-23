import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchExtension, watchExtensionPages, type ExtensionSession } from "./extension-browser";
import { TOAST, downloadRequest, popupFor, saveAndWait, tabIdOf, toastCard, toastDetail, toastLabel } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureBaseURL = `http://127.0.0.1:${process.env.SAVEMEDIA_FIXTURE_PORT ?? 5174}`;

/**
 * End-to-end classification: load the unpacked Chrome extension into a
 * persistent context, visit each fixture page, and verify the background
 * service worker classified the captured media correctly.
 *
 * **Reading extension state from tests.** The fixture pages are ordinary
 * web pages, so they cannot call chrome.runtime. The test opens the real
 * popup HTML and asks the background service worker through the same
 * chrome.runtime message path the popup uses in production.
 */

type SegmentRef =
  | { kind: "direct"; url: string }
  | { kind: "byte-range"; url: string }
  | { kind: "hls-segments"; playlistUrl: string; initSegmentUrl: string | null; segmentUrls: string[] }
  | { kind: "dash-segments"; initUrl: string; mediaUrls: string[] };

interface Descriptor {
  id: string;
  protocol: string;
  container: string;
  pageUrl: string;
  variants: Array<{
    id: string;
    height: number | null;
    bitrate: number | null;
    audioRenditionId: string | null;
    segmentRef: SegmentRef;
  }>;
  audioRenditions?: Array<{ id: string; audioRenditionId: string | null; segmentRef: SegmentRef }>;
  drm: null | { reason: string };
  capabilities: { directDownload: boolean };
}

test.describe("extension classifies real fixture pages", () => {
  // Both describes drive an unpacked Chromium extension via the chromium
  // module directly. The firefox playwright project must skip them so it
  // doesn't try to launch a Chromium binary it hasn't installed.
  test.skip(({ browserName }) => browserName !== "chromium", "chromium-only suite");

  let runtime: ExtensionSession | undefined;
  let context: BrowserContext | undefined;
  let probe: Page | undefined;
  let downloadDir: string | undefined;
  let pageErrors: string[] = [];
  /** Where the tests join fixture segments into the file a saved one is compared with. */
  let sourceDir: string | undefined;

  test.beforeAll(async ({ browserName }) => {
    // The describe-level test.skip() skips individual tests but Playwright
    // still runs the hooks; guard the chromium launch so the firefox
    // project doesn't try to spawn a binary it never installed.
    if (browserName !== "chromium") return;
    // Every saved file is decoded and compared with its source. Without the
    // tools that check would be skipped, so the suite stops here instead.
    for (const tool of ["ffmpeg", "ffprobe"]) {
      try { execFileSync(tool, ["-version"], { stdio: "ignore" }); }
      catch { throw new Error(`${tool} not found. These tests decode every saved file with it: install ffmpeg (it brings ffprobe) and run again.`); }
    }
    sourceDir = mkdtempSync(resolve(tmpdir(), "savemedia-sources-"));
    runtime = await launchExtension({ name: "classification", baseURL: fixtureBaseURL });
    pageErrors = watchExtensionPages(runtime, ["console", "pageerror"]);
    context = runtime.context;
    downloadDir = runtime.downloadDir;
    probe = await context.newPage();
    await probe.goto(runtime.popupUrl);
    await expect(probe.locator("header")).toContainText("savemedia");
    // Playwright names every download with a random id. The name is part of
    // what a save promises, so the browser keeps its own: the files then
    // arrive in the profile's download folder (set above) under the names
    // savemedia asked for.
    await (await context.newCDPSession(probe)).send("Browser.setDownloadBehavior", { behavior: "default" });
  });

  test.beforeEach(async () => {
    // This describe shares a disposable profile. Each scenario starts a new
    // SaveMedia session so saves in earlier scenarios cannot prompt this one,
    // with no earlier download in the browser's list and no earlier file in
    // the folder: a name can then only belong to the scenario that asked for it.
    await probe!.evaluate(() => chrome.storage.session.clear());
    await forgetDownloads();
  });

  test.afterEach(() => {
    expect(pageErrors.splice(0), "fatal console/page errors emitted by extension pages").toEqual([]);
    expect(runtime?.workerErrors.splice(0) ?? [], "errors the extension logged in its service worker").toEqual([]);
  });

  test.afterAll(async () => {
    await probe?.close();
    await runtime?.close();
    if (sourceDir) rmSync(sourceDir, { recursive: true, force: true });
  });

  async function descriptorsForUrlContaining(marker: string): Promise<Descriptor[]> {
    return await probe!.evaluate(async (m: string) => {
      const tabs = await chrome.tabs.query({});
      const matches = tabs.filter(t => t.id && t.url?.includes(m));
      const descriptors: Descriptor[] = [];
      for (const tab of matches) {
        const response = await new Promise<{ descriptors?: Descriptor[] } | undefined>(resolve =>
          chrome.runtime.sendMessage({ type: "list", tabId: tab.id }, resolve),
        );
        descriptors.push(...(response?.descriptors ?? []));
      }
      return descriptors;
    }, marker);
  }

  async function waitForDescriptors(scenario: string, predicate: (d: Descriptor[]) => boolean): Promise<Descriptor[]> {
    const marker = `/page/${scenario}.html`;
    const page = await context!.newPage();
    try {
      await page.goto(marker);
      await page.waitForLoadState("networkidle");
      for (let attempt = 0; attempt < 20; attempt++) {
        const descriptors = await descriptorsForUrlContaining(marker);
        if (predicate(descriptors)) return descriptors;
        await page.waitForTimeout(250);
      }
      return descriptorsForUrlContaining(marker);
    } finally {
      await page.close();
    }
  }

  async function openFixtureAndWait(scenario: string, predicate: (d: Descriptor[]) => boolean): Promise<Page> {
    const marker = `/page/${scenario}.html`;
    const page = await context!.newPage();
    await page.bringToFront();
    await page.goto(marker);
    await page.waitForLoadState("networkidle");
    for (let attempt = 0; attempt < 30; attempt++) {
      if (predicate(await descriptorsForUrlContaining(marker))) return page;
      await page.waitForTimeout(250);
    }
    throw new Error(`${scenario} did not produce expected descriptors: ${JSON.stringify(await descriptorsForUrlContaining(marker))}`);
  }

  /** Empties the browser's download list and the download folder. */
  async function forgetDownloads(): Promise<void> {
    await probe!.evaluate(() => chrome.downloads.erase({}));
    for (const name of readdirSync(downloadDir!)) rmSync(resolve(downloadDir!, name), { recursive: true, force: true });
  }

  /**
   * The one completed download whose place in the download folder passes
   * `named`. Nothing else counts: not another completed download, and not
   * the same bytes under another name.
   */
  async function completedDownload(named: (pathInFolder: string) => boolean, wanted: string): Promise<string> {
    const folder = realpathSync(downloadDir!);
    let last: unknown[] = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      const items = await probe!.evaluate(async () => (await chrome.downloads.search({ orderBy: ["-startTime"], limit: 20 }))
        .map(item => ({ filename: item.filename, state: item.state, error: item.error, exists: item.exists })));
      last = items;
      const files = items.filter(item => item.state === "complete" && existsSync(item.filename))
        .map(item => realpathSync(item.filename)).filter(file => named(relative(folder, file)));
      if (files.length > 1) throw new Error(`more than one completed download is ${wanted}: ${JSON.stringify(files)}`);
      if (files[0]) return files[0];
      await probe!.waitForTimeout(500);
    }
    throw new Error(`no completed download is ${wanted}; the browser's downloads: ${JSON.stringify(last)}`);
  }

  /** A file the page offers is saved under the name the save asked for, in the download folder itself. */
  const savedFile = (name: string) => completedDownload(path => path === name, `named ${JSON.stringify(name)}`);

  /**
   * A stream savemedia puts together has no file name of its own. It is
   * named by the clock at save time, in a folder for the day and the part of
   * the day (util/filename timestampedPath); of the name the save asked for,
   * only the extension is used.
   */
  const STREAM_SAVE_PATH = /^\d{4}-\d{2}-\d{2} [1-4] (?:Night|Morning|Afternoon|Evening)\/\d{4}-\d{2}-\d{2}_\d{6}\.([a-z0-9]+)$/;
  const savedStream = (extension: "mp4" | "ts") =>
    completedDownload(path => STREAM_SAVE_PATH.exec(path)?.[1] === extension, `a stream save ending in .${extension}`);

  const fixtureBytes = (...path: string[]): Buffer => readFileSync(resolve(here, "media-fixtures", ...path));

  /**
   * Fixture files joined in the given order into one file a decoder reads: a
   * track's init section and its segments, or the segments of a playlist.
   * This is what the server handed out, in the order its manifest states.
   */
  function joined(dir: string, names: readonly string[]): string {
    const file = resolve(sourceDir!, `${dir}-${names.map(name => name.replace(/\W/g, "")).join("-")}.${names[0]!.split(".").pop()}`);
    writeFileSync(file, Buffer.concat(names.map(name => fixtureBytes(dir, name))));
    return file;
  }

  function md5(file: string, stream: readonly string[]): string {
    return execFileSync("ffmpeg", ["-v", "error", "-i", file, ...stream, "-f", "md5", "-"], { encoding: "utf8" }).trim();
  }
  /** One hash over every decoded picture of the video stream, in order, none added and none dropped. */
  const pictures = (file: string) => md5(file, ["-map", "0:v:0", "-fps_mode", "passthrough"]);
  /** One hash over every decoded sample of the audio stream. */
  const audioSamples = (file: string) => md5(file, ["-map", "0:a:0"]);
  /** One hash over every encoded audio packet as the container stores it. */
  const audioPackets = (file: string) => md5(file, ["-map", "0:a:0", "-c", "copy"]);

  interface MediaFacts {
    readonly format: string;
    readonly seconds: number;
    /** `frames`: what a decoder produces. `packets`: what the container stores. */
    readonly streams: readonly { readonly type: string; readonly codec: string; readonly frames: number; readonly packets: number }[];
  }

  function mediaFacts(file: string): MediaFacts {
    const parsed = JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-count_frames", "-count_packets",
      "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,nb_read_frames,nb_read_packets",
      "-of", "json", file,
    ], { encoding: "utf8" })) as { format?: { format_name?: string; duration?: string };
      streams?: { codec_type?: string; codec_name?: string; nb_read_frames?: string; nb_read_packets?: string }[] };
    return {
      format: parsed.format?.format_name ?? "",
      seconds: Number(parsed.format?.duration ?? 0),
      streams: (parsed.streams ?? []).map(stream => ({ type: stream.codec_type ?? "", codec: stream.codec_name ?? "",
        frames: Number(stream.nb_read_frames ?? 0), packets: Number(stream.nb_read_packets ?? 0) })),
    };
  }

  /**
   * The saved MP4 holds the source's media and nothing else: one video
   * stream with every picture of the source, identical and in order, the
   * source's audio, and the source's length. A missing, repeated or swapped
   * segment, another quality, a cut file or undecrypted bytes all fail here.
   *
   * `audio` says how the audio is compared. "samples": decoded, for a source
   * in a transport stream, whose packets an MP4 stores in another form.
   * "packets": the encoded packets themselves, for MP4 sources; decoding is
   * no measure there, because the source's fragments and the saved file
   * state the encoder's lead-in differently. "none": the source has no
   * audio and neither has the file.
   */
  function expectSameMedia(saved: string, source: { readonly video: string; readonly audio?: string }, audio: "samples" | "packets" | "none"): void {
    const got = mediaFacts(saved);
    const only = (facts: MediaFacts, type: string, count: "frames" | "packets") =>
      facts.streams.filter(stream => stream.type === type).map(stream => ({ codec: stream.codec, [count]: stream[count] }));
    expect(got.format, `container of ${basename(saved)}`).toMatch(/mp4/);
    expect(only(got, "video", "frames"), "video streams").toEqual(only(mediaFacts(source.video), "video", "frames"));
    expect(only(got, "video", "frames")).toHaveLength(1);
    expect(pictures(saved), "decoded pictures").toBe(pictures(source.video));
    let seconds = mediaFacts(source.video).seconds;
    if (audio === "none") {
      expect(only(got, "audio", "packets"), "audio streams").toEqual([]);
    } else {
      const from = mediaFacts(source.audio ?? source.video);
      const count = audio === "samples" ? "frames" : "packets";
      expect(only(got, "audio", count), "audio streams").toEqual(only(from, "audio", count));
      expect(only(got, "audio", count)).toHaveLength(1);
      if (audio === "samples") expect(audioSamples(saved), "decoded audio").toBe(audioSamples(source.audio ?? source.video));
      else expect(audioPackets(saved), "audio packets").toBe(audioPackets(source.audio ?? source.video));
      seconds = Math.max(seconds, from.seconds);
    }
    expect(got.streams, "nothing but the video and its audio").toHaveLength(audio === "none" ? 1 : 2);
    expect(Math.abs(got.seconds - seconds), `length ${got.seconds}s against the source's ${seconds}s`).toBeLessThan(0.1);
  }

  function probeStreams(file: string): Array<{ codec_type?: string; codec_name?: string }> {
    const raw = execFileSync("ffprobe", [
      "-v", "error",
      "-show_entries", "stream=codec_type,codec_name",
      "-of", "json",
      file,
    ], { encoding: "utf8" });
    return (JSON.parse(raw) as { streams?: Array<{ codec_type?: string; codec_name?: string }> }).streams ?? [];
  }

  /** The quality a save of this stream asks for: the tallest, and among equals the one with the highest bit rate. */
  function bestVariant(descriptor: Descriptor): { variantId: string | null; audioRenditionId: string | null } {
    const [variant] = [...(descriptor.variants ?? [])].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0));
    return { variantId: variant?.id ?? null, audioRenditionId: variant?.audioRenditionId ?? null };
  }

  /** Asks for a save and returns once the background has answered the request, while the save runs. */
  async function startDescriptorDownload(descriptor: Descriptor, filename: string): Promise<void> {
    await probe!.evaluate(request => chrome.runtime.sendMessage(request), downloadRequest(descriptor.id, filename, bestVariant(descriptor)));
  }

  /** Asks for a save that must fail, and returns the code of its failure. */
  async function startDescriptorDownloadExpectFailure(descriptor: Descriptor, filename: string): Promise<string> {
    const outcome = await saveAndWait(probe!, descriptor.id, filename, { ...bestVariant(descriptor), timeout: 25_000 });
    if (outcome.type !== "job-failed") throw new Error(`The save of ${filename} should have failed, and ended as ${outcome.type}.`);
    return outcome.error.code;
  }

  test("direct MP4 fixture produces a progressive-http descriptor with directDownload", async () => {
    const descriptors = await waitForDescriptors("direct", ds => ds.some(d => d.protocol === "progressive-http"));
    const direct = descriptors.find(d => d.protocol === "progressive-http");
    expect(direct, `got ${JSON.stringify(descriptors)}`).toBeDefined();
    expect(direct?.capabilities.directDownload).toBe(true);
    expect(direct?.drm).toBeNull();
  });

  test("HLS master fixture produces an hls descriptor", async () => {
    const descriptors = await waitForDescriptors("hls", ds => ds.some(d => d.protocol === "hls"));
    const hls = descriptors.find(d => d.protocol === "hls");
    expect(hls, `got ${JSON.stringify(descriptors)}`).toBeDefined();
    expect(hls?.drm).toBeNull();
  });

  test("HLS fMP4 fixture ignores init/fragment requests as standalone videos", async () => {
    const descriptors = await waitForDescriptors("hls-fmp4", ds => ds.some(d => d.protocol === "hls"));
    const hls = descriptors.find(d => d.protocol === "hls");
    expect(hls, `got ${JSON.stringify(descriptors)}`).toBeDefined();
    expect(descriptors.filter(d => d.protocol === "progressive-http")).toHaveLength(0);
  });

  test("HLS fMP4 .mp4-named fragments are not surfaced as standalone videos", async () => {
    const descriptors = await waitForDescriptors("hls-fmp4-mp4", ds => ds.some(d => d.protocol === "hls"));
    const hls = descriptors.find(d => d.protocol === "hls");
    expect(hls, `got ${JSON.stringify(descriptors)}`).toBeDefined();
    expect(descriptors.filter(d => d.protocol === "progressive-http")).toHaveLength(0);
  });

  test("DASH MPD fixture produces a dash descriptor", async () => {
    const descriptors = await waitForDescriptors("dash", ds => ds.some(d => d.protocol === "dash"));
    const dash = descriptors.find(d => d.protocol === "dash");
    expect(dash, `got ${JSON.stringify(descriptors)}`).toBeDefined();
  });

  test("widevine MPD is classified as DRM-blocked with reason cdm_required", async () => {
    const descriptors = await waitForDescriptors("widevine", ds => ds.some(d => d.drm?.reason === "cdm_required"));
    const drm = descriptors.find(d => d.drm?.reason === "cdm_required");
    expect(drm, `got ${JSON.stringify(descriptors)}`).toBeDefined();
    expect(drm?.capabilities.directDownload).toBe(false);
  });

  test("clearkey MPD surfaces clearkey_deferred (distinct from cdm_required)", async () => {
    const descriptors = await waitForDescriptors("clearkey", ds => ds.some(d => d.drm?.reason === "clearkey_deferred"));
    const ck = descriptors.find(d => d.drm?.reason === "clearkey_deferred");
    expect(ck, `got ${JSON.stringify(descriptors)}`).toBeDefined();
    expect(ck?.capabilities.directDownload).toBe(false);
  });

  test("negative page produces zero descriptors (no .jpg/.css/.js mis-classified as media)", async () => {
    const marker = "/page/negative.html";
    const page = await context!.newPage();
    try {
      await page.goto(marker);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1_500);
      const descriptors = await descriptorsForUrlContaining(marker);
      expect(descriptors.filter(d => d.pageUrl.includes("/page/negative.html"))).toHaveLength(0);
    } finally {
      await page.close();
    }
  });

  test("content bridge reports the HLS addresses a page declares in its data before playback starts", async () => {
    const page = await context!.newPage();
    try {
      await page.goto("/page/embedded-hls.html");
      await page.waitForLoadState("networkidle");

      const response = await probe!.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const fixture = tabs.find(t => t.url?.includes("/page/embedded-hls.html"));
        if (!fixture?.id) return { ok: false, groups: [] as string[][] };
        const facts = await chrome.tabs.sendMessage(fixture.id, { type: "collect-facts", pointer: false, thumbnails: false }, { frameId: 0 }) as
          { pageGroups?: { sources: { url: string }[] }[] } | undefined;
        return { ok: true, groups: (facts?.pageGroups ?? []).map(group => group.sources.map(source => new URL(source.url).pathname)) };
      });

      expect(response.ok).toBe(true);
      // Nested alternatives of one stream are one group, read without a key name list.
      expect(response.groups).toEqual([["/hls/master.m3u8", "/hls-fmp4/master.m3u8"]]);
    } finally {
      await page.close();
    }
  });

  test("keeps only main player quality options when a page has 20 previews", async () => {
    const page = await context!.newPage();
    let popup: Page | undefined;
    try {
      await page.goto("/page/main-player-qualities.html");
      await page.waitForLoadState("networkidle");
      const tabId = await tabIdOf(probe!, page.url());
      popup = await popupFor(runtime!, tabId);
      const select = popup.getByRole("combobox");
      await expect(select).toHaveCount(1);
      // Each quality says what it costs in bytes, from the length its server declared.
      await expect(select.locator("option")).toHaveText([/^720p · \d+(\.\d+)? (KB|MB)$/, /^480p · \d+(\.\d+)? (KB|MB)$/]);
      await expect(popup.getByRole("button", { name: /^save$/i })).toHaveCount(1);
      await expect.poll(async () => (await descriptorsForUrlContaining("/page/main-player-qualities.html")).length).toBe(2);
      // One video in two qualities is one card, and the toolbar badge counts cards: the badge is the only count there is.
      await expect.poll(() => probe!.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe("1");
      await expect(popup.locator("footer")).not.toContainText(/detected/);
      await expect(popup.getByTestId("conscience-line")).toHaveText("Save only what you have the right to keep.");
      expect(await page.locator("video").evaluateAll(videos => videos.every(video => (video as HTMLVideoElement).paused))).toBe(true);
      // The twenty hidden previews and the preview links were never requested, by the browser or by savemedia.
      const requests = await (await fetch(fixtureBaseURL + "/__requests")).json() as { path: string }[];
      expect(requests.filter(request => /[?&](preview|linked)=/.test(request.path))).toEqual([]);
    } finally {
      await popup?.close();
      await page.close();
    }
  });

  const openPopupFor = async (page: Page): Promise<Page> => popupFor(runtime!, await tabIdOf(probe!, page.url()));

  test("popup discovers a paused cross-origin player before its first media request", async () => {
    const page = await context!.newPage();
    let popup: Page | undefined;
    try {
      const outer = fixtureBaseURL + "/framed-video";
      const player = new URL("/video-embed", fixtureBaseURL);
      player.hostname = "localhost";
      await page.route(outer, route => route.fulfill({contentType: "text/html",
        body: `<iframe src="about:blank" hidden></iframe><iframe width="640" height="360" allowfullscreen src="${player.href}"></iframe>`}));
      await page.route(player.href, route => route.fulfill({contentType: "text/html",
        body: `<video controls preload="none" data-src="${fixtureBaseURL}/direct/clip.mp4"></video>`}));
      await page.goto(outer);
      const video = page.frameLocator("iframe[allowfullscreen]").locator("video");
      await expect(video).toBeVisible();
      popup = await openPopupFor(page);
      await expect(popup.getByRole("button", {name: /^save$/i})).toBeVisible();
      expect(await video.evaluate(node => ({paused: (node as HTMLVideoElement).paused, src: node.getAttribute("src")})))
        .toEqual({paused: true, src: null});
    } finally {
      await popup?.close();
      await page.close();
    }
  });

  test("saves the file link a named page declares from the popup and Alt+S, never pressing site controls", async () => {
    const page = await context!.newPage();
    // linked-31 declares its file with a download attribute, download-32 with a
    // plain link whose path is the named file.
    const files = [
      { page: "linked-31", name: "Test pattern 31.mov", fixture: "test-pattern.mov" },
      { page: "download-32", name: "Färbige Balken 32.mov", fixture: "color-bars.mov" },
    ];
    let popup: Page | undefined;
    try {
      for (const file of files) {
        const path = `/page/${file.page}.html`;
        await page.goto(path);
        popup = await openPopupFor(page);
        await expect(popup.getByText(file.name, { exact: true })).toHaveCount(1);
        const download = popup.getByRole("button", { name: "Save", exact: true });
        await expect(download).toHaveCount(1);
        await expect(download).toBeEnabled();
        if (file.page === "linked-31") {
          await download.click();
          await expect(popup.getByTestId("job-complete")).toBeVisible({ timeout: 20_000 });
        } else {
          await popup.close();
          popup = undefined;
          await page.bringToFront();
          await page.keyboard.press("Alt+KeyS");
          await expect(toastCard(page)).toContainText(`Saved${file.name}`);
        }
        const saved = await savedFile(file.name);
        expect(readFileSync(saved)).toEqual(fixtureBytes("direct", file.fixture));
        expect(new URL(page.url()).pathname).toBe(path);
        expect(await page.evaluate(() => (window as Window & { siteControlClicks?: number }).siteControlClicks)).toBe(0);
        await popup?.close();
        popup = undefined;
      }
      expect(await probe!.evaluate(() => chrome.downloads.search({}))).toHaveLength(2);
    } finally {
      await popup?.close();
      await page.close();
    }
  });

  test("saves original MOV files through the popup and Alt+S, using the page's own fresh source after rotation", async ({ request }) => {
    const page = await context!.newPage();
    let releaseFileInfo!: () => void;
    const fileInfo = new Promise<void>(resolve => { releaseFileInfo = resolve; });
    await page.route("**/file-info/31", async route => {
      await fileInfo;
      await route.continue();
    });
    let popup: Page | undefined;
    try {
      for (const [id, name, fixture] of [
        ["31", "Test pattern 31.mov", "test-pattern.mov"],
        ["32", "Färbige Balken 32.mov", "color-bars.mov"],
      ]) {
        await page.goto(`/page/file-${id}.html`);
        popup = await openPopupFor(page);
        if (id === "31") {
          // The page names a file its browser has not received yet. The popup says so
          // at once: nothing waits for the page, and nothing points at a site's button.
          await expect(popup.getByTestId("page-hint")).toHaveText(
            "This file has not reached your browser yet. savemedia saves it once your browser receives it.");
          await expect(popup.getByText("No media detected on this page.")).toHaveCount(0);
          await expect(popup.getByRole("button", { name: "Check page again" })).toBeEnabled();
          // Once the page receives the file, its name and Save arrive without another look at the page.
          releaseFileInfo();
        }
        await expect(popup.getByText(name!, { exact: true })).toBeVisible();
        await expect(popup.getByRole("button", { name: "Save", exact: true })).toHaveCount(1);
        const oldSource = id === "31" ? await page.locator("video").getAttribute("src") : null;
        expect((await request.post(`/file/${id}`)).status()).toBe(204);
        if (id === "31") {
          expect(oldSource).toBeTruthy();
          expect((await request.get(oldSource!)).status()).toBe(403);
          // The expired link fails plainly. savemedia opens no other tab to
          // look for a replacement; the page issues one when it reloads.
          await popup.getByRole("button", { name: "Save", exact: true }).click();
          const refused = popup.getByTestId("job-error");
          await expect(refused.getByTestId("failure-title")).toHaveText("The server refused access");
          await expect(refused.getByTestId("failure-body")).toHaveText("The server refused this file. Its link may have expired.");
          await expect(refused.getByTestId("failure-hint")).toHaveText("Reload the page, start playback, then try again.");
          // The status is a technical detail: closed until asked for, in an element of its own.
          await expect(refused.getByText("403", { exact: true })).toBeHidden();
          expect(context!.pages().filter(tab => tab.url() === page.url())).toEqual([page]);
          await popup.close();
          await page.reload();
          await expect.poll(() => page.locator("video").getAttribute("src")).not.toBe(oldSource);
          popup = await openPopupFor(page);
          await popup.getByRole("button", { name: "Save", exact: true }).click();
          await expect(popup.getByTestId("job-complete")).toBeVisible();
        } else {
          await popup.close();
          popup = undefined;
          await page.bringToFront();
          await page.keyboard.press("Alt+KeyS");
          await expect(toastCard(page)).toContainText(`Saved${name}`);
        }

        const path = await savedFile(name!);
        expect(readFileSync(path)).toEqual(fixtureBytes("direct", fixture!));
        expect(probeStreams(path)).toContainEqual({ codec_name: "h264", codec_type: "video" });
        await popup?.close();
        popup = undefined;
      }
      expect(await probe!.evaluate(() => chrome.downloads.search({ state: "complete" }))).toHaveLength(2);
    } finally {
      releaseFileInfo();
      await popup?.close();
      await page.close();
    }
  });

  for (const [scenario, response] of [["file-warning", "page"], ["file-data", "data"]] as const) {
    test(`reports ${response === "page" ? "a warning page" : "JSON"} returned during a MOV save and writes no file`, async () => {
      const page = await context!.newPage();
      let popup: Page | undefined;
      try {
        await page.goto(`/page/${scenario}.html`);
        popup = await openPopupFor(page);
        await popup.getByRole("button", { name: "Save", exact: true }).click();
        await expect(popup.getByTestId("job-error").getByTestId("failure-title")).toHaveText(
          `The server sent ${response === "page" ? "a web page" : "data"} instead of the video`);
        await expect(popup.getByTestId("job-error")).toHaveAttribute("data-tone", "unusable");
        // The hint says to reload and start playback first, so the button is the plain Save: Retry save would repeat the failure.
        await expect(popup.getByTestId("job-error").getByTestId("failure-hint")).toContainText("Reload the page, start playback, then try again.");
        await expect(popup.getByTestId("item-action")).toHaveText("Save");
        await expect(popup.getByRole("button", { name: "Retry save" })).toHaveCount(0);
        // The card's two disclosures have their own names.
        await expect(popup.getByTestId("job-error").locator("summary")).toHaveText("Technical details");
        await expect(popup.getByTestId("item-details").locator("summary")).toHaveText("About this video");
        await expect(popup.getByTestId("job-complete")).toHaveCount(0);
        expect(await probe!.evaluate(() => chrome.downloads.search({}))).toEqual([]);
      } finally {
        await popup?.close();
        await page.close();
      }
    });
  }

  test("reports certificate failures and restricted responses with certificate checks on", async () => {
    const temporary = mkdtempSync(resolve(tmpdir(), "savemedia-cert-"));
    const key = resolve(temporary, "test.key");
    const cert = resolve(temporary, "test.crt");
    const page = await context!.newPage();
    let mediaRequests = 0;
    let mediaHost = "";
    let popup: Page | undefined;
    let secureServer: ReturnType<typeof createHttpsServer> | undefined;
    const server = createHttpServer((req, res) => {
      if (req.url === "/redirect.mov") {
        res.writeHead(302, { location: "https://" + mediaHost + "/clip.mov?fixture=not-for-display" });
        res.end();
      } else if (req.url === "/restricted.mov") {
        res.writeHead(451, { "content-type": "text/html" });
        res.end("<p>Unavailable for legal reasons</p>");
      } else if (req.url === "/runtime.html") {
        // A player without a source of its own, as script players are: the page asks for the playlist itself.
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>Video fixture</title><video controls width="640" height="360"></video>
          <script>fetch("https://${mediaHost}/hls/master.m3u8").catch(() => undefined);</script>`);
      } else if (req.url === "/named-file.html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><h1>Certificate fixture.mov</h1>
          <a download href="https://${mediaHost}/clip.mov?fixture=not-for-display">Download</a>`);
      } else {
        const source = req.url === "/certificate.html" ? "/redirect.mov" : "/restricted.mov";
        res.writeHead(200, { "content-type": "text/html" });
        res.end('<!doctype html><title>Video fixture</title><video preload="none" controls src="' + source + '"></video>');
      }
    });

    try {
      // The test keeps Chromium's normal certificate checks enabled.
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
        "-keyout", key, "-out", cert], { stdio: "ignore" });
      const video = readFileSync(resolve(here, "media-fixtures/direct/test-pattern.mov"));
      secureServer = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_req, res) => {
        mediaRequests += 1;
        res.writeHead(200, { "content-type": "video/quicktime" });
        res.end(video);
      });
      await once(secureServer.listen(0, "127.0.0.1"), "listening");
      mediaHost = "127.0.0.1:" + (secureServer.address() as AddressInfo).port;
      await once(server.listen(0, "127.0.0.1"), "listening");
      const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;

      // A certificate from an authority the browser does not know is what a filter presents that sends a server
      // to its own block page, or that inspects secure connections. The browser reports no server address for
      // such a failed connection, so this text, not the local-address one, is what the user of such a filter
      // sees: it points at the filter and at the secure DNS setting. It never says to wait.
      const untrusted = { title: "Secure connection not trusted",
        hint: "Check your network filter or security software, or the secure DNS setting in your browser's settings." };
      for (const [path, title, hint, details] of [
        ["/certificate.html", untrusted.title, untrusted.hint, [mediaHost, "net::ERR_CERT_AUTHORITY_INVALID", "tls_certificate_rejected"]],
        // The player has no source, and its page's own request for the playlist failed: Alt+S says that, not "start playback".
        ["/runtime.html", untrusted.title, untrusted.hint, [mediaHost, "net::ERR_CERT_AUTHORITY_INVALID", "tls_certificate_rejected"]],
        ["/restriction.html", "Blocked for legal reasons", "Read the notice on the page, or ask your network provider.", ["451", "access_denied"]],
      ] as const) {
        await page.goto(origin + path);
        popup = await openPopupFor(page);
        const failure = popup.getByTestId("discovery-failure");
        await expect(failure.getByTestId("failure-title")).toHaveText(title);
        await expect(failure.getByTestId("failure-body")).toBeVisible();
        await expect(failure.getByTestId("failure-hint")).toHaveText(hint);
        await expect(popup.getByRole("button", { name: "Check page again" })).toBeEnabled();
        await expect(popup.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
        // Codes, statuses and the server sit behind the disclosure, each in an element of its own: an exact
        // match finds each one, and none is visible until the user opens it.
        for (const detail of details) await expect(failure.getByText(detail, { exact: true })).toBeHidden();
        await failure.getByText("Technical details", { exact: true }).click();
        for (const detail of details) await expect(failure.getByText(detail, { exact: true })).toBeVisible();
        await expect(popup.locator("main")).not.toContainText("not-for-display");
        // The failure was there when the popup opened: it is shown, not read out.
        await expect(popup.getByRole("alert")).toHaveText("");
        await popup.close();
        popup = undefined;

        await page.bringToFront();
        await page.keyboard.press("Alt+KeyS");
        const toast = toastCard(page);
        await expect(toast).toHaveText(`Not saved${title}. ${hint}`);
        expect(await probe!.evaluate(() => chrome.downloads.search({}))).toEqual([]);
      }

      // A page that names a file gets the same explanation as any other page, from the popup and from Alt+S.
      await page.goto(origin + "/named-file.html");
      popup = await openPopupFor(page);
      await popup.getByRole("button", { name: "Save", exact: true }).click();
      const problem = popup.getByTestId("file-save-problem");
      await expect(problem.getByTestId("failure-title")).toHaveText(untrusted.title);
      await expect(problem.getByTestId("failure-hint")).toHaveText(untrusted.hint);
      await expect(problem).not.toContainText(/File server unavailable|when the connection is available|try again later/i);
      await expect(popup.getByRole("button", { name: "Retry save" })).toBeVisible();
      await popup.close();
      popup = await openPopupFor(page);
      await expect(popup.getByTestId("file-save-problem").getByTestId("failure-title")).toHaveText(untrusted.title);
      await expect(popup.getByTestId("file-save-problem")).not.toContainText("not-for-display");
      await expect(popup.getByTestId("file-save-problem").getByText("net::ERR_CERT_AUTHORITY_INVALID", { exact: true })).toBeHidden();
      await popup.close();
      popup = undefined;

      await page.reload();
      await page.bringToFront();
      await page.keyboard.press("Alt+KeyS");
      await expect(toastCard(page)).toHaveText(`Not saved${untrusted.title}. ${untrusted.hint}`);
      popup = await openPopupFor(page);
      await popup.getByRole("button", { name: "Retry save" }).click();
      await expect(popup.getByTestId("file-save-problem").getByTestId("failure-title")).toHaveText(untrusted.title);
      expect(await probe!.evaluate(() => chrome.downloads.search({}))).toEqual([]);
      expect(mediaRequests).toBe(0);
    } finally {
      await popup?.close();
      await page.close();
      for (const fixture of [server, secureServer]) {
        if (!fixture) continue;
        fixture.closeAllConnections();
        await new Promise<void>(resolveClose => fixture.close(() => resolveClose()));
      }
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("popup keeps a standalone transport stream file as offered, and Alt+S remuxes a redirected HLS transport stream to MP4", async () => {
    const original = readFileSync(resolve(here, "media-fixtures/transport/timed-id3.ts"));
    for (const [scenario, protocol] of [["transport", "progressive-http"], ["hls-id3", "hls"]] as const) {
      await forgetDownloads();
      const page = await context!.newPage();
      let popup: Page | undefined;
      try {
        await page.goto(`/page/${scenario}.html`);
        popup = await openPopupFor(page);
        await popup.getByRole("button", { name: "Check page again" }).click();
        await expect.poll(async () => (await descriptorsForUrlContaining(`/page/${scenario}.html`)).some(d => d.protocol === protocol)).toBe(true);
        if (scenario === "transport") {
          await popup.getByRole("button", { name: "Save", exact: true }).click();
          await expect(popup.getByTestId("job-complete")).toBeVisible();
        } else {
          await popup.close();
          popup = undefined;
          await page.bringToFront();
          await page.keyboard.press("Alt+KeyS");
          await expect(toastLabel(page)).toHaveText("Saved");
        }
        if (scenario === "transport") {
          // The page offers this .ts file itself: it is saved byte for byte, timed ID3 included.
          const file = await savedFile("timed-id3.ts");
          expect(readFileSync(file).equals(original)).toBe(true);
          expect(mediaFacts(file).format).toMatch(/mpegts/);
          expect(probeStreams(file).map(s => s.codec_name)).toEqual(["h264", "aac", "timed_id3"]);
        } else {
          // MP4 carries the stream's H.264 and AAC, every frame of them; the timed ID3 metadata is left out.
          const file = await savedStream("mp4");
          expectSameMedia(file, { video: resolve(here, "media-fixtures/transport/timed-id3.ts") }, "samples");
          expect(probeStreams(file).map(s => s.codec_name).sort()).toEqual(["aac", "h264"]);
        }
      } finally {
        await popup?.close();
        await page.close();
      }
    }
  });

  test("a dropped HLS segment resumes without another request for the fresh media playlist", async () => {
    const counts = fixtureBaseURL + "/interrupted-hls/counts";
    await fetch(counts, {method: "POST"});
    const page = await context!.newPage();
    let popup: Page | undefined;
    try {
      await page.goto("/page/interrupted-hls.html");
      popup = await openPopupFor(page);
      const save = popup.getByRole("button", {name: "Save", exact: true});
      await expect(save).toBeEnabled();
      const before = await (await fetch(counts)).json();
      expect(before.playlists).toBeGreaterThan(0);
      await save.click();
      await expect(popup.getByTestId("job-complete")).toBeVisible();
      expect(await (await fetch(counts)).json()).toEqual({playlists: before.playlists, segments: 2});
      // The segment that dropped halfway is in the file once and whole.
      const path = await savedStream("mp4");
      expectSameMedia(path, { video: resolve(here, "media-fixtures/transport/timed-id3.ts") }, "samples");
    } finally {
      await popup?.close();
      await page.close();
    }
  });

  test("a persistent manifest 522 reaches both the popup and Alt+S", async () => {
    const page = await context!.newPage();
    let popup: Page | undefined;
    try {
      await page.goto("/page/origin-timeout.html");
      popup = await openPopupFor(page);
      await popup.getByRole("button", { name: "Check page again" }).click();
      const failure = popup.getByTestId("discovery-failure");
      await expect(failure.getByTestId("failure-title")).toHaveText("The server is busy");
      await expect(failure.getByTestId("failure-body")).toHaveText("The video server did not answer in time.");
      await expect(failure.getByTestId("failure-hint")).toHaveText("Try again in a few minutes.");
      // The status and the kind of request are technical details: in no text the user reads first.
      const firstRead = await failure.evaluate(node => {
        const copy = node.cloneNode(true) as HTMLElement;
        copy.querySelector("details")?.remove();
        return copy.textContent ?? "";
      });
      expect(firstRead).not.toMatch(/HTTP|522|manifest|server_busy/);
      await expect(failure.getByText("522", { exact: true })).toBeHidden();
      await failure.getByText("Technical details", { exact: true }).click();
      await expect(failure.getByText("522", { exact: true })).toBeVisible();
      await expect(failure.getByText("Playlist", { exact: true })).toBeVisible();
      await expect(failure.getByText("server_busy", { exact: true })).toBeVisible();
      await popup.close();
      popup = undefined;
      await page.bringToFront();
      await page.keyboard.press("Alt+KeyS");
      // A toast has no Technical details, so it carries none: what happened and what to do.
      await expect(toastLabel(page)).toHaveText("Not saved");
      await expect(toastDetail(page)).toHaveText("The server is busy. Try again in a few minutes.");
      expect(await probe!.evaluate(() => chrome.downloads.search({}))).toHaveLength(0);
    } finally {
      await popup?.close();
      await page.close();
    }
  });

  /** Opens a fixture page, waits for its stream to be listed and starts its save under `filename`. */
  async function saveFrom(scenario: string, protocol: string, filename: string, check?: (descriptor: Descriptor) => void): Promise<Page> {
    const page = await openFixtureAndWait(scenario, ds => ds.some(d => d.protocol === protocol));
    try {
      const descriptor = (await descriptorsForUrlContaining(`/page/${scenario}.html`)).find(d => d.protocol === protocol);
      expect(descriptor).toBeDefined();
      check?.(descriptor!);
      await startDescriptorDownload(descriptor!, filename);
      return page;
    } catch (error) {
      await page.close();
      throw error;
    }
  }

  for (const [scenario, name, fixture] of [["direct", "e2e-direct.mp4", "clip.mp4"], ["direct-mkv", "e2e-direct.mkv", "clip.mkv"]] as const) {
    test(`download pipeline saves a direct file byte for byte, under the name the save asked for (${fixture})`, async () => {
      const page = await saveFrom(scenario, "progressive-http", name);
      try {
        const file = await savedFile(name);
        expect(readFileSync(file).equals(fixtureBytes("direct", fixture))).toBe(true);
      } finally {
        await page.close();
      }
    });
  }

  const TS_SEGMENTS = ["seg007.ts", "seg008.ts", "seg009.ts"];
  const FMP4_SEGMENTS = ["init.mp4", "seg007.m4s", "seg008.m4s", "seg009.m4s"];

  test("the frame comparison tells a dropped, repeated or reordered segment from the stream", () => {
    // The check every pipeline test below relies on, turned on the fixtures themselves.
    const whole = pictures(joined("hls-multi", TS_SEGMENTS));
    for (const wrong of [["seg007.ts", "seg009.ts"], ["seg007.ts", "seg008.ts", "seg008.ts", "seg009.ts"], ["seg008.ts", "seg007.ts", "seg009.ts"]]) {
      expect(pictures(joined("hls-multi", wrong)), wrong.join(" + ")).not.toBe(whole);
    }
    const fragments = pictures(joined("hls-fmp4-multi", FMP4_SEGMENTS));
    expect(pictures(joined("hls-fmp4-multi", ["init.mp4", "seg007.m4s", "seg009.m4s"]))).not.toBe(fragments);
    // Ciphertext does not decode to the clear segments' pictures: a transport stream read from it has no video at all.
    expect(() => pictures(joined("hls-aes-multi", TS_SEGMENTS))).toThrow();
  });

  for (const [scenario, segments] of [["hls", ["seg000.ts"]], ["hls-multi", TS_SEGMENTS]] as const) {
    test(`download pipeline remuxes HLS MPEG-TS to an MP4 with every frame of its ${segments.length} segment(s), in order (${scenario})`, async () => {
      const page = await saveFrom(scenario, "hls", "e2e-hls.mp4");
      try {
        expectSameMedia(await savedStream("mp4"), { video: joined(scenario, segments) }, "samples");
      } finally {
        await page.close();
      }
    });
  }

  // The connection is gone for longer than a segment's own quick retries last, in the middle of the stream.
  // The save waits, asks for the same segment again and ends with every frame; before, it ended "Not saved"
  // after about four seconds and kept nothing.
  test("download pipeline waits out an outage in the middle of an HLS stream and goes on with the segment it was reading", async ({ request }) => {
    const page = await openFixtureAndWait("hls-outage", ds => ds.some(d => d.protocol === "hls"));
    try {
      const descriptor = (await descriptorsForUrlContaining("/page/hls-outage.html")).find(d => d.protocol === "hls");
      await request.post("/__requests");
      await startDescriptorDownload(descriptor!, "e2e-hls-outage.mp4");
      expectSameMedia(await savedStream("mp4"), { video: joined("hls-multi", TS_SEGMENTS) }, "samples");
      const requested = (await (await request.get("/__requests")).json() as { path: string }[]).map(entry => entry.path);
      const times = (name: string) => requested.filter(path => path === `/hls-outage/${name}`).length;
      // The segment before the outage and the one after it were asked for once: nothing started again.
      expect([times("seg007.ts"), times("seg009.ts")]).toEqual([1, 1]);
      // Five quick tries, a wait, and the tries after it until the server answered.
      expect(times("seg008.ts")).toBe(8);
    } finally {
      await page.close();
    }
  });

  // A clip joined in on the server before the video: the clock starts again at the joint. One MP4 track cannot
  // carry that by copying packets (the muxer stops, or leaves the second stretch out), so every packet is kept
  // as the transport stream it is. Before, this save failed with "Try again" on every attempt.
  test("download pipeline keeps a transport stream whose clock starts again at a discontinuity, with every packet of both stretches in order", async () => {
    const page = await saveFrom("hls-discontinuity", "hls", "e2e-hls-discontinuity.mp4");
    try {
      const saved = await savedStream("ts");
      expect(readFileSync(saved).equals(Buffer.concat([...TS_SEGMENTS, ...TS_SEGMENTS].map(name => fixtureBytes("hls-multi", name))))).toBe(true);
    } finally {
      await page.close();
    }
  });

  // hls-aes states its IV; hls-aes-multi states none, so each segment's IV is
  // its media sequence number, counted from 7. Either way the saved file must
  // hold what the clear segments hold: undecrypted or wrongly decrypted bytes
  // do not decode to the same pictures.
  for (const [scenario, clear, segments] of [["hls-aes", "hls", ["seg000.ts"]], ["hls-aes-multi", "hls-multi", TS_SEGMENTS]] as const) {
    test(`download pipeline decrypts HLS AES-128 whose key is served in the clear to the clear segments' frames (${scenario})`, async () => {
      // The fixture is ciphertext: it is not its own clear twin.
      for (const name of segments) expect(fixtureBytes(scenario, name).equals(fixtureBytes(clear, name))).toBe(false);
      const page = await saveFrom(scenario, "hls", "e2e-hls-aes.mp4");
      try {
        expectSameMedia(await savedStream("mp4"), { video: joined(clear, segments) }, "samples");
      } finally {
        await page.close();
      }
    });
  }

  test("download pipeline refuses AES-128 behind a FairPlay KEYFORMAT", async () => {
    const page = await openFixtureAndWait("hls-fairplay", ds => ds.some(d => d.protocol === "hls"));
    try {
      const descriptor = (await descriptorsForUrlContaining("/page/hls-fairplay.html")).find(d => d.protocol === "hls");
      expect(descriptor).toBeDefined();
      await expect(startDescriptorDownloadExpectFailure(descriptor!, "e2e-hls-fairplay.mp4"))
        .resolves.toBe("cdm_required");
      expect(await probe!.evaluate(() => chrome.downloads.search({}))).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("download pipeline refuses SAMPLE-AES", async () => {
    const page = await openFixtureAndWait("hls-sample-aes", ds => ds.some(d => d.protocol === "hls"));
    try {
      const descriptor = (await descriptorsForUrlContaining("/page/hls-sample-aes.html")).find(d => d.protocol === "hls");
      expect(descriptor).toBeDefined();
      await expect(startDescriptorDownloadExpectFailure(descriptor!, "e2e-hls-sample-aes.mp4"))
        .resolves.toBe("cdm_required");
      expect(await probe!.evaluate(() => chrome.downloads.search({}))).toEqual([]);
    } finally {
      await page.close();
    }
  });

  for (const [scenario, parts] of [["hls-fmp4", ["init.mp4", "seg000.m4s"]], ["hls-fmp4-multi", FMP4_SEGMENTS]] as const) {
    test(`download pipeline saves clear HLS fMP4/CMAF as its init section and ${parts.length - 1} segment(s) joined in order (${scenario})`, async () => {
      const page = await saveFrom(scenario, "hls", "e2e-hls-fmp4.mp4");
      try {
        const file = await savedStream("mp4");
        // Nothing is rewritten on this path: the file is the server's bytes, joined.
        expect(readFileSync(file).equals(readFileSync(joined(scenario, parts)))).toBe(true);
        const facts = mediaFacts(file);
        expect(facts.format).toMatch(/mp4/);
        expect(facts.streams.map(stream => stream.codec).sort()).toEqual(["aac", "h264"]);
        expect(facts.seconds).toBeGreaterThan(parts.length - 1.5);
      } finally {
        await page.close();
      }
    });
  }

  // A playlist that lists its parts as byte ranges of one file, covering it
  // from its first byte to its last: the file as a whole is the stream. A
  // fragmented MP4 is saved as it is; a transport stream is remuxed.
  for (const [scenario, file] of [["hls-single-file-fmp4", "clip.mp4"], ["hls-single-file-ts", "clip.ts"]] as const) {
    test(`download pipeline saves clear HLS whose parts are byte ranges of one file, asking for the file once (${scenario})`, async ({ request }) => {
      const page = await openFixtureAndWait(scenario, ds => ds.some(d => d.protocol === "hls"));
      try {
        const descriptor = (await descriptorsForUrlContaining(`/page/${scenario}.html`)).find(d => d.protocol === "hls");
        expect(descriptor?.drm).toBeNull();
        await request.post("/__requests");
        await startDescriptorDownload(descriptor!, "e2e-hls-single-file.mp4");
        const saved = await savedStream("mp4");
        if (file.endsWith(".mp4")) expect(readFileSync(saved).equals(fixtureBytes(scenario, file))).toBe(true);
        else expectSameMedia(saved, { video: resolve(here, "media-fixtures", scenario, file) }, "samples");
        expect(mediaFacts(saved).streams.map(stream => stream.codec).sort()).toEqual(["aac", "h264"]);
        expect(mediaFacts(saved).seconds).toBeGreaterThan(2.5);
        const requested = (await (await request.get("/__requests")).json() as { path: string }[]).map(entry => entry.path);
        expect(requested.filter(path => path.endsWith(`/${file}`))).toEqual([`/${scenario}/${file}`]);
      } finally {
        await page.close();
      }
    });
  }

  const AV_MERGE_VIDEO = ["video-init.mp4", "video-seg000.m4s", "video-seg001.m4s"];
  const AV_MERGE_AUDIO = ["audio-init.mp4", "audio-seg000.m4s", "audio-seg001.m4s"];

  test("download pipeline merges demuxed HLS audio+video into one MP4 carrying every frame of both tracks", async () => {
    // The EXT-X-MEDIA audio group must survive parsing — the variant links
    // to it, which is what routes the download through the merge engine.
    const page = await saveFrom("av-merge", "hls", "e2e-av-merge.mp4", descriptor =>
      expect(descriptor.variants.some(v => v.audioRenditionId !== null),
        `expected an audio-linked variant, got ${JSON.stringify(descriptor.variants)}`).toBe(true));
    try {
      const file = await savedStream("mp4");
      expectSameMedia(file, { video: joined("av-merge", AV_MERGE_VIDEO), audio: joined("av-merge", AV_MERGE_AUDIO) }, "packets");
      expect(mediaFacts(file).streams.map(stream => stream.codec).sort()).toEqual(["aac", "h264"]);
    } finally {
      await page.close();
    }
  });

  test("download pipeline saves demuxed HLS with a packed audio rendition with the sound of every segment, in time with the picture", async () => {
    const page = await saveFrom("hls-packed-audio", "hls", "e2e-hls-packed-audio.mp4", descriptor =>
      expect(descriptor.variants.some(v => v.audioRenditionId !== null)).toBe(true));
    try {
      const file = await savedStream("mp4");
      // reference-audio.aac is the three segments' frames in one file, without the tag each segment opens with.
      expectSameMedia(file, { video: joined("hls-packed-audio", ["v007.ts", "v008.ts", "v009.ts"]),
        audio: resolve(here, "media-fixtures/hls-packed-audio/reference-audio.aac") }, "samples");
      const tracks = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,start_time,duration", "-of", "json", file],
        { encoding: "utf8" })) as { streams: { codec_type: string; start_time: string; duration: string }[] };
      const of = (type: string) => tracks.streams.find(stream => stream.codec_type === type)!;
      expect(Math.abs(Number(of("audio").start_time) - Number(of("video").start_time)), "sound and picture start together").toBeLessThan(0.05);
      expect(Math.abs(Number(of("audio").duration) - Number(of("video").duration)), "the sound is as long as the picture").toBeLessThan(0.1);
    } finally {
      await page.close();
    }
  });

  test("Alt+S on the page saves the best HLS stream: its init section and both parts, in order", async () => {
    const page = await openFixtureAndWait("hls-fmp4-mp4", ds => ds.some(d => d.protocol === "hls"));
    try {
      await page.bringToFront();
      await page.keyboard.press("Alt+KeyS");
      const file = await savedStream("mp4");
      // The two parts are different segments of one stream under .mp4 names: each is in the file once.
      expect(readFileSync(file).equals(readFileSync(joined("hls-fmp4-multi", ["init.mp4", "seg007.m4s", "seg008.m4s"])))).toBe(true);
      expect(mediaFacts(file).streams.map(stream => stream.codec).sort()).toEqual(["aac", "h264"]);
    } finally {
      await page.close();
    }
  });

  /**
   * Presses Alt+S on a fixture page and returns every toast label the page
   * showed, in order, until one of `final` appears or the time runs out. The
   * toast lives in an open shadow root on its own element (TOAST), so
   * this reads exactly what a person sees.
   */
  async function altSToasts(scenario: string, final: readonly string[], timeoutMs = 15_000): Promise<string[]> {
    const page = await context!.newPage();
    try {
      await page.goto(`/page/${scenario}.html`);
      await page.waitForLoadState("networkidle");
      // Give network capture a moment to classify what the page fetched.
      await page.waitForTimeout(750);
      await page.bringToFront();
      await page.keyboard.press("Alt+KeyS");
      const seen: string[] = [];
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const label = await page.evaluate(selector => {
          const host = document.querySelector(selector);
          const k = host?.shadowRoot?.querySelector(".k");
          const d = host?.shadowRoot?.querySelector(".d");
          return k ? `${k.textContent ?? ""}|${d?.textContent ?? ""}` : null;
        }, TOAST);
        if (label && seen[seen.length - 1] !== label) seen.push(label);
        if (label && final.includes(label.split("|")[0]!)) return seen;
        await page.waitForTimeout(150);
      }
      return seen;
    } finally {
      await page.close();
    }
  }

  const labels = (toasts: readonly string[]) => toasts.map(t => t.split("|")[0]);

  test("Alt+S on a Widevine page says Not saved, never Nothing to save", async () => {
    const toasts = await altSToasts("widevine", ["Not saved", "Nothing to save"]);
    expect(labels(toasts), `toasts: ${JSON.stringify(toasts)}`).toContain("Not saved");
    expect(toasts.at(-1)).toBe("Not saved|Protected video");
    expect(labels(toasts)).not.toContain("Nothing to save");
  });

  test("Alt+S on a ClearKey page says Not saved, never Nothing to save", async () => {
    const toasts = await altSToasts("clearkey", ["Not saved", "Nothing to save"]);
    expect(labels(toasts), `toasts: ${JSON.stringify(toasts)}`).toContain("Not saved");
    expect(toasts.at(-1)).toBe("Not saved|Protected video");
    expect(labels(toasts)).not.toContain("Nothing to save");
  });

  test("Alt+S on a clear DASH page whose byte ranges leave a gap says Not saved with the reason, never Nothing to save", async () => {
    const toasts = await altSToasts("dash", ["Not saved", "Nothing to save"]);
    expect(labels(toasts), `toasts: ${JSON.stringify(toasts)}`).toContain("Not saved");
    // The reason in plain words. The protocol's name is a technical detail and a toast has none.
    expect(toasts.at(-1), `toasts: ${JSON.stringify(toasts)}`).toBe("Not saved|Can't save this stream in the browser");
    expect(toasts.join(" ")).not.toMatch(/DASH|dash_unsupported/);
    expect(labels(toasts)).not.toContain("Nothing to save");
  });

  const DASH_VIDEO = ["init-stream0.m4s", "chunk-stream0-00001.m4s", "chunk-stream0-00002.m4s"];
  const DASH_AUDIO = ["init-stream1.m4s", "chunk-stream1-00001.m4s", "chunk-stream1-00002.m4s"];

  test("Alt+S on a clear DASH page that declares no audio ends in Saved: the video, as the page plays it", async () => {
    const toasts = await altSToasts("dash-video-only", ["Saved", "Not saved", "Nothing to save"]);
    expect(labels(toasts).at(-1), `toasts: ${JSON.stringify(toasts)}`).toBe("Saved");
    expectSameMedia(await savedStream("mp4"), { video: joined("dash-video-only", DASH_VIDEO) }, "none");
  });

  test("Alt+S on a FairPlay-keyed HLS page ends in Not saved, not in a silent Saving", async () => {
    const toasts = await altSToasts("hls-fairplay", ["Not saved", "Saved", "Nothing to save"]);
    expect(labels(toasts).at(-1), `toasts: ${JSON.stringify(toasts)}`).toBe("Not saved");
  });

  test("Alt+S on a SAMPLE-AES HLS page ends in Not saved, not in a silent Saving", async () => {
    const toasts = await altSToasts("hls-sample-aes", ["Not saved", "Saved", "Nothing to save"]);
    expect(labels(toasts).at(-1), `toasts: ${JSON.stringify(toasts)}`).toBe("Not saved");
  });

  test("Alt+S on a plain HLS page ends in Saved once the engine finishes, and the file is the stream", async () => {
    const toasts = await altSToasts("hls", ["Saved", "Not saved"]);
    expect(labels(toasts).at(-1), `toasts: ${JSON.stringify(toasts)}`).toBe("Saved");
    // Saved is said about a file: it is in the download folder and holds every frame of the stream.
    expectSameMedia(await savedStream("mp4"), { video: joined("hls", ["seg000.ts"]) }, "samples");
  });

  test("Alt+S on a page with no downloadable media flashes the ∅ badge instead of doing nothing", async () => {
    const page = await context!.newPage();
    try {
      await page.goto("/page/negative.html");
      await page.waitForLoadState("networkidle");
      await page.bringToFront();
      await page.keyboard.press("Alt+KeyS");

      const badge = await (async () => {
        for (let attempt = 0; attempt < 20; attempt++) {
          const text = await probe!.evaluate(async (marker: string) => {
            const tabs = await chrome.tabs.query({});
            const tab = tabs.find(t => t.id && t.url?.includes(marker));
            if (!tab?.id) return null;
            return chrome.action.getBadgeText({ tabId: tab.id });
          }, "/page/negative.html");
          if (text === "∅") return text;
          await page.waitForTimeout(250);
        }
        return null;
      })();
      expect(badge, "expected the no-media feedback badge after Alt+S on a media-free page").toBe("∅");
    } finally {
      await page.close();
    }
  });

  test("download pipeline refuses HLS live/sliding-window playlists", async () => {
    const page = await openFixtureAndWait("hls-live", ds => ds.some(d => d.protocol === "hls"));
    try {
      const descriptor = (await descriptorsForUrlContaining("/page/hls-live.html")).find(d => d.protocol === "hls");
      expect(descriptor).toBeDefined();
      await expect(startDescriptorDownloadExpectFailure(descriptor!, "e2e-hls-live.mp4"))
        .resolves.toBe("hls_live_unsupported");
    } finally {
      await page.close();
    }
  });

  test("download pipeline merges clear DASH video+audio into one MP4 carrying every frame of both tracks", async () => {
    const page = await saveFrom("dash-clear", "dash", "e2e-dash-clear.mp4", descriptor => {
      expect(descriptor.drm, `a clear MPD must carry no DRM status: ${JSON.stringify(descriptor.drm)}`).toBeNull();
      // Both AdaptationSets must have survived parsing with fetchable URLs;
      // that pair is what routes the download through the merge engine.
      expect(descriptor.variants.some(v => v.segmentRef.kind === "dash-segments" && v.segmentRef.mediaUrls.length > 0),
        `expected a materialized video AdaptationSet, got ${JSON.stringify(descriptor.variants)}`).toBe(true);
      expect((descriptor.audioRenditions ?? []).length,
        `expected an audio AdaptationSet, got ${JSON.stringify(descriptor.audioRenditions)}`).toBeGreaterThan(0);
    });
    try {
      const file = await savedStream("mp4");
      expectSameMedia(file, { video: joined("dash-clear", DASH_VIDEO), audio: joined("dash-clear", DASH_AUDIO) }, "packets");
      expect(mediaFacts(file).streams.map(stream => stream.codec).sort()).toEqual(["aac", "h264"]);
    } finally {
      await page.close();
    }
  });

  test("download pipeline saves clear DASH that declares no audio as an MP4 with every frame of its video", async () => {
    const page = await saveFrom("dash-video-only", "dash", "e2e-dash-video-only.mp4", descriptor => {
      expect(descriptor.drm).toBeNull();
      expect(descriptor.audioRenditions ?? [], "the manifest declares no audio").toEqual([]);
    });
    try {
      const file = await savedStream("mp4");
      expectSameMedia(file, { video: joined("dash-video-only", DASH_VIDEO) }, "none");
      expect(mediaFacts(file).streams.map(stream => stream.codec)).toEqual(["h264"]);
    } finally {
      await page.close();
    }
  });

  test("download pipeline saves clear DASH whose one representation carries video and audio together with both, never without its sound", async () => {
    const page = await saveFrom("dash-muxed", "dash", "e2e-dash-muxed.mp4", descriptor => {
      expect(descriptor.drm).toBeNull();
      expect(descriptor.audioRenditions ?? [], "the manifest has no audio AdaptationSet").toEqual([]);
    });
    try {
      const file = await savedStream("mp4");
      expectSameMedia(file, { video: resolve(here, "media-fixtures/direct/clip-dash-brand.mp4") }, "packets");
      expect(mediaFacts(file).streams.map(stream => stream.codec).sort()).toEqual(["aac", "h264"]);
    } finally {
      await page.close();
    }
  });

  // One pair of files under two manifests: a list of byte ranges that covers
  // each file, and the on-demand profile's index range. Either way the file
  // as a whole is the track.
  for (const [scenario, described] of [["dash-single-file", "byte ranges"], ["dash-on-demand", "an index range"]] as const) {
    test(`download pipeline merges clear DASH kept in one file per track, described by ${described}, into an MP4 carrying every frame of both`, async ({ request }) => {
      await request.post("/__requests");
      const page = await saveFrom(scenario, "dash", "e2e-dash-single-file.mp4", descriptor => {
        expect(descriptor.drm).toBeNull();
        expect(descriptor.variants.map(v => v.segmentRef.kind === "dash-segments" ? v.segmentRef.mediaUrls.map(url => new URL(url).pathname) : null))
          .toEqual([["/dash-single-file/clip-stream0.mp4"]]);
      });
      try {
        const file = await savedStream("mp4");
        expectSameMedia(file, { video: resolve(here, "media-fixtures/dash-single-file/clip-stream0.mp4"),
          audio: resolve(here, "media-fixtures/dash-single-file/clip-stream1.mp4") }, "packets");
        expect(mediaFacts(file).streams.map(stream => stream.codec).sort()).toEqual(["aac", "h264"]);
        // Each file is asked for once, whole.
        const requested = (await (await request.get("/__requests")).json() as { path: string }[]).map(entry => entry.path);
        expect(requested.filter(path => path.endsWith(".mp4")).sort()).toEqual(["/dash-single-file/clip-stream0.mp4", "/dash-single-file/clip-stream1.mp4"]);
      } finally {
        await page.close();
      }
    });
  }

  // The same two files as a packager lists them under HLS: each playlist names its file's header and parts by
  // byte range and leaves the index between them out. The gaps hold no media, so each file is its track.
  test("download pipeline merges clear HLS kept in one file per track whose byte ranges leave the file's index out, asking for each file once", async ({ request }) => {
    await request.post("/__requests");
    const page = await saveFrom("hls-single-file-gaps", "hls", "e2e-hls-single-file-gaps.mp4", descriptor => expect(descriptor.drm).toBeNull());
    try {
      const file = await savedStream("mp4");
      expectSameMedia(file, { video: resolve(here, "media-fixtures/dash-single-file/clip-stream0.mp4"),
        audio: resolve(here, "media-fixtures/dash-single-file/clip-stream1.mp4") }, "packets");
      expect(mediaFacts(file).streams.map(stream => stream.codec).sort()).toEqual(["aac", "h264"]);
      const requested = (await (await request.get("/__requests")).json() as { path: string }[]).map(entry => entry.path);
      expect(requested.filter(path => path.endsWith(".mp4")).sort()).toEqual(["/dash-single-file/clip-stream0.mp4", "/dash-single-file/clip-stream1.mp4"]);
    } finally {
      await page.close();
    }
  });

  test("download pipeline saves one fragmented MP4 file under a DASH brand byte for byte, as the direct file it is", async () => {
    const page = await saveFrom("dash-brand-file", "progressive-http", "e2e-dash-brand.mp4", descriptor =>
      expect(descriptor.capabilities.directDownload).toBe(true));
    try {
      const file = await savedFile("e2e-dash-brand.mp4");
      expect(readFileSync(file).equals(fixtureBytes("direct", "clip-dash-brand.mp4"))).toBe(true);
      expect(mediaFacts(file).streams.map(stream => stream.codec).sort()).toEqual(["aac", "h264"]);
    } finally {
      await page.close();
    }
  });

  test("download pipeline refuses clear DASH whose byte ranges leave a gap, and requests nothing of it", async ({ request }) => {
    const page = await openFixtureAndWait("dash", ds => ds.some(d => d.protocol === "dash"));
    try {
      const descriptor = (await descriptorsForUrlContaining("/page/dash.html")).find(d => d.protocol === "dash");
      expect(descriptor).toBeDefined();
      expect(descriptor!.drm, "the refusal is not about encryption").toBeNull();
      await request.post("/__requests");
      await expect(startDescriptorDownloadExpectFailure(descriptor!, "e2e-dash.mp4"))
        .resolves.toBe("dash_unsupported");
      const requested = await (await request.get("/__requests")).json() as { path: string }[];
      expect(requested.filter(entry => entry.path.startsWith("/dash/")), "no partial assembly is attempted").toEqual([]);
      expect(await probe!.evaluate(() => chrome.downloads.search({}))).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("Alt+S saves the video or image under the pointer", async () => {
    const page = await context!.newPage();
    const saved: string[] = [];
    try {
      await page.bringToFront();
      await page.goto("/page/pointer.html");
      await page.waitForLoadState("networkidle");
      const toast = toastCard(page);

      // The second player: its video sits below a controls layer.
      const player = (await page.locator(".tile").nth(1).boundingBox())!;
      await page.mouse.move(player.x + player.width / 2, player.y + player.height / 2);
      await page.keyboard.press("Alt+KeyS");
      await expect(toast).toContainText("Savedclip.mp4", { timeout: 20_000 });
      saved.push(await savedFile("clip.mp4"));
      expect(readFileSync(saved[0]!)).toEqual(readFileSync(resolve(here, "media-fixtures/low/clip.mp4")));

      const card = (await page.locator("#card").boundingBox())!;
      await page.mouse.move(card.x + 20, card.y + 20);
      await page.keyboard.press("Alt+KeyS");
      await expect(toast).toContainText("Savedcard.png");
      saved.push(await savedFile("card.png"));
      // The saved image is byte for byte what the server sent, under the name savemedia built.
      expect(readFileSync(saved[1]!).equals(Buffer.from(await (await fetch(fixtureBaseURL + "/pointer/card.png")).arrayBuffer()))).toBe(true);
      expect(await probe!.evaluate(() => chrome.downloads.search({ state: "complete" }))).toHaveLength(2);
    } finally {
      await page.close();
    }
  });
});

test.describe("popup HTML round-trips chrome.runtime messaging", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "chromium-only suite");

  let runtime: ExtensionSession | undefined;
  let context: BrowserContext | undefined;
  let pageErrors: string[] = [];

  test.beforeAll(async ({ browserName }) => {
    if (browserName !== "chromium") return;
    runtime = await launchExtension({ name: "popup", baseURL: fixtureBaseURL });
    pageErrors = watchExtensionPages(runtime, ["console", "pageerror"]);
    context = runtime.context;
  });

  test.afterEach(() => {
    expect(pageErrors.splice(0), "fatal console/page errors emitted by extension pages").toEqual([]);
    expect(runtime?.workerErrors.splice(0) ?? [], "errors the extension logged in its service worker").toEqual([]);
  });

  test.afterAll(async () => {
    await runtime?.close();
  });

  test("popup loads + sendMessage('list') from popup actually reaches the SW", async () => {
    // First populate state by visiting a fixture in a separate tab.
    const fixturePage = await context!.newPage();
    await fixturePage.goto("/page/direct.html");
    await fixturePage.waitForLoadState("networkidle");
    await fixturePage.waitForTimeout(800);

    const popup = await context!.newPage();
    try {
      await popup.goto(runtime!.popupUrl);
      expect(new URL(popup.url()).pathname).toBe(`/${runtime!.popupPath}`);
      await expect(popup.locator("header")).toContainText("savemedia");
      // Within the popup context, chrome.runtime.sendMessage DOES round-trip
      // to the SW listener. Probe the list response for the fixture tab.
      const popupSeen = await popup.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const fixture = tabs.find(t => t.url?.includes("/page/direct.html"));
        if (!fixture?.id) return { ok: false, reason: "no fixture tab visible from popup" };
        const response: { descriptors?: unknown[] } | undefined = await new Promise(r =>
          chrome.runtime.sendMessage({ type: "list", tabId: fixture.id }, (resp: { descriptors?: unknown[] } | undefined) => r(resp)),
        );
        return { ok: true, descriptorCount: response?.descriptors?.length ?? 0, tabId: fixture.id };
      });
      expect(popupSeen).toMatchObject({ ok: true });
      if (popupSeen.ok) {
        expect(popupSeen.descriptorCount).toBeGreaterThanOrEqual(1);
      }
    } finally {
      await popup.close();
      await fixturePage.close();
    }
  });

  test("Chrome registers Alt+S for the best-download command", async () => {
    const popup = await context!.newPage();
    try {
      await popup.goto(runtime!.popupUrl);
      const command = await popup.evaluate(async () => {
        const commands = await chrome.commands.getAll();
        return commands.find(c => c.name === "download-best") ?? null;
      });
      expect(command?.name).toBe("download-best");
      expect(["Alt+S", "⌥S"]).toContain(command?.shortcut);
    } finally {
      await popup.close();
    }
  });
});
