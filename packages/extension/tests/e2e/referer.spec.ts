import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { createServer } from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

test("a media host that refuses requests without the page's Referer still saves", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "uses the Chromium extension runtime");
  const temporary = mkdtempSync(join(tmpdir(), "savemedia-referer-"));
  const key = join(temporary, "test.key");
  const cert = join(temporary, "test.crt");
  // An ephemeral certificate for this loopback fixture only. The isolated
  // test browser accepts it; no user browser or trust store is modified.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-keyout", key, "-out", cert], { stdio: "ignore" });
  const video = readFileSync(join(here, "media-fixtures/direct/clip.mp4"));
  let pageOrigin = "";
  let mediaUrl = "";
  let refused = 0;
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    if (req.url === "/page.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Referer fixture</title><video src="${mediaUrl}" preload="metadata" controls></video>`);
      return;
    }
    if (req.url !== "/clip.mp4") { res.writeHead(404); res.end(); return; }
    // Hotlink protection: only requests that name the page as Referer get bytes.
    if (!req.headers.referer?.startsWith(pageOrigin)) { refused++; res.writeHead(403); res.end("hotlink"); return; }
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    const start = match ? Number(match[1]) : 0;
    const end = Math.min(match?.[2] ? Number(match[2]) : video.length - 1, video.length - 1);
    res.writeHead(match ? 206 : 200, {
      "content-type": "video/mp4", "content-length": end - start + 1, etag: '"fixture-v1"', "accept-ranges": "bytes",
      ...(match ? { "content-range": `bytes ${start}-${end}/${video.length}` } : {}),
    });
    res.end(video.subarray(start, end + 1));
  });
  let context: BrowserContext | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    pageOrigin = `https://127.0.0.1:${port}/`;
    // A second host name for the same loopback server: the media is cross-origin.
    mediaUrl = `https://media.test:${port}/clip.mp4`;
    const pageUrl = `${pageOrigin}page.html`;
    const dist = resolve(here, "../../dist-chrome");
    context = await chromium.launchPersistentContext(join(temporary, "profile"), {
      headless: false, acceptDownloads: true, downloadsPath: temporary,
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--ignore-certificate-errors",
        "--host-resolver-rules=MAP media.test 127.0.0.1"],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(pageUrl);
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url)?.id, pageUrl);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html?tabId=${tabId}`);
    const descriptors = () => popup.evaluate(async id => {
      const result = await chrome.runtime.sendMessage({ type: "list", tabId: id });
      return result.descriptors as Array<{ id: string; capabilities: { directDownload: boolean } }>;
    }, tabId);
    await expect.poll(async () => (await descriptors()).some(d => d.capabilities.directDownload)).toBe(true);
    await expect(popup.getByText("The site denied access")).toHaveCount(0);
    const [descriptor] = await descriptors();
    const outcome = await popup.evaluate(async streamId => {
      const finished = new Promise<unknown>(resolve => {
        const timer = setTimeout(() => { chrome.runtime.onMessage.removeListener(listener); resolve({ type: "timed-out" }); }, 15_000);
        function listener(message: { type: string; streamId?: string }) {
          if (message.streamId === streamId && ["job-complete", "job-failed"].includes(message.type)) {
            clearTimeout(timer);
            chrome.runtime.onMessage.removeListener(listener);
            resolve(message);
          }
        }
        chrome.runtime.onMessage.addListener(listener);
      });
      await chrome.runtime.sendMessage({ type: "download", streamId, choice: {
        outputMode: "Original", filename: "referer.mp4", variantId: null, audioRenditionId: null,
      } });
      return finished;
    }, descriptor!.id);
    expect(outcome, JSON.stringify({ outcome, refused })).toMatchObject({ type: "job-complete" });
    const completed = () => popup.evaluate(async () => {
      const downloads = await chrome.downloads.search({ state: "complete" });
      return downloads.find(d => d.url.startsWith("blob:")) ?? null;
    });
    await expect.poll(completed, { timeout: 20_000 }).not.toBeNull();
    const saved = readFileSync((await completed())!.filename);
    expect(createHash("sha256").update(saved).digest("hex"))
      .toBe(createHash("sha256").update(video).digest("hex"));
    expect(refused).toBe(0);
  } finally {
    await context?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(temporary, { recursive: true, force: true });
  }
});
