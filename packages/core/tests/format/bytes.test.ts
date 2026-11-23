import { describe, expect, it } from "vitest";
import { formatBytes } from "../../src/format/bytes";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"], [1, "1 B"], [1023, "1023 B"], [1024, "1.0 KB"], [1536, "1.5 KB"], [1024 ** 2 - 1, "1024.0 KB"],
    [1024 ** 2, "1.0 MB"], [1.5 * 1024 ** 2, "1.5 MB"], [245.3 * 1024 ** 2, "245.3 MB"], [1024 ** 3, "1.00 GB"], [2 * 1024 ** 3, "2.00 GB"],
  ])("%d bytes is %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });

  it("treats a missing or negative amount as nothing", () => {
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});
