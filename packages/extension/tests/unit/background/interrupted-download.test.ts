import {expect, it, vi} from "vitest";
import type {JobError} from "@savemedia/core";
import {answeredWithoutVideo, matchesInterruptedFile, settleResumedDownload} from "../../../src/background/interrupted-download";

const page = "https://site.example/f/one";
const offer = {filename: "Movie.mp4", url: "https://site.example/get/one"};
const item = {state: "interrupted", error: "NETWORK_FAILED", danger: "safe", incognito: false, filename: "/Downloads/Movie (1).mp4",
  bytesReceived: 7100, totalBytes: 19000, mime: "video/mp4", referrer: page,
  url: "https://cdn.example/file?id=one&sig=old", finalUrl: "https://cdn.example/file?id=one&sig=old"} as chrome.downloads.DownloadItem;

it("finds the same link, or the same name started from the same page when the page renewed the link", () => {
  expect(matchesInterruptedFile(item, page, offer)).toBe(true);
  // Without the page, only the exact link identifies the file; parameter order and fragments do not matter.
  expect(matchesInterruptedFile({...item, referrer: ""}, page, {...offer, url: "https://cdn.example/file?sig=old&id=one#t=3"})).toBe(true);
  expect(matchesInterruptedFile({...item, referrer: ""}, page, {...offer, url: "https://cdn.example/file?id=one&sig=fresh"})).toBe(false);
  expect(matchesInterruptedFile({...item, referrer: ""}, page, {...offer, url: "https://cdn.example/file?id=two&sig=fresh"})).toBe(false);
  expect(matchesInterruptedFile({...item, referrer: "https://site.example/f/two"}, page, offer)).toBe(false);
});

it.each(["accepted", "deepScannedSafe", "allowlistedByPolicy"])("offers Chrome's own resume for a download Chrome resolved as %s", danger => {
  expect(matchesInterruptedFile({...item, danger} as chrome.downloads.DownloadItem, page, {...offer, url: item.url})).toBe(true);
});

it.each([{bytesReceived: 0}, {bytesReceived: 19000}, {state: "complete"}, {state: "in_progress"}, {incognito: true},
  {danger: "uncommon"}, {danger: "asyncScanning"}, {danger: "deepScannedFailed"}, {danger: "promptForScanning"},
  {error: "USER_CANCELED"}, {error: "SERVER_UNAUTHORIZED"}, {error: "FILE_BLOCKED"},
  // A video name is no content check: without a declared video type, the file is downloaded afresh and verified.
  {mime: "application/octet-stream"}, {mime: ""}] as Partial<chrome.downloads.DownloadItem>[])(
  "ignores ineligible Chrome receipts %j", change => {
    expect(matchesInterruptedFile({...item, ...change}, page, {...offer, url: item.url})).toBe(false);
  });

it("keeps a resumed download only while what the server declared for it is still a video", async () => {
  const done = {...item, id: 4, state: "complete", bytesReceived: 19000, totalBytes: 19000} as chrome.downloads.DownloadItem;
  const api = (finished: chrome.downloads.DownloadItem | undefined) => ({
    search: vi.fn(async () => finished ? [finished] : []), removeFile: vi.fn(async () => undefined)});
  const kept = api(done);
  expect(await settleResumedDownload(kept, 4)).toBeNull();
  expect(kept.removeFile).not.toHaveBeenCalled();

  // An expired link answered the resume with a web page, and Chrome wrote that into the file: it is removed and said plainly.
  const page = api({...done, mime: "text/html", bytesReceived: 62, totalBytes: 62} as chrome.downloads.DownloadItem);
  expect(await settleResumedDownload(page, 4)).toEqual({code: "unexpected_media_response", severity: "terminal", response: "page", host: "cdn.example"});
  expect(page.removeFile).toHaveBeenCalledWith(4);
  const data = api({...done, mime: "application/json"} as chrome.downloads.DownloadItem);
  expect(await settleResumedDownload(data, 4)).toMatchObject({code: "unexpected_media_response", response: "data"});
  expect(data.removeFile).toHaveBeenCalledWith(4);
  // A file that is already gone gives the same answer.
  const gone = {search: vi.fn(async () => [{...done, mime: ""} as chrome.downloads.DownloadItem]), removeFile: vi.fn(async () => { throw new Error("no file"); })};
  expect(await settleResumedDownload(gone, 4)).toMatchObject({code: "unexpected_media_response", response: "data"});
  // A download that is not finished, or not known any more, is not judged here.
  for (const other of [api(undefined), api({...done, state: "interrupted", mime: "text/html"} as chrome.downloads.DownloadItem)]) {
    expect(await settleResumedDownload(other, 4)).toBeNull();
    expect(other.removeFile).not.toHaveBeenCalled();
  }
});

it("does not let the browser resume a link whose own check was answered with something that is no video", () => {
  const failure = (error: JobError, url = "https://site.example/get/one?b=2&a=1") => ({url, error});
  const page: JobError = {code: "unexpected_media_response", severity: "terminal", response: "page"};
  expect(answeredWithoutVideo([failure(page)], "https://site.example/get/one?a=1&b=2")).toBe(true);
  expect(answeredWithoutVideo([failure({...page, response: "unsupported"})], "https://site.example/get/one?a=1&b=2")).toBe(true);
  // Another link's answer, and a server that was busy or refused the check, say nothing about this file's resume.
  expect(answeredWithoutVideo([failure(page, "https://site.example/get/two")], "https://site.example/get/one?a=1&b=2")).toBe(false);
  expect(answeredWithoutVideo([failure({code: "server_busy", severity: "terminal", phase: "direct", url: "https://site.example/get/one", httpStatus: 503,
    retryAfterSeconds: 90} as JobError)], "https://site.example/get/one?a=1&b=2")).toBe(false);
  expect(answeredWithoutVideo([], "https://site.example/get/one")).toBe(false);
});
