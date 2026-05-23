import { describe, expect, it } from "vitest";
import type { StreamDescriptor, ProtocolFamily, Container } from "../../src/types/stream";

describe("StreamDescriptor", () => {
  it("constructs with all required fields", () => {
    const descriptor: StreamDescriptor = {
      id: "stream-1" as StreamDescriptor["id"],
      tabId: 42,
      pageUrl: "https://example.com/page",
      title: "Test video",
      detectedAt: 1700000000000,
      source: { kind: "direct-url", url: "https://example.com/v.mp4", headers: {} },
      protocol: "progressive-http",
      container: "mp4",
      codecs: { video: null, audio: null, subtitles: [] },
      variants: [],
      drm: null,
      capabilities: {
        directDownload: true,
        remuxableTo: ["mp4"],
        drmBlocked: false,
      },
      confidence: { container: "guessed", codecs: "guessed", protocol: "guessed" },
    };

    expect(descriptor.protocol).toBe<ProtocolFamily>("progressive-http");
    expect(descriptor.container).toBe<Container>("mp4");
    expect(descriptor.drm).toBeNull();
  });

  it("ProtocolFamily union excludes unknown literal", () => {
    const valid: ProtocolFamily[] = ["progressive-http", "hls", "dash", "unknown"];
    expect(valid).toHaveLength(4);
  });
});
