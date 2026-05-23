import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface ManifestCommand {
  readonly suggested_key?: Readonly<Record<string, string>>;
  readonly description?: string;
}

interface Manifest {
  readonly commands?: Readonly<Record<string, ManifestCommand>>;
  readonly permissions?: readonly string[];
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

  it("does not request unused storage or scripting permissions", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "manifest.json"), "utf8"),
    ) as Manifest;

    expect(manifest.permissions ?? []).not.toContain("storage");
    expect(manifest.permissions ?? []).not.toContain("scripting");
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
