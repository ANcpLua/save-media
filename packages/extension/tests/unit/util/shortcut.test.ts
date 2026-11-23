import { describe, expect, it } from "vitest";
import { isAltSShortcut, shortcutLabel } from "../../../src/util/shortcut";

describe("the save command's shortcut", () => {
  it("is Alt+S in every spelling the browser reports, and nothing else", () => {
    for (const shortcut of ["Alt+S", "\u2325S", "Alt + S", "alt+s"]) expect(isAltSShortcut(shortcut), shortcut).toBe(true);
    for (const shortcut of ["", undefined, "Ctrl+S", "Alt+Shift+S", "\u2318S"]) expect(isAltSShortcut(shortcut), String(shortcut)).toBe(false);
  });

  it("is named Alt+S in the popup when it is that, and as the browser writes it otherwise", () => {
    expect(shortcutLabel("\u2325S")).toBe("Alt+S");
    expect(shortcutLabel("Alt+S")).toBe("Alt+S");
    expect(shortcutLabel("Ctrl+Shift+Y")).toBe("Ctrl+Shift+Y");
    expect(shortcutLabel("\u2303\u21e7Y")).toBe("\u2303\u21e7Y");
    expect(shortcutLabel("")).toBe("");
  });
});
