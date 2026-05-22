import { describe, it, expect } from "vitest";
import { escalateToYtdlp } from "../../../src/native/ytdlp";
import type { NativeBridge } from "../../../src/native/bridge";
import type { HostResponse } from "../../../src/native/types";

function bridge(response: HostResponse): NativeBridge {
  return {
    isConnected: () => true,
    disconnect: () => undefined,
    requestStream: () => Promise.reject(new Error("not used")),
    async request() { return response; },
  };
}

describe("escalateToYtdlp", () => {
  it("forwards URL + quality + outputDir to the bridge and unwraps complete", async () => {
    const sent: unknown[] = [];
    const b: NativeBridge = {
      isConnected: () => true,
      disconnect: () => undefined,
      requestStream: () => Promise.reject(new Error("not used")),
      async request(req: unknown) {
        sent.push(req);
        return {
          type: "complete",
          nonce: "x",
          outputPath: "/tmp/out.mp4",
          bytesWritten: 1000,
          checksum: "abc",
        } as HostResponse;
      },
    };
    const r = await escalateToYtdlp(b, { url: "https://x", quality: "best", outputDir: "/tmp" });
    expect(r).toEqual({ outputPath: "/tmp/out.mp4", bytesWritten: 1000, checksum: "abc" });
    expect(sent[0]).toMatchObject({
      type: "download.ytdlp",
      url: "https://x",
      quality: "best",
      outputDir: "/tmp",
    });
  });

  it("throws when response is not 'complete'", async () => {
    const b = bridge({
      type: "pong",
      nonce: "x",
      host: "h",
      version: "v",
      capabilities: [],
    });
    await expect(escalateToYtdlp(b, { url: "https://x", quality: "best", outputDir: "/tmp" }))
      .rejects.toThrow("yt-dlp escalation failed");
  });
});
