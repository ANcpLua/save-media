import {expect, test} from "@playwright/test";
import {createHash} from "node:crypto";
import {createServer} from "node:http";
import {readFileSync, readdirSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {launchExtension, type ExtensionSession} from "./extension-browser";
import {extensionWorker} from "./extension-worker";
import {popupFor, tabIdOf} from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));
const clip = readFileSync(join(here, "media-fixtures/direct/clip.mp4"));
const cut = 58013;

/**
 * A page that names a file and links to it. The user's own download of the link stops part-way. Then the user
 * presses Save in the popup, and Chrome continues its own download. `resumeAnswer` is what the server sends to
 * that resume: the rest of the file, or the page of a link that has expired, with success.
 */
async function resumeInterrupted(resumeAnswer: "rest" | "page"): Promise<void> {
  test.setTimeout(90_000);
  const headers = {"content-type": "video/mp4", "content-disposition": 'attachment; filename="clip.mp4"', "accept-ranges": "bytes",
    etag: '"clip-v1"', "cache-control": "no-store", "repr-digest": "sha-256=:" + createHash("sha256").update(clip).digest("base64") + ":"};
  let interrupted = true;
  let originalStarted = false;
  const resumedRanges: string[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/page") {
      res.writeHead(200, {"content-type": "text/html"}).end('<main><h1>clip.mp4</h1><a href="/media" download="clip.mp4">Download</a></main>');
      return;
    }
    if (req.url !== "/media") { res.writeHead(404).end(); return; }
    const range = req.headers.range ?? "";
    if (interrupted) {
      if (!originalStarted && !range) {
        originalStarted = true;
        res.writeHead(200, {...headers, "content-length": clip.length});
        res.write(clip.subarray(0, cut));
        setTimeout(() => res.destroy(), 200);
      } else if (range === "bytes=0-4095") res.writeHead(503, {"retry-after": "90"}).end();
      else req.socket.destroy();
      return;
    }
    resumedRanges.push(range);
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match || Number(match[1]) === 0) { res.writeHead(503, {"retry-after": "90"}).end(); return; }
    if (resumeAnswer === "page") {
      res.writeHead(200, {"content-type": "text/html", "cache-control": "no-store"}).end("<!doctype html><title>Link expired</title><h1>This link has expired.</h1>");
      return;
    }
    const start = Number(match[1]), end = match[2] ? Number(match[2]) : clip.length - 1;
    res.writeHead(206, {...headers, "content-range": `bytes ${start}-${end}/${clip.length}`,
      "content-length": end - start + 1}).end(clip.subarray(start, end + 1));
  });
  let session: ExtensionSession | undefined;
  try {
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const site = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
    session = await launchExtension({name: "interrupted"});
    const {context, downloadDir: downloads} = session;
    const worker = await extensionWorker(context, session.extensionId);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Browser.setDownloadBehavior", {behavior: "allow", downloadPath: downloads, eventsEnabled: true});
    await page.goto(site + "/page");
    await page.getByRole("link", {name: "Download"}).click();
    const receipt = () => worker.evaluate(async url => (await chrome.downloads.search({url}))[0], site + "/media");
    await expect.poll(async () => (await receipt())?.state, {timeout: 45_000}).toBe("interrupted");
    const item = (await receipt())!;
    expect(item.bytesReceived, JSON.stringify({state: item.state, error: item.error, resumable: item.canResume})).toBe(cut);
    expect(item.canResume).toBe(true);
    const popup = await popupFor(session, await tabIdOf(worker, site + "/page"));
    interrupted = false;
    await popup.getByRole("button", {name: /^(Save|Retry save)$/}).click();
    const completed = () => worker.evaluate(async () => (await chrome.downloads.search({state: "complete"}))[0]);
    if (resumeAnswer === "page") {
      // Chrome took the page for the file and finished. savemedia sees that the finished download is no video any more:
      // the file is removed, nothing counts as saved, and the popup says what the server sent.
      await expect(popup.getByTestId("failure-title")).toHaveText("The server sent a web page instead of the video", {timeout: 35_000});
      await expect.poll(async () => (await receipt())?.exists, {timeout: 20_000}).toBe(false);
      expect(readdirSync(downloads).filter(name => !name.endsWith(".crdownload"))).toEqual([]);
      await expect(popup.getByText("Saved earlier in this browser session")).toHaveCount(0);
      await expect(popup.getByText("Saved to Downloads")).toHaveCount(0);
      expect(resumedRanges.some(range => Number(/^bytes=(\d+)-/.exec(range)?.[1]) > 0), "the browser asked for the rest of its own file").toBe(true);
      return;
    }
    try {
      await expect.poll(async () => !!await completed(), {timeout: 35_000}).toBe(true);
    } catch (error) {
      console.info("Interrupted fixture", {ranges: resumedRanges, item: await receipt(), downloads: readdirSync(downloads),
        state: await popup.locator("body").innerText(), contexts: await worker.evaluate(() => chrome.runtime.getContexts({}))});
      throw error;
    }
    const saved = (await completed())!;
    expect(saved.id).toBe(item.id);
    expect(readFileSync(saved.filename).equals(clip)).toBe(true);
    expect(resumedRanges.some(range => Number(/^bytes=(\d+)-/.exec(range)?.[1]) > 0)).toBe(true);
    await expect(popup.getByText("Saved earlier in this browser session")).toBeVisible();
    expect(session.workerErrors, "errors the extension logged in its service worker").toEqual([]);
  } finally {
    await session?.close();
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
}

test("Retry save resumes an interrupted original through Chrome's own download", () => resumeInterrupted("rest"));

test("a resume the server answers with a web page leaves no file behind, and the popup says what the server sent", () => resumeInterrupted("page"));
