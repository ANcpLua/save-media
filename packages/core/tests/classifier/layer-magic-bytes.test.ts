import { describe, expect, it } from "vitest";
import { classifyByMagicBytes } from "../../src/classifier/layer-magic-bytes";

const ftypIsom = (() => {
  const b = new Uint8Array(16);
  b.set([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70]);
  b.set(new TextEncoder().encode("isom"), 8);
  return b;
})();

describe("layer-magic-bytes", () => {
  it("ftyp isom → container=mp4 confidence=confirmed", () => {
    const r = classifyByMagicBytes(ftypIsom);
    expect(r.container).toBe("mp4");
    expect(r.confidence.container).toBe("confirmed");
  });

  it("empty bytes → unknown guessed", () => {
    const r = classifyByMagicBytes(new Uint8Array(0));
    expect(r.container).toBe("unknown");
    expect(r.confidence.container).toBe("guessed");
  });
});
