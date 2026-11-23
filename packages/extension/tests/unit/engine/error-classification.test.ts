import { describe, expect, it } from "vitest";
import { classifyNetworkFailure, classifyPlaylistReread } from "../../../src/engine/net/error-classification";
import { TransferError } from "../../../src/engine/net/transfer-error";

const status = (code: number, retryAfterMs?: number) =>
  new TransferError("http-status", { url: "https://cdn.example/seg.ts", status: code, retryAfterMs });

describe("classifyNetworkFailure", () => {
  it("separates rate limits from generic server failures", () => {
    expect(classifyNetworkFailure(status(429, 30_000), "segment", "https://cdn.example")).toMatchObject({
      code: "rate_limited",
      phase: "segment",
      httpStatus: 429,
      retryAfterSeconds: 30,
    });
  });

  it("separates busy origin/CDN failures from rate limits", () => {
    expect(classifyNetworkFailure(status(503), "manifest", "https://cdn.example")).toMatchObject({
      code: "server_busy",
      phase: "manifest",
      httpStatus: 503,
    });
  });

  it("treats payment/account/cookie failures as access control, not DRM", () => {
    expect(classifyNetworkFailure(status(402), "direct", "https://cdn.example"))
      .toMatchObject({ code: "access_denied", explanation: "payment-or-entitlement" });
    expect(classifyNetworkFailure(status(403), "direct", "https://cdn.example"))
      .toMatchObject({ code: "access_denied", explanation: "forbidden-or-expired-url" });
  });

  it("marks a refusing status for a playlist that is read again as the save starts, and nothing else", () => {
    expect(classifyPlaylistReread(status(404), "https://cdn.example/v.m3u8"))
      .toEqual({ code: "http_error", severity: "terminal", phase: "manifest", url: "https://cdn.example/v.m3u8", httpStatus: 404, atSaveStart: true });
    expect(classifyPlaylistReread(status(403), "https://cdn.example/v.m3u8")).toMatchObject({ code: "access_denied", atSaveStart: true });
    // A busy server, a rate limit and a lost connection say what they are: they are no refusal of the playlist.
    for (const error of [status(503), status(429), new TransferError("network", { url: "https://cdn.example/v.m3u8", during: "request" })]) {
      const classified = classifyPlaylistReread(error, "https://cdn.example/v.m3u8")!;
      expect(classified).toMatchObject({ phase: "manifest" });
      expect("atSaveStart" in classified).toBe(false);
    }
    expect(classifyPlaylistReread(new Error("other"), "https://cdn.example/v.m3u8")).toBeNull();
  });

  it("names a dropped connection by when it dropped, with the bytes in hand", () => {
    expect(classifyNetworkFailure(new TransferError("network", { url: "https://cdn.example/seg.ts", during: "request" }), "segment", "https://cdn.example"))
      .toEqual({ code: "network_unreachable", severity: "terminal", phase: "segment", url: "https://cdn.example", during: "request" });
    expect(classifyNetworkFailure(new TransferError("network", { url: "https://cdn.example/seg.ts", during: "body", received: 188, expected: 376 }),
      "segment", "https://cdn.example")).toMatchObject({ during: "transfer", receivedBytes: 188, totalBytes: 376 });
    expect(classifyNetworkFailure(new TransferError("timeout", { url: "https://cdn.example/seg.ts" }), "segment", "https://cdn.example"))
      .toMatchObject({ during: "timeout" });
  });

  it("leaves every other failure to its caller", () => {
    expect(classifyNetworkFailure(new TransferError("body-short", { url: "https://cdn.example/seg.ts" }), "segment", "x")).toBeNull();
    expect(classifyNetworkFailure({ url: "https://cdn.example", status: 403 }, "segment", "x")).toBeNull();
    expect(classifyNetworkFailure(new Error("boom"), "segment", "x")).toBeNull();
  });
});
