// When the user's network keeps savemedia from a media server, the popup and
// the Alt+S toast say so in plain words and say what to check. Nothing is
// saved, and nothing is reached another way.
//
// The browser is started with resolver rules that send three names to this
// machine, so no request leaves it: a public name answered from a local
// address (what a DNS filter does), a name that does not resolve, and a
// redirect to a block page. The names are under a top-level domain that
// browsers only reach over a secure connection, so the block page's server
// speaks TLS with a certificate made for this run, and the browser is told
// to accept it: what is tested here is the address, not the certificate
// (classification.spec.ts tests a certificate the browser refuses).
//
// The same rules give a page a public name, and a media server that the
// browser reaches at a local address for it. What the browser itself loaded
// from there is saved. A local server the page only names is not requested.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer, type Server as SecureServer } from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchExtension, type ExtensionSession } from "./extension-browser";
import { collectWorkerErrors } from "./extension-worker";
import { popupFor, tabIdOf, toastDetail, toastLabel } from "./helpers";

const MEDIA = "media.e2e.ancplua.dev";
const FILTER = "filter.e2e.ancplua.dev";
const GONE = "gone.e2e.ancplua.dev";
/** A page with a public name, and a media server with a public name that this network answers from a local address. */
const PAGE = "page.e2e.ancplua.dev";
const NAS = "nas.e2e.ancplua.dev";
/** A name of one label: only a resolver inside the user's network answers it. */
const DEVICE = "nas";
const CLIP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "media-fixtures/direct/clip.webm"));

/** The clip, whole or the range asked for, as a media server sends it. */
function serveClip(req: IncomingMessage, res: ServerResponse): void {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] ? Math.min(Number(range[2]), CLIP.length - 1) : CLIP.length - 1;
  res.writeHead(range ? 206 : 200, { "content-type": "video/webm", "accept-ranges": "bytes", etag: '"local-clip"',
    "content-length": end - start + 1, ...(range ? { "content-range": `bytes ${start}-${end}/${CLIP.length}` } : {}) });
  res.end(CLIP.subarray(start, end + 1));
}
const player = (source: string, attributes: string): string =>
  `<!doctype html><title>Local network fixture</title><style>html, body { margin: 0; } video { display: block; }</style>`
  + `<video id="v" ${attributes} width="640" height="360" src="${source}"></video>`;
/** A 1x1 PNG: a picture a device on the network serves. */
const PICTURE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const BLOCK_PAGE = "<!doctype html><html><head><title>Blocked</title></head><body><h1>This site is blocked by your network filter.</h1></body></html>";

test.describe("a media server the user's network blocks", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "uses the Chromium extension runtime");

  let server: Server;
  let media: SecureServer;
  /** The port of the page's own server. */
  let pagePort = 0;
  /** The port of the server behind the three names. */
  let port = 0;
  let certificates = "";
  let context: BrowserContext;
  let extensionId = "";
  let session: ExtensionSession | undefined;
  let workerErrors: string[] = [];
  let probe: Page;
  /** Every request the fixture received: method, Host header and path. */
  const received: { method: string; host: string; path: string }[] = [];

  test.beforeAll(async ({ browserName }) => {
    if (browserName !== "chromium") return;
    certificates = mkdtempSync(join(tmpdir(), "savemedia-block-cert-"));
    const key = join(certificates, "test.key");
    const cert = join(certificates, "test.crt");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${MEDIA}`,
      "-addext", `subjectAltName=DNS:${MEDIA},DNS:${FILTER},DNS:${PAGE},DNS:${NAS}`, "-keyout", key, "-out", cert], { stdio: "ignore" });
    // What a filter's own server answers for a name it took over: a web page, with success.
    media = createSecureServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req: IncomingMessage, res: ServerResponse) => {
      const host = (req.headers.host ?? "").split(":")[0]!;
      const path = (req.url ?? "").split("?")[0]!;
      received.push({ method: req.method ?? "", host, path });
      if (host === NAS && path === "/local/clip.webm") { serveClip(req, res); return; }
      // A file the page's own server offers: the browser never requests a download link by itself.
      if (host === PAGE && path === "/files/training.webm") { serveClip(req, res); return; }
      if (host === PAGE) {
        // Three pages of a site on the internet. Each names a media server inside this network.
        const body = path === "/observed.html" ? player(`https://${NAS}:${port}/local/clip.webm`, "muted autoplay loop playsinline")
          : path === "/literal.html" ? player(`http://127.0.0.1:${pagePort}/local/clip.webm`, "muted autoplay loop playsinline")
            : path === "/named-only.html" ? player(`http://127.0.0.1:${pagePort}/never/clip.webm`, 'muted loop playsinline preload="none"')
              : path === "/named-device.html" ? player(`http://${DEVICE}:${pagePort}/never/clip.webm`, 'muted loop playsinline preload="none"')
              // A picture from a device on this network that the page shows, and one that device does not have.
              // A page that names a file and links to it on its own server.
              // A page of that site whose own player has not loaded its video yet, and that fetches nothing.
              : path === "/onboarding.html" ? player("/files/training.webm", 'controls preload="none"')
              : path === "/training.html" ? `<!doctype html><title>Training</title><h1>training.webm</h1>`
                + `<a id="file" href="/files/training.webm" download="training.webm">Download</a>`
              : path === "/camera.html" ? `<!doctype html><title>Camera fixture</title><style>html, body { margin: 0; } img { display: block; width: 300px; height: 200px; }</style>`
                + `<img id="cam" alt="Camera" src="http://127.0.0.1:${pagePort}/local/cam.png"><img id="gone" alt="Gone" src="http://127.0.0.1:${pagePort}/local/gone.png">` : null;
        res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
        res.end(body ?? "");
        return;
      }
      if (host === MEDIA && path.startsWith("/redirected/")) {
        res.writeHead(302, { location: `https://${FILTER}:${port}/blocked` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(BLOCK_PAGE);
    });
    await new Promise<void>(done => media.listen(0, "127.0.0.1", done));
    port = (media.address() as { port: number }).port;
    server = createServer((req, res) => {
      const path = (req.url ?? "").split("?")[0]!;
      // A device on this network that serves a clip. Every request for it is noted.
      if (path === "/local/clip.webm" || path === "/never/clip.webm") {
        received.push({ method: req.method ?? "", host: (req.headers.host ?? "").split(":")[0]!, path });
        serveClip(req, res);
        return;
      }
      if (path === "/local/cam.png" || path === "/local/gone.png") {
        received.push({ method: req.method ?? "", host: (req.headers.host ?? "").split(":")[0]!, path });
        res.writeHead(path === "/local/cam.png" ? 200 : 404, { "content-type": "image/png" });
        res.end(path === "/local/cam.png" ? PICTURE : "");
        return;
      }
      const video = path === "/blocked.html" ? `https://${MEDIA}:${port}/blocked/clip.mp4`
        : path === "/gone.html" ? `https://${GONE}:${port}/clip.mp4`
          : path === "/redirected.html" ? `https://${MEDIA}:${port}/redirected/clip.mp4` : null;
      if (!video) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Network fixture</title><video preload="none" controls width="640" height="360" src="${video}"></video>`);
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    pagePort = (server.address() as { port: number }).port;
    session = await launchExtension({ name: "block", viewport: { width: 1280, height: 800 }, args: ["--ignore-certificate-errors",
      // Local only: these names never reach a resolver, and no request leaves this machine.
      `--host-resolver-rules=MAP ${MEDIA} 127.0.0.1, MAP ${FILTER} 127.0.0.1, MAP ${GONE} ~NOTFOUND, MAP ${PAGE} 127.0.0.1, MAP ${NAS} 127.0.0.1, MAP ${DEVICE} 127.0.0.1`,
      "--autoplay-policy=no-user-gesture-required"] });
    ({ context, extensionId } = session);
    workerErrors = collectWorkerErrors(context, () => extensionId);
    probe = await context.newPage();
    await probe.goto(session.popupUrl);
  });

  test.beforeEach(async () => {
    received.length = 0;
    await probe.evaluate(() => chrome.downloads.erase({}));
  });

  test.afterEach(async () => {
    for (const page of context.pages()) if (page !== probe) await page.close().catch(() => undefined);
    expect(workerErrors.splice(0), "errors the extension logged in its service worker").toEqual([]);
  });

  test.afterAll(async () => {
    await session?.close();
    for (const fixture of [server, media]) {
      fixture?.closeAllConnections();
      await new Promise<void>(done => fixture ? fixture.close(() => done()) : done());
    }
    if (certificates) rmSync(certificates, { recursive: true, force: true });
  });

  const downloads = () => probe.evaluate(() => chrome.downloads.search({}));

  /** A fixture page and a popup for its tab. The page is on this machine's own address unless `site` names the public one. */
  async function open(path: string, site = `http://127.0.0.1:${pagePort}`): Promise<{ page: Page; popup: Page }> {
    const page = await context.newPage();
    const url = `${site}${path}`;
    await page.goto(url);
    const popup = await popupFor(session!, await tabIdOf(probe, url));
    return { page, popup };
  }

  /** The rows of a failure's Technical details, as label and value. */
  async function rows(failure: ReturnType<Page["getByTestId"]>): Promise<Record<string, string>> {
    return failure.locator("dl").evaluate(list => {
      const labels = [...list.querySelectorAll("dt")].map(node => node.textContent ?? "");
      const values = [...list.querySelectorAll("dd")].map(node => node.textContent ?? "");
      return Object.fromEntries(labels.map((label, index) => [label, values[index] ?? ""]));
    });
  }

  test("a public name answered from a local address with a web page is explained as a block by the network", async () => {
    const { page, popup } = await open("/blocked.html");
    const failure = popup.getByTestId("discovery-failure");
    await expect(failure.getByTestId("failure-title")).toHaveText("Blocked or redirected by your network", { timeout: 20_000 });
    // The body names the server, so the user can find it in a filter. It names no address.
    await expect(failure.getByTestId("failure-body")).toHaveText(`Your network gave ${MEDIA}:${port} a local address instead of its address on the internet. `
      + "Network filters, parental controls and some providers do this to block a server. On a company network this can be normal.");
    await expect(failure.getByTestId("failure-hint")).toHaveText("Check your network filter, or the secure DNS setting in your browser's settings.");
    // The address is a technical detail: on this device only, and only once the user opens the details.
    const address = failure.getByText("127.0.0.1 (this computer)", { exact: true });
    await expect(address).toBeHidden();
    await failure.getByText("Technical details", { exact: true }).click();
    await expect(address).toBeVisible();
    expect(await rows(failure)).toEqual({ "Server": `${MEDIA}:${port}`, "Address": "127.0.0.1 (this computer)", "Answer": "Web page",
      "Error code": "unexpected_media_response" });
    await expect(popup.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await popup.close();

    await page.bringToFront();
    await page.mouse.move(320, 180);
    await page.keyboard.press("Alt+KeyS");
    await expect(toastLabel(page)).toHaveText("Not saved", { timeout: 20_000 });
    await expect(toastDetail(page)).toHaveText(
      "Blocked or redirected by your network. Check your network filter, or the secure DNS setting in your browser's settings.");
    // Nothing was saved, and nothing was tried another way: every request went to the server the page named, as a GET.
    expect(await downloads()).toEqual([]);
    expect(received.length).toBeGreaterThan(0);
    expect(new Set(received.map(request => `${request.method} ${request.host} ${request.path}`))).toEqual(new Set([`GET ${MEDIA} /blocked/clip.mp4`]));
  });

  test("a server name that does not resolve is explained as not found, with the browser's code under Technical details", async () => {
    const { page, popup } = await open("/gone.html");
    const failure = popup.getByTestId("discovery-failure");
    await expect(failure.getByTestId("failure-title")).toHaveText("Server not found", { timeout: 30_000 });
    await expect(failure.getByTestId("failure-body")).toHaveText(`Your network could not find ${GONE}:${port}.`);
    await expect(failure.getByTestId("failure-hint")).toHaveText(
      "Check your connection. If other sites work, a network filter or the secure DNS setting in your browser's settings may block this server.");
    await expect(failure.getByText("net::ERR_NAME_NOT_RESOLVED", { exact: true })).toBeHidden();
    await failure.getByText("Technical details", { exact: true }).click();
    expect(await rows(failure)).toMatchObject({ "Server": `${GONE}:${port}`, "Browser error": "net::ERR_NAME_NOT_RESOLVED", "Error code": "network_unreachable" });
    await popup.close();

    await page.bringToFront();
    await page.mouse.move(320, 180);
    await page.keyboard.press("Alt+KeyS");
    await expect(toastDetail(page)).toHaveText(/^Server not found\. Check your connection\./, { timeout: 30_000 });
    await expect(toastDetail(page)).not.toContainText(/net::|ERR_/);
    expect(await downloads()).toEqual([]);
    // The name was never asked of anything else: the fixture saw no request for it.
    expect(received.filter(request => request.host === GONE)).toEqual([]);
  });

  test("a redirect to a block page is explained with where the request was sent", async () => {
    const { popup } = await open("/redirected.html");
    const failure = popup.getByTestId("discovery-failure");
    await expect(failure.getByTestId("failure-title")).toHaveText("Blocked or redirected by your network", { timeout: 20_000 });
    await expect(failure.getByTestId("failure-body")).toContainText(`${FILTER}:${port}`);
    await failure.getByText("Technical details", { exact: true }).click();
    expect(await rows(failure)).toEqual({ "Server": `${MEDIA}:${port}`, "Address": "127.0.0.1 (this computer)",
      "Redirected to": `${FILTER}:${port} (HTTP 302)`, "Answer": "Web page", "Error code": "unexpected_media_response" });
    expect(await downloads()).toEqual([]);
  });

  const publicSite = () => `https://${PAGE}:${port}`;
  const playing = (page: Page) => expect.poll(() => page.evaluate(() => (document.getElementById("v") as HTMLVideoElement).currentTime > 0),
    { message: "the page's own player should be playing" }).toBe(true);
  /** The one file Alt+S saved, once the browser has finished writing it. */
  async function savedByAltS(page: Page): Promise<Buffer> {
    await page.bringToFront();
    await page.mouse.move(320, 180);
    await page.mouse.move(321, 181);
    await page.keyboard.press("Alt+KeyS");
    await expect(toastLabel(page)).toHaveText("Saved", { timeout: 20_000 });
    await expect.poll(async () => (await downloads()).filter(item => item.state === "complete").length).toBe(1);
    return readFileSync((await downloads()).find(item => item.state === "complete")!.filename);
  }

  test("a public page whose media name the network answers from a local address: what the browser itself played is listed and saved", async () => {
    const { page, popup } = await open("/observed.html", publicSite());
    await playing(page);
    // The browser was answered from that server for this page, so it is neither a block nor a refusal.
    await expect(popup.getByRole("button", { name: "Save", exact: true })).toHaveCount(1, { timeout: 20_000 });
    await expect(popup.getByTestId("discovery-failure")).toHaveCount(0);
    await expect(popup.getByText("Blocked or redirected by your network")).toHaveCount(0);
    await popup.close();
    expect((await savedByAltS(page)).equals(CLIP), "the saved file is the clip the page played").toBe(true);
    // Everything that was requested went to the server the page's own player had loaded from.
    expect(new Set(received.filter(request => request.host !== PAGE).map(request => `${request.method} ${request.host} ${request.path}`)))
      .toEqual(new Set([`GET ${NAS} /local/clip.webm`]));
  });

  test("a public page that plays a file from a device at a local address: that file is saved", async () => {
    const { page, popup } = await open("/literal.html", publicSite());
    await playing(page);
    await expect(popup.getByRole("button", { name: "Save", exact: true })).toHaveCount(1, { timeout: 20_000 });
    await expect(popup.getByTestId("discovery-failure")).toHaveCount(0);
    await popup.close();
    expect((await savedByAltS(page)).equals(CLIP), "the saved file is the clip the page played").toBe(true);
  });

  test("a local server a public page only names is never requested, and the reason is said plainly; once the browser plays it, it is saved", async () => {
    const { page, popup } = await open("/named-only.html", publicSite());
    const failure = popup.getByTestId("discovery-failure");
    await expect(failure.getByTestId("failure-title")).toHaveText("This media is on your local network", { timeout: 20_000 });
    await expect(failure.getByTestId("failure-body")).toHaveText("This page is on the internet, and the media address it names points into your own network. "
      + "Your browser has not loaded anything from that server for this page, so savemedia does not request it either.");
    await expect(failure.getByTestId("failure-hint")).toHaveText("Start playback on the page, then try again. savemedia saves what your browser itself loads.");
    await failure.getByText("Technical details", { exact: true }).click();
    expect(await rows(failure)).toEqual({ "Server": `127.0.0.1:${pagePort}`, "Error code": "private_network_target" });
    await expect(popup.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await popup.close();

    await page.bringToFront();
    await page.mouse.move(320, 180);
    await page.keyboard.press("Alt+KeyS");
    await expect(toastLabel(page)).toHaveText("Not saved", { timeout: 20_000 });
    await expect(toastDetail(page)).toHaveText(
      "This media is on your local network. Start playback on the page, then try again. savemedia saves what your browser itself loads.");
    expect(await downloads()).toEqual([]);
    // Neither the look at the page nor Alt+S sent anything to the server the page only names.
    expect(received.filter(request => request.path === "/never/clip.webm")).toEqual([]);

    // The user starts the video. The browser itself now loads from that server, and what it loads is saved.
    await page.evaluate(() => (document.getElementById("v") as HTMLVideoElement).play());
    await playing(page);
    expect((await savedByAltS(page)).equals(CLIP), "the saved file is the clip the page played").toBe(true);
  });

  test("a device a public page only names by a name of one label is never requested, and no filter is blamed", async () => {
    const { page, popup } = await open("/named-device.html", publicSite());
    const failure = popup.getByTestId("discovery-failure");
    // The name is known to be local before any request: the text is the one for a local server, not for a block.
    await expect(failure.getByTestId("failure-title")).toHaveText("This media is on your local network", { timeout: 20_000 });
    await expect(failure.getByTestId("failure-hint")).toHaveText("Start playback on the page, then try again. savemedia saves what your browser itself loads.");
    await failure.getByText("Technical details", { exact: true }).click();
    expect(await rows(failure)).toEqual({ "Server": `${DEVICE}:${pagePort}`, "Error code": "private_network_target" });
    await expect(popup.getByText("Blocked or redirected by your network")).toHaveCount(0);
    await expect(popup.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await popup.close();

    await page.bringToFront();
    await page.mouse.move(320, 180);
    await page.keyboard.press("Alt+KeyS");
    await expect(toastLabel(page)).toHaveText("Not saved", { timeout: 20_000 });
    expect(await downloads()).toEqual([]);
    // Neither the look at the page nor Alt+S sent anything to the device, with or without the user's cookies for it.
    expect(received.filter(request => request.path === "/never/clip.webm")).toEqual([]);
  });

  test("a public page that shows a picture from a device at a local address: Alt+S saves the picture; a broken image there is not requested", async () => {
    const page = await context.newPage();
    await page.goto(`${publicSite()}/camera.html`);
    // The browser itself loaded the picture and shows it.
    await expect.poll(() => page.evaluate(() => { const image = document.getElementById("cam") as HTMLImageElement; return image.complete && image.naturalWidth > 0; })).toBe(true);
    await expect.poll(() => page.evaluate(() => (document.getElementById("gone") as HTMLImageElement).complete)).toBe(true);
    const requests = (path: string) => received.filter(request => request.path === path).length;
    const ownRequests = { cam: requests("/local/cam.png"), gone: requests("/local/gone.png") };
    expect(ownRequests.cam).toBeGreaterThan(0);

    await page.bringToFront();
    await page.mouse.move(150, 100);
    await page.mouse.move(151, 101);
    await page.keyboard.press("Alt+KeyS");
    await expect(toastLabel(page)).toHaveText("Saved", { timeout: 20_000 });
    await expect.poll(async () => (await downloads()).filter(item => item.state === "complete").length).toBe(1);
    const saved = (await downloads()).find(item => item.state === "complete")!;
    expect(readFileSync(saved.filename).equals(PICTURE), "the saved file is the picture the page shows").toBe(true);
    // One request of savemedia's own, to the server the browser had the picture from.
    expect(requests("/local/cam.png")).toBe(ownRequests.cam + 1);

    // The broken image: the browser has no picture from that address, so nothing is sent there.
    await page.mouse.move(150, 300);
    await page.mouse.move(151, 301);
    await page.keyboard.press("Alt+KeyS");
    await expect(toastDetail(page)).toHaveText("This image is on your local network and this page is on the internet, so savemedia did not request it. "
      + "Right-click it and choose Save Image As.", { timeout: 20_000 });
    await expect(toastLabel(page)).toHaveText("Not saved");
    expect(requests("/local/gone.png")).toBe(ownRequests.gone);
    expect((await downloads()).filter(item => item.state === "complete")).toHaveLength(1);
  });

  test("a page under a name of its own that this network answers from a local address: the file its own server offers is saved without playback", async () => {
    // The browser itself was answered for this page from a local address: its server is one the browser reached.
    const { popup } = await open("/training.html", publicSite());
    await expect(popup.getByText("training.webm").first()).toBeVisible({ timeout: 20_000 });
    await popup.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await downloads()).filter(item => item.state === "complete").length, { timeout: 20_000 }).toBe(1);
    const saved = (await downloads()).find(item => item.state === "complete")!;
    expect(readFileSync(saved.filename).equals(CLIP), "the saved file is the file the page offers").toBe(true);
    // No answer was thrown away and nothing was called a block.
    await expect(popup.getByText("Blocked or redirected by your network")).toHaveCount(0);
    await expect(popup.getByText("This media is on your local network")).toHaveCount(0);
  });

  test("such a page whose own player has not loaded its video yet: the video is listed and saved, and nothing is called a block", async () => {
    // The only answers the browser got from this server are the page itself and nothing else: no media, no fetch.
    const { page, popup } = await open("/onboarding.html", publicSite());
    await expect(popup.getByRole("button", { name: "Save", exact: true })).toHaveCount(1, { timeout: 20_000 });
    await expect(popup.getByTestId("discovery-failure")).toHaveCount(0);
    await expect(popup.getByText("Blocked or redirected by your network")).toHaveCount(0);
    await popup.close();
    expect(await page.evaluate(() => (document.getElementById("v") as HTMLVideoElement).currentTime)).toBe(0);
    expect((await savedByAltS(page)).equals(CLIP), "the saved file is the page's own video").toBe(true);
  });

  test("the diagnostic export says what kind of address answered, never the address", async () => {
    const { page, popup } = await open("/blocked.html");
    await expect(popup.getByTestId("discovery-failure").getByTestId("failure-title")).toHaveText("Blocked or redirected by your network", { timeout: 20_000 });
    const tabId = await tabIdOf(probe, page.url());
    expect(await probe.evaluate((message: object) => chrome.runtime.sendMessage(message), { type: "export-save-diagnostics", tabId, pageUrl: page.url() }))
      .toEqual({ ok: true });
    let report = "";
    await expect.poll(async () => {
      const [item] = (await downloads()).filter(entry => entry.state === "complete");
      if (!item) return false;
      report = readFileSync(item.filename, "utf8");
      return true;
    }).toBe(true);
    const { failures, events } = JSON.parse(report) as { failures: Record<string, unknown>[]; events: Record<string, unknown>[] };
    expect(failures).toEqual([expect.objectContaining({ code: "unexpected_media_response", response: "page", browserAddressScope: "loopback" })]);
    // The page's own host is this machine in this test. What is recorded about the media server names no address.
    expect(JSON.stringify([failures, events])).not.toContain("127.0.0.1");
    expect(report).not.toMatch(/blocked\/clip|\/blocked\.html/);
  });
});

// A browser that reaches the internet through a proxy inside the user's network: a company's proxy, or a
// proxy program on this computer. The browser then reports the proxy's address for every server. That
// address says nothing about a server, so nothing is called a block and no answer is thrown away.
test.describe("behind a proxy at a local address", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "uses the Chromium extension runtime");

  const SITE = "www.proxied-site.e2e.ancplua.net";
  const FILES = "files.proxied-site.e2e.ancplua.net";
  let proxy: Server;
  let session: ExtensionSession | undefined;
  let context: BrowserContext;
  let probe: Page;
  let workerErrors: string[] = [];
  /** Every request the proxy was asked to forward: host and path. It answers them itself, so none leaves this machine. */
  const forwarded: { host: string; path: string }[] = [];

  test.beforeAll(async ({ browserName }) => {
    if (browserName !== "chromium") return;
    proxy = createServer((req, res) => {
      // A forward proxy is asked for the whole address.
      const target = new URL(req.url ?? "", "http://invalid.invalid");
      forwarded.push({ host: target.hostname, path: target.pathname });
      if (target.hostname === FILES && target.pathname === "/movie.webm") { serveClip(req, res); return; }
      const body = target.hostname !== SITE ? null
        : target.pathname === "/file.html" ? `<!doctype html><title>Movie</title><h1>movie.webm</h1><a href="http://${FILES}/movie.webm" download="movie.webm">Download</a>`
          : target.pathname === "/player.html" ? player(`http://${FILES}/movie.webm`, 'muted loop playsinline preload="none"') : null;
      res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
      res.end(body ?? "");
    });
    // A secure address would be tunnelled: this proxy forwards plain HTTP only.
    proxy.on("connect", (_req, socket) => {
      // The browser may drop such a connection at any time: that is no error of the test.
      socket.on("error", () => undefined);
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    proxy.on("clientError", (_error, socket) => { socket.destroy(); });
    await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
    session = await launchExtension({ name: "proxy", viewport: { width: 1280, height: 800 },
      args: [`--proxy-server=http://127.0.0.1:${(proxy.address() as { port: number }).port}`] });
    ({ context } = session);
    const id = session.extensionId;
    workerErrors = collectWorkerErrors(context, () => id);
    probe = await context.newPage();
    await probe.goto(session.popupUrl);
  });

  test.beforeEach(async () => {
    forwarded.length = 0;
    await probe.evaluate(() => chrome.downloads.erase({}));
  });

  test.afterEach(async () => {
    for (const page of context.pages()) if (page !== probe) await page.close().catch(() => undefined);
    expect(workerErrors.splice(0), "errors the extension logged in its service worker").toEqual([]);
  });

  test.afterAll(async () => {
    await session?.close();
    proxy?.closeAllConnections();
    await new Promise<void>(done => proxy ? proxy.close(() => done()) : done());
  });

  const downloads = () => probe.evaluate(() => chrome.downloads.search({}));
  async function open(path: string): Promise<{ page: Page; popup: Page }> {
    const page = await context.newPage();
    const url = `http://${SITE}${path}`;
    await page.goto(url);
    const popup = await popupFor(session!, await tabIdOf(probe, url));
    return { page, popup };
  }

  test("a file a page links to on another server is saved: the proxy's address is not taken for the server's", async () => {
    const { popup } = await open("/file.html");
    await expect(popup.getByText("movie.webm").first()).toBeVisible({ timeout: 20_000 });
    await popup.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await downloads()).filter(item => item.state === "complete").length, { timeout: 20_000 }).toBe(1);
    expect(readFileSync((await downloads()).find(item => item.state === "complete")!.filename).equals(CLIP)).toBe(true);
    await expect(popup.getByText("Blocked or redirected by your network")).toHaveCount(0);
    // The file was asked of the server the page names, through the proxy the browser is set to use.
    // (The browser's own background requests pass the proxy too; only this site's are looked at.)
    const own = forwarded.filter(request => request.host.endsWith(".proxied-site.e2e.ancplua.net") && request.path !== "/favicon.ico");
    expect(new Set(own.map(request => `${request.host} ${request.path}`))).toEqual(new Set([`${SITE} /file.html`, `${FILES} /movie.webm`]));
  });

  test("a player that has not loaded its video yet is listed before playback, and saved", async () => {
    const { page, popup } = await open("/player.html");
    await expect(popup.getByRole("button", { name: "Save", exact: true })).toHaveCount(1, { timeout: 20_000 });
    await expect(popup.getByTestId("discovery-failure")).toHaveCount(0);
    await expect(popup.getByText("Blocked or redirected by your network")).toHaveCount(0);
    await popup.close();
    await page.bringToFront();
    await page.mouse.move(320, 180);
    await page.mouse.move(321, 181);
    await page.keyboard.press("Alt+KeyS");
    await expect(toastLabel(page)).toHaveText("Saved", { timeout: 20_000 });
    await expect.poll(async () => (await downloads()).filter(item => item.state === "complete").length).toBe(1);
    expect(readFileSync((await downloads()).find(item => item.state === "complete")!.filename).equals(CLIP)).toBe(true);
  });
});
