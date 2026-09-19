import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { createServer } from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

for (const mediaPath of ["/clip.mp4", "/stream?id=opaque"]) {
test(`range-only ${mediaPath} shows server errors and recovers after a truncated response`, async ({ browserName }) => {
  test.skip(browserName !== "chromium", "uses the Chromium extension runtime");
  const temporary = mkdtempSync(join(tmpdir(), "savemedia-ranges-"));
  const key = join(temporary, "test.key");
  const cert = join(temporary, "test.crt");
  // An ephemeral certificate for this loopback fixture only. The isolated
  // test browser accepts it; no user browser or trust store is modified.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-keyout", key, "-out", cert], { stdio: "ignore" });
  const video = readFileSync(join(here, "media-fixtures/direct/clip.mp4"));
  let probes = 0;
  let chunks = 0;
  let unavailable = true;
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    if (req.url === "/page.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Range recovery fixture</title><video src="${mediaPath}" preload="metadata" controls></video>`);
      return;
    }
    if (req.url !== mediaPath) { res.writeHead(404); res.end(); return; }
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
    if (!match) { res.writeHead(503); res.end("full requests unavailable"); return; }
    if (unavailable) { res.writeHead(503); res.end("server temporarily unavailable"); return; }
    const isChunk = req.headers["if-range"] !== undefined;
    if (!isChunk && ++probes === 1) { res.writeHead(503); res.end("transient probe failure"); return; }
    if (isChunk && req.headers["if-range"] !== '"fixture-v1"') { res.writeHead(412); res.end(); return; }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), video.length - 1);
    const bytes = video.subarray(start, end + 1);
    res.writeHead(206, {
      "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${video.length}`,
      "content-length": bytes.length, etag: '"fixture-v1"',
    });
    if (isChunk && ++chunks === 1) {
      res.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
      setTimeout(() => res.destroy(), 10);
      return;
    }
    res.end(bytes);
  });
  let context: BrowserContext | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const pageUrl = `https://127.0.0.1:${port}/page.html`;
    const dist = resolve(here, "../../dist-chrome");
    context = await chromium.launchPersistentContext(join(temporary, "profile"), {
      headless: false, acceptDownloads: true, downloadsPath: temporary,
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--ignore-certificate-errors"],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(pageUrl);
    const popup = await context.newPage();
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url)?.id, pageUrl);
    const popupUrl = `chrome-extension://${extensionId}/src/popup/index.html?tabId=${tabId}`;
    await popup.goto(popupUrl);
    await expect(popup.getByText("Server is busy or unstable")).toBeVisible();
    await expect(popup.getByText("No media detected on this page.")).toHaveCount(0);
    await popup.getByRole("button", { name: "Check page again" }).click();
    await expect(popup.getByRole("button", { name: "Check page again" })).toBeEnabled();
    await expect(popup.getByText("Server is busy or unstable")).toBeVisible();
    unavailable = false;
    await popup.getByRole("button", { name: "Check page again" }).click();
    const descriptors = () => popup.evaluate(async url => {
      const tab = (await chrome.tabs.query({})).find(t => t.url === url);
      const result = await chrome.runtime.sendMessage({ type: "list", tabId: tab?.id });
      return result.descriptors as Array<{ id: string; capabilities: { directDownload: boolean }; source: { headers: Record<string, string> } }>;
    }, pageUrl);
    await expect.poll(async () => (await descriptors()).some(d => d.capabilities.directDownload)).toBe(true);
    await expect(popup.getByText("Server is busy or unstable")).toHaveCount(0);
    const [descriptor] = await descriptors();
    expect(descriptor!.source.headers.etag).toBe('"fixture-v1"');
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
        outputMode: "Original", filename: "recovered.mp4", variantId: null, audioRenditionId: null,
      } });
      return finished;
    }, descriptor!.id);
    expect(outcome, JSON.stringify({ outcome, probes, chunks })).toMatchObject({ type: "job-complete" });
    const completed = () => popup.evaluate(async () => {
      const downloads = await chrome.downloads.search({ state: "complete" });
      // Playwright stores accepted downloads under a UUID in downloadsPath.
      // This isolated profile has one save; identify its engine Blob URL.
      return downloads.find(d => d.url.startsWith("blob:")) ?? null;
    });
    await expect.poll(completed, { timeout: 20_000 }).not.toBeNull();
    const download = (await completed())!;
    expect(download.url).toMatch(/^blob:/);
    const saved = readFileSync(download.filename);
    expect(saved.length).toBe(video.length);
    expect(createHash("sha256").update(saved).digest("hex"))
      .toBe(createHash("sha256").update(video).digest("hex"));
    expect(probes).toBeGreaterThanOrEqual(3);
    expect(chunks).toBe(2);
    await popup.close();
    const reopened = await context.newPage();
    await reopened.goto(popupUrl);
    await expect(reopened.getByTestId("job-complete")).toBeVisible();
  } finally {
    await context?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(temporary, { recursive: true, force: true });
  }
});
}
