import { describe, expect, it } from "vitest";
import { PAGE_REACH_KINDS, pageReach, type PageReachInput } from "../../../src/util/page-reach";
import { PAGE_REACH_TEXT, pageReachText } from "../../../src/ui/text";

const web: PageReachInput = { answered: false, url: "https://site.example/watch", status: "complete", observedLoad: true, fileAccess: false, hostAccess: true };

describe("why a page cannot be read", () => {
  it.each<[string, Partial<PageReachInput>, string]>([
    ["the content script answered", { answered: true }, "reachable"],
    ["it answered, whatever else is known", { answered: true, url: "chrome://settings", hostAccess: false, observedLoad: false }, "reachable"],
    ["a browser page", { url: "chrome://extensions" }, "not-web"],
    ["the new tab page", { url: "about:blank" }, "not-web"],
    ["no address at all", { url: undefined }, "not-web"],
    ["another extension's page", { url: "chrome-extension://abc/page.html" }, "not-web"],
    ["a file without file access", { url: "file:///Users/x/clip.html", hostAccess: false }, "file-access-off"],
    ["a file with file access, opened before the install", { url: "file:///Users/x/clip.html", fileAccess: true, hostAccess: false, observedLoad: false }, "needs-reload"],
    ["a site the user turned savemedia off for", { hostAccess: false }, "site-access-off"],
    ["a page that is still loading", { status: "loading" }, "loading"],
    ["a tab that was open before the install or update", { observedLoad: false }, "needs-reload"],
    ["a page that loaded under this worker and still has no content script", {}, "blocked"],
    ["a page the browser blocks for extensions: it loaded without an error", { loadFailed: false }, "blocked"],
    ["a tab whose last navigation failed shows the browser's error page", { loadFailed: true }, "load-failed"],
    ["a failed navigation in a tab that was open before the install", { loadFailed: true, observedLoad: false }, "load-failed"],
    ["a failed navigation while the tab still counts as loading", { loadFailed: true, status: "loading" }, "load-failed"],
    ["a page whose script answers is readable, whatever was reported before", { loadFailed: true, answered: true }, "reachable"],
  ])("%s", (_name, over, expected) => {
    expect(pageReach({ ...web, ...over })).toBe(expected);
  });

  it("has one plain text per state, and none for a readable page", () => {
    for (const kind of PAGE_REACH_KINDS) {
      const text = pageReachText(kind);
      if (kind === "reachable") { expect(text).toBeNull(); continue; }
      expect(text).toBe(PAGE_REACH_TEXT[kind]);
      expect(text!.title).toMatch(/\.$/);
      // No codes, no site's buttons, no em dashes.
      expect(`${text!.title} ${text!.body ?? ""}`).not.toMatch(/[_—]|button|click/i);
    }
    expect(PAGE_REACH_TEXT["needs-reload"].title).toBe("Reload this page so savemedia can see it.");
    expect(PAGE_REACH_TEXT["load-failed"]).toEqual({ title: "This page did not load. Reload it, then try again.",
      body: "Your browser shows its own error page in this tab." });
    expect(PAGE_REACH_TEXT["blocked"]).toEqual({ title: "Your browser does not let extensions read this page." });
    expect(pageReachText(null)).toBeNull();
  });
});
