import { describe, expect, it } from "vitest";
import { altSAction, type KeyFacts } from "../../../src/content/hotkey";

const key = (over: Partial<KeyFacts> = {}): KeyFacts => ({ isTrusted: true, repeat: false, altKey: true, ctrlKey: false, metaKey: false,
  shiftKey: false, code: "KeyS", editable: false, ...over });

describe("the page's Alt+S key rule", () => {
  it("takes Alt+S while the command is bound to it, and only asks while that is not known yet", () => {
    expect(altSAction(key(), true)).toBe("take");
    expect(altSAction(key(), null)).toBe("send");
  });

  it("ignores Alt+S when the user changed or cleared the shortcut", () => {
    expect(altSAction(key(), false)).toBe("ignore");
  });

  it("never reacts to Ctrl+S, Cmd+S, Alt+Shift+S, Ctrl+Alt+S or a plain S", () => {
    for (const over of [{ altKey: false, ctrlKey: true }, { altKey: false, metaKey: true }, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: false }]) {
      for (const altS of [true, false, null]) expect(altSAction(key(over), altS), JSON.stringify(over)).toBe("ignore");
    }
  });

  it("ignores other keys, repeats, text fields and events a script made up", () => {
    for (const over of [{ code: "KeyD" }, { repeat: true }, { editable: true }, { isTrusted: false }]) {
      expect(altSAction(key(over), true), JSON.stringify(over)).toBe("ignore");
    }
  });
});
