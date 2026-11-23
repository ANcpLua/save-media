import { test, expect } from "@playwright/test";
import { createServer } from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchExtension, type ExtensionSession } from "./extension-browser";
import { extensionWorker } from "./extension-worker";
import { popupFor, saveAndWait, tabIdOf } from "./helpers";

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
  let session: ExtensionSession | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    pageOrigin = `https://127.0.0.1:${port}/`;
    // A second host name for the same loopback server: the media is cross-origin.
    mediaUrl = `https://media.test:${port}/clip.mp4`;
    const pageUrl = `${pageOrigin}page.html`;
    session = await launchExtension({ name: "referer", args: ["--ignore-certificate-errors", "--host-resolver-rules=MAP media.test 127.0.0.1"] });
    const context = session.context;
    const worker = await extensionWorker(context, session.extensionId);
    const page = await context.newPage();
    await page.goto(pageUrl);
    const tabId = await tabIdOf(worker, pageUrl);
    const popup = await popupFor(session, tabId);
    const descriptors = () => popup.evaluate(async id => {
      const result = await chrome.runtime.sendMessage({ type: "list", tabId: id });
      return result.descriptors as Array<{ id: string; capabilities: { directDownload: boolean } }>;
    }, tabId);
    await expect.poll(async () => (await descriptors()).some(d => d.capabilities.directDownload)).toBe(true);
    await expect(popup.getByText("The site denied access")).toHaveCount(0);
    const [descriptor] = await descriptors();
    const outcome = await saveAndWait(popup, descriptor!.id, "referer.mp4");
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
    expect(session.workerErrors, "errors the extension logged in its service worker").toEqual([]);
  } finally {
    await session?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a player embedded in a frame saves with the frame's Referer, which is what its media host checks", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "uses the Chromium extension runtime");
  const temporary = mkdtempSync(join(tmpdir(), "savemedia-referer-frame-"));
  const key = join(temporary, "test.key");
  const cert = join(temporary, "test.crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-keyout", key, "-out", cert], { stdio: "ignore" });
  const playlist = readFileSync(join(here, "media-fixtures/hls/media.m3u8"));
  const segment = readFileSync(join(here, "media-fixtures/hls/seg000.ts"));
  let port = 0;
  // Three origins on one loopback server: the tab's page, the player's frame and the media host.
  const topOrigin = () => `https://127.0.0.1:${port}`;
  const playerOrigin = () => `https://localhost:${port}`;
  const mediaOrigin = () => `https://media.localhost:${port}`;
  const refused: string[] = [];
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    if (host === "127.0.0.1" && req.url === "/page.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Embedding page</title><iframe src="${playerOrigin()}/player.html" width="640" height="360"></iframe>`);
      return;
    }
    if (host === "localhost" && req.url === "/player.html") {
      res.writeHead(200, { "content-type": "text/html" });
      // The player's own request for its playlist, as a script-driven player makes it.
      res.end(`<!doctype html><title>Player</title><script>fetch("${mediaOrigin()}/media.m3u8").then(r => r.text());</script>`);
      return;
    }
    if (host !== "media.localhost" || (req.url !== "/media.m3u8" && req.url !== "/seg000.ts")) { res.writeHead(404); res.end(); return; }
    // The media host serves only the player's own site: the embedding page's Referer is refused.
    if (!req.headers.referer?.startsWith(playerOrigin() + "/")) {
      refused.push(`${req.url} from ${req.headers.referer ?? "(no referer)"}`);
      res.writeHead(403); res.end("hotlink"); return;
    }
    const body = req.url === "/media.m3u8" ? playlist : segment;
    res.writeHead(200, { "content-type": req.url === "/media.m3u8" ? "application/vnd.apple.mpegurl" : "video/mp2t",
      "content-length": body.length, "access-control-allow-origin": "*" });
    res.end(body);
  });
  let session: ExtensionSession | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
    const pageUrl = `${topOrigin()}/page.html`;
    session = await launchExtension({ name: "referer-frame", args: ["--ignore-certificate-errors", "--host-resolver-rules=MAP media.localhost 127.0.0.1"] });
    const context = session.context;
    const worker = await extensionWorker(context, session.extensionId);
    const page = await context.newPage();
    await page.goto(pageUrl);
    const tabId = await tabIdOf(worker, pageUrl);
    const popup = await popupFor(session, tabId);
    const streams = () => popup.evaluate(async id => {
      const result = await chrome.runtime.sendMessage({ type: "list", tabId: id });
      return (result.descriptors as Array<{ id: string; protocol: string }>).filter(d => d.protocol === "hls");
    }, tabId);
    await expect.poll(async () => (await streams()).length, { timeout: 15_000 }).toBe(1);
    const [stream] = await streams();
    const outcome = await saveAndWait(popup, stream!.id, "framed.mp4", { timeout: 20_000 });
    // The playlist and the segment the save requested carried the frame's origin, never the tab's page.
    expect(outcome, JSON.stringify({ outcome, refused })).toMatchObject({ type: "job-complete" });
    expect(refused).toEqual([]);
    expect(session.workerErrors, "errors the extension logged in its service worker").toEqual([]);
  } finally {
    await session?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(temporary, { recursive: true, force: true });
  }
});
