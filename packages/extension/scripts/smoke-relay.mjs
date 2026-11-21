// Live, opt-in transport check. Only the new test profile uses the bad DNS route.
// The remote files are this repository's own generated QuickTime fixtures.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as http } from "node:http";
import { createServer as https } from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extension = process.argv[2] ? resolve(process.argv[2]) : join(root, "dist-chrome");
const files = ["test-pattern.mov", "color-bars.mov"];
const fixturePath = "packages/extension/tests/e2e/media-fixtures/direct/";
const origin = "raw.githubusercontent.com";
const fixtureBase = "https://" + origin + "/ANcpLua/save-media/e38835e082622c17758791efd49a37120e750c69/" + fixturePath;
const temp = await mkdtemp(join(tmpdir(), "savemedia-relay-"));
let bad, pages, browser;
let unverifiedRequests = 0;

try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=" + origin, "-addext", "subjectAltName=DNS:" + origin,
    "-keyout", join(temp, "key"), "-out", join(temp, "cert")], {stdio: "ignore"});
  bad = https({key: await readFile(join(temp, "key")), cert: await readFile(join(temp, "cert"))}, (_, res) => {
    unverifiedRequests++;
    res.end();
  });
  await once(bad.listen(0, "127.0.0.1"), "listening");
  const busyFile = await readFile(join(root, "tests/e2e/media-fixtures/direct", files[0]));
  const fullRequests = [];
  pages = http((req, res) => {
    if (req.url === "/busy-page") {
      res.writeHead(200, {"Content-Type": "text/html"}).end(
        '<h1>busy-server.mov</h1><video preload="none" controls src="/busy-server.mov"></video>');
      return;
    }
    if (req.url === "/busy-server.mov") {
      const headers = {"Content-Type": "video/quicktime", "Cache-Control": "no-store"};
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
      if (range) {
        const start = Number(range[1]), end = Math.min(Number(range[2] || busyFile.length - 1), busyFile.length - 1);
        res.writeHead(206, {...headers, "Content-Range": `bytes ${start}-${end}/${busyFile.length}`,
          "Content-Length": end - start + 1}).end(busyFile.subarray(start, end + 1));
      } else {
        fullRequests.push(Date.now());
        if (fullRequests.length === 1) res.writeHead(503, {"Retry-After": "2"}).end();
        else {
          res.writeHead(200, headers);
          res.write(busyFile.subarray(0, 4096));
          setTimeout(() => res.end(busyFile.subarray(4096)), 1800);
        }
      }
      return;
    }
    const name = files.find(file => "/" + file === req.url);
    if (!name) { res.writeHead(404).end(); return; }
    res.writeHead(200, {"Content-Type": "text/html"}).end(
      '<h1>' + name + '</h1><a href="#">Download</a><script>document.querySelector("a").onclick = e => {' +
      'e.preventDefault(); location.href=' + JSON.stringify(fixtureBase + name) + ';}</script>');
  });
  await once(pages.listen(0, "127.0.0.1"), "listening");
  const profile = join(temp, "profile");
  const downloads = join(temp, "downloads");
  await mkdir(join(profile, "Default"), {recursive: true});
  await mkdir(downloads);
  await writeFile(join(profile, "Default", "Preferences"), JSON.stringify({download: {
    default_directory: downloads, prompt_for_download: false,
  }}));
  browser = await chromium.launchPersistentContext(profile, {channel: "chromium", headless: true, args: [
    "--disable-extensions-except=" + extension, "--load-extension=" + extension,
    "--host-resolver-rules=MAP " + origin + " 127.0.0.1:" + bad.address().port,
  ]});
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent("serviceworker", {timeout: 10000});
  const popupUrl = new URL("src/popup/index.html", worker.url()).href;
  const page = await browser.newPage();
  await (await browser.newCDPSession(page)).send("Browser.setDownloadBehavior", {behavior: "default"});
  async function completed() {
    // Only this disposable profile is inspected by the smoke test.
    return worker.evaluate(() => chrome.downloads.search({state: "complete"}));
  }
  for (const [index, name] of files.entries()) {
    await page.goto("http://127.0.0.1:" + pages.address().port + "/" + name);
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
    const popup = await browser.newPage();
    await popup.goto(popupUrl + "?tabId=" + tabId);
    await popup.evaluate(() => {
      window.transferStages = [];
      window.staleFailureDuringTransfer = false;
      new MutationObserver(() => {
        const bar = document.querySelector("progress");
        if (!bar) return;
        window.transferStages.push([bar.getAttribute("aria-label"), bar.getAttribute("value"), bar.parentElement.textContent]);
        if (document.body.innerText.includes("Secure connection failed") || document.body.innerText.includes("Unavailable sources")) {
          window.staleFailureDuringTransfer = true;
        }
      }).observe(document.body, {childList: true, subtree: true, characterData: true, attributes: true});
    });
    if (index === 0) {
      await popup.getByRole("button", {name: "Download", exact: true}).click();
      await popup.getByRole("button", {name: "Use secure relay", exact: true}).click();
      await popup.getByText("Saved to Downloads · " + name, {exact: true}).waitFor({timeout: 65000});
    } else {
      await page.bringToFront();
      await page.keyboard.press("Alt+KeyS");
    }
    let item;
    const deadline = Date.now() + 65000;
    while (!item && Date.now() < deadline) {
      item = await worker.evaluate(async name => (await chrome.downloads.search({state: "complete"}))
        .find(file => file.filename.endsWith("/" + name)), name);
      if (!item) await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert(item, "No completed download for " + name);
    assert.equal(basename(item.filename), name);
    const bytes = await readFile(item.filename);
    assert.deepEqual(bytes, await readFile(join(root, "tests/e2e/media-fixtures/direct", name)));
    console.log(index ? "Alt+S" : "Popup", name, bytes.length, "bytes match");
    await popup.getByText("Saved to Downloads · " + name, {exact: true}).waitFor();
    const progress = await popup.evaluate(() => ({stages: window.transferStages, stale: window.staleFailureDuringTransfer}));
    assert.equal(progress.stale, false, "An earlier failure was visible beside an active transfer");
    assert(progress.stages.some(([stage, value]) => stage === "Downloading" && value !== null), "Missing measured progress");
    assert(progress.stages.some(([stage]) => stage === "Writing to Downloads"), "Missing browser save stage");
    console.log("Visible progress:", ...new Set(progress.stages.map(([stage]) => stage)));
    if (index === 0) {
      await page.reload();
      await popup.reload();
      await page.bringToFront();
      await page.keyboard.press("Alt+KeyS");
      await popup.getByText(/already saved this file in this browser session/i).waitFor({timeout: 20000});
      await popup.getByRole("button", {name: "Cancel", exact: true}).click();
      await popup.getByText(/already saved this file in this browser session/i).waitFor({state: "hidden"});
      assert.equal((await completed()).length, 1, "Cancel created a second copy");
      await popup.getByRole("button", {name: /Save another copy|^Download$/}).click();
      await popup.getByRole("button", {name: "Save another copy", exact: true}).click();
      const second = name.replace(/\.mov$/, " (1).mov");
      await popup.getByText("Saved to Downloads · " + second, {exact: true}).waitFor({timeout: 65000});
      const duplicate = (await completed()).find(file => basename(file.filename) === second);
      assert(duplicate);
      assert.deepEqual(await readFile(duplicate.filename), bytes);
      console.log("After page and popup reload, Alt+S repeat canceled. Confirmed popup repeat:", second, bytes.length, "bytes match");
    }
    await popup.close();
  }
  await page.goto("http://127.0.0.1:" + pages.address().port + "/busy-page");
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
  const direct = await browser.newPage();
  await direct.goto(popupUrl + "?tabId=" + tabId);
  await direct.getByRole("button", {name: /^Download$/}).click();
  await direct.getByRole("progressbar", {name: /Retrying.*503/}).waitFor();
  await direct.reload();
  await direct.getByRole("progressbar", {name: "Downloading", exact: true}).waitFor();
  await direct.getByText(/4.0 KB received/).waitFor();
  assert.equal(await direct.getByRole("progressbar").getAttribute("value"), null, "Unknown size must stay indeterminate");
  await direct.getByTestId("job-complete").waitFor();
  assert.equal(fullRequests.length, 2);
  assert(fullRequests[1] - fullRequests[0] >= 2000, "Retried before Retry-After");
  const recovered = (await completed()).find(item => basename(item.filename) === "busy-server.mov");
  assert(recovered, "Missing recovered file");
  assert.deepEqual(await readFile(recovered.filename), busyFile);
  await page.bringToFront();
  await page.keyboard.press("Alt+KeyS");
  await direct.getByText(/already saved this file in this browser session/i).waitFor();
  await direct.getByRole("button", {name: "Cancel", exact: true}).click();
  assert.equal(fullRequests.length, 2, "Cancel fetched the file again");
  console.log("HTTP 503 retried automatically after Retry-After. Reopened popup showed measured bytes with unknown total.",
    busyFile.length, "saved bytes match. Alt+S repeat canceled.");
  assert.equal(unverifiedRequests, 0);
  console.log("The untrusted direct endpoint received zero HTTP requests.");
} finally {
  await browser?.close();
  for (const server of [bad, pages]) { server?.closeAllConnections(); server?.close(); }
  await rm(temp, {recursive: true, force: true});
}
