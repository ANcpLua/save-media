import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { probeInitSegment } from "../../../src/parser/init-segment/probe";

const __dirname = dirname(fileURLToPath(import.meta.url));
const initBytes = (n: string) =>
  new Uint8Array(readFileSync(resolve(__dirname, `../../fixtures/init-segments/${n}`)));

describe("probeInitSegment", () => {
  it("h264-baseline.mp4 returns avc1.* codec string", async () => {
    const r = await probeInitSegment(initBytes("h264-baseline.mp4"));
    expect(r.videoCodec?.rfc6381).toMatch(/^avc1\./);
    expect(r.videoCodec?.family).toBe("h264");
  });

  it("malformed bytes returns probeFailed", async () => {
    const r = await probeInitSegment(new Uint8Array([0, 1, 2, 3]));
    expect(r.probeFailed).toBe(true);
    expect(r.videoCodec).toBeNull();
  }, 10000);
});
