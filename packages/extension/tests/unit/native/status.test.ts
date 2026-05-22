import { describe, it, expect } from "vitest";
import { probeNativeHost, lastKnownStatus } from "../../../src/native/status";
import type { NativePort } from "../../../src/native/bridge";

function port(): {
  port: NativePort;
  emit: (msg: unknown) => void;
  emitDisconnect: () => void;
} {
  const listeners: Array<(msg: unknown) => void> = [];
  const disconnects: Array<() => void> = [];
  return {
    port: {
      onMessage: {
        addListener: (cb: (msg: unknown) => void) => listeners.push(cb),
        removeListener: () => undefined,
      },
      onDisconnect: { addListener: (cb: () => void) => disconnects.push(cb) },
      postMessage: (sent: unknown) => {
        if ((sent as { type?: string }).type === "ping") {
          queueMicrotask(() => {
            listeners.forEach(cb => cb({
              type: "pong",
              nonce: (sent as { nonce: string }).nonce,
              host: "savemedia-host",
              version: "0.0.1",
              capabilities: ["sink", "ytdlp", "probe"],
            }));
          });
        }
      },
      disconnect: () => disconnects.forEach(cb => cb()),
    },
    emit: (msg) => listeners.forEach(cb => cb(msg)),
    emitDisconnect: () => disconnects.forEach(cb => cb()),
  };
}

describe("probeNativeHost", () => {
  it("reports available + capabilities on a successful pong", async () => {
    const fixture = port();
    const status = await probeNativeHost(() => fixture.port);
    expect(status.available).toBe(true);
    expect(status.version).toBe("0.0.1");
    expect(status.capabilities).toEqual(["sink", "ytdlp", "probe"]);
    expect(lastKnownStatus()?.available).toBe(true);
  });

  it("reports unavailable + lastError when connect throws", async () => {
    const status = await probeNativeHost(() => { throw new Error("not registered"); });
    expect(status.available).toBe(false);
    expect(status.lastError).toContain("not registered");
  });
});
