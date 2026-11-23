import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface ManifestCommand {
  readonly suggested_key?: Readonly<Record<string, string>>;
  readonly description?: string;
}

interface Manifest {
  readonly commands?: Readonly<Record<string, ManifestCommand>>;
  readonly incognito?: string;
  readonly permissions?: readonly string[];
  readonly optional_permissions?: readonly string[];
  readonly icons?: Readonly<Record<string, string>>;
  readonly action?: { readonly default_icon?: Readonly<Record<string, string>> };
}

describe("manifest commands", () => {
  it("registers Alt+S as the one-key best download command", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "manifest.json"), "utf8"),
    ) as Manifest;

    expect(manifest.commands?.["download-best"]).toMatchObject({
      suggested_key: {
        default: "Alt+S",
        mac: "Alt+S",
      },
    });
  });

  // An extension shared between normal and private windows makes its own requests with the normal windows'
  // cookies and records its saves in their download list. savemedia would link a private tab to the signed-in
  // user and leave the save in the normal history, so it cannot be turned on in private windows at all.
  it("cannot be turned on in private windows", () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "manifest.json"), "utf8")) as Manifest;
    expect(manifest.incognito).toBe("not_allowed");
  });

  // The page-world script is injected by content_scripts (world MAIN). Nothing loads an extension file by its
  // address, so no file is offered to websites: a listed file lets any site confirm savemedia by one request,
  // also where the user gave the extension no access.
  it.each(["manifest.json", "manifest.preview.json"])("%s offers no extension file to websites", file => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8")) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty("web_accessible_resources");
  });

  it("does not request scripting; storage only for local downloader settings", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "manifest.json"), "utf8"),
    ) as Manifest;

    expect(manifest.permissions ?? []).toContain("storage");
    expect(manifest.permissions ?? []).not.toContain("scripting");
  });

  it("keeps nativeMessaging optional so the store build asks only on opt-in", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "manifest.json"), "utf8"),
    ) as Manifest;

    expect(manifest.permissions ?? []).not.toContain("nativeMessaging");
    expect(manifest.optional_permissions).toEqual(["nativeMessaging"]);
  });

  it("declares store-ready package and action icons", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "manifest.json"), "utf8"),
    ) as Manifest;

    expect(manifest.icons).toEqual({
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
    });
    expect(manifest.action?.default_icon).toEqual(manifest.icons);
  });
});

describe("manifest: frames and navigation", () => {
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "manifest.json"), "utf8")) as Manifest & {
    readonly content_scripts?: readonly { readonly world?: string; readonly all_frames?: boolean; readonly match_origin_as_fallback?: boolean; readonly run_at?: string }[];
  };

  it("asks for webNavigation, so the frame tree and each frame's document survive a service worker restart", () => {
    expect(manifest.permissions ?? []).toContain("webNavigation");
  });

  it("runs both content scripts in every frame, about:blank, srcdoc, blob: and data: frames included", () => {
    expect(manifest.content_scripts?.map(script => script.world)).toEqual(["MAIN", "ISOLATED"]);
    for (const script of manifest.content_scripts ?? []) {
      expect(script).toMatchObject({ all_frames: true, match_origin_as_fallback: true, run_at: "document_start" });
    }
  });
});
