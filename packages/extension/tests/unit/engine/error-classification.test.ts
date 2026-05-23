import { describe, expect, it } from "vitest";
import { classifyNetworkFailure } from "../../../src/engine/net/error-classification";

describe("classifyNetworkFailure", () => {
  it("separates rate limits from generic server failures", () => {
    const err = classifyNetworkFailure({
      url: "https://cdn.example/seg.ts",
      status: 429,
      attemptsRemaining: 0,
      retryAfterSeconds: 30,
      detail: "Too Many Requests",
    }, "segment", "https://fallback");

    expect(err).toMatchObject({
      code: "rate_limited",
      phase: "segment",
      httpStatus: 429,
      retryAfterSeconds: 30,
    });
  });

  it("separates busy origin/CDN failures from rate limits", () => {
    const err = classifyNetworkFailure({
      url: "https://cdn.example/media.m3u8",
      status: 503,
      attemptsRemaining: 0,
      retryAfterSeconds: null,
      detail: "Service Unavailable",
    }, "manifest", "https://fallback");

    expect(err).toMatchObject({
      code: "server_busy",
      phase: "manifest",
      httpStatus: 503,
    });
  });

  it("treats payment/account/cookie failures as access control, not DRM", () => {
    const paid = classifyNetworkFailure({
      url: "https://cdn.example/private.mp4",
      status: 402,
      attemptsRemaining: 0,
      retryAfterSeconds: null,
      detail: "Payment Required",
    }, "direct", "https://fallback");
    const forbidden = classifyNetworkFailure({
      url: "https://cdn.example/signed-expired.mp4",
      status: 403,
      attemptsRemaining: 0,
      retryAfterSeconds: null,
      detail: "Forbidden",
    }, "direct", "https://fallback");

    expect(paid).toMatchObject({ code: "access_denied", explanation: "payment-or-entitlement" });
    expect(forbidden).toMatchObject({ code: "access_denied", explanation: "forbidden-or-expired-url" });
  });
});
