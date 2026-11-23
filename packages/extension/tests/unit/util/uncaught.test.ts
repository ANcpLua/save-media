import { describe, expect, it } from "vitest";
import { reportUncaught } from "../../../src/util/uncaught";

/** A scope that keeps its listeners, as a worker's or a document's global does. */
function scope() {
  const listeners = new Map<string, (event: unknown) => void>();
  return {
    addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.set(type, listener); },
    fire: (type: string, event: unknown) => listeners.get(type)!(event),
  };
}

describe("errors nothing caught", () => {
  it("reports a thrown error and an unhandled rejection, one short line each", () => {
    const global = scope();
    const seen: string[] = [];
    reportUncaught(global, detail => seen.push(detail));
    global.fire("error", { error: new TypeError("x is not a function"), message: "Uncaught TypeError: x is not a function" });
    global.fire("error", { message: "Script error." });
    global.fire("unhandledrejection", { reason: new RangeError("out of range") });
    global.fire("unhandledrejection", { reason: "plain words" });
    global.fire("unhandledrejection", { reason: undefined });
    expect(seen).toEqual(["TypeError: x is not a function", "Script error.", "RangeError: out of range", "plain words", "undefined"]);
  });

  it("never reports more than a short line of an error", () => {
    const global = scope();
    const seen: string[] = [];
    reportUncaught(global, detail => seen.push(detail));
    global.fire("error", { error: new Error("a".repeat(5000)) });
    expect(seen[0]!.length).toBe(500);
  });
});
