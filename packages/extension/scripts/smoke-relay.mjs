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
  pages = http((req, res) => {
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
  for (const [index, name] of files.entries()) {
    await page.goto("http://127.0.0.1:" + pages.address().port + "/" + name);
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
    const popup = await browser.newPage();
    await popup.goto(popupUrl + "?tabId=" + tabId);
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
    await popup.close();
  }
  assert.equal(unverifiedRequests, 0);
  console.log("The untrusted direct endpoint received zero HTTP requests.");
} finally {
  await browser?.close();
  for (const server of [bad, pages]) { server?.closeAllConnections(); server?.close(); }
  await rm(temp, {recursive: true, force: true});
}
