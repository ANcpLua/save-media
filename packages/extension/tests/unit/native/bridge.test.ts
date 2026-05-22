import { describe, it, expect, vi } from "vitest";
import {
  createNativeBridge,
  NativeHostNotAvailableError,
  NativeHostProtocolError,
  type NativePort,
} from "../../../src/native/bridge";
import type { HostResponse } from "../../../src/native/types";

interface FakePortFixture {
  port: NativePort;
  emit: (msg: HostResponse) => void;
  emitDisconnect: () => void;
  sent: unknown[];
}

function makeFakePort(): FakePortFixture {
  const sent: unknown[] = [];
  const messageListeners: Array<(msg: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const port: NativePort = {
    onMessage: {
      addListener: (cb: (msg: unknown) => void) => messageListeners.push(cb),
      removeListener: () => undefined,
    },
    onDisconnect: { addListener: (cb: () => void) => disconnectListeners.push(cb) },
    postMessage: (msg: unknown) => { sent.push(msg); },
    disconnect: () => undefined,
  };
  return {
    port,
    emit: (msg) => messageListeners.forEach(cb => cb(msg)),
    emitDisconnect: () => disconnectListeners.forEach(cb => cb()),
    sent,
  };
}

describe("createNativeBridge", () => {
  it("ping → resolves with the matching pong response", async () => {
    const fake = makeFakePort();
    const bridge = createNativeBridge(() => fake.port);
    const promise = bridge.request({ type: "ping", version: "1.0" });
    // Inspect the wire request: nonce was injected.
    expect(fake.sent).toHaveLength(1);
    const sent = fake.sent[0] as { type: string; nonce: string; version: string };
    expect(sent.type).toBe("ping");
    expect(sent.version).toBe("1.0");
    expect(sent.nonce).toMatch(/^nm-/);
    // Reply.
    fake.emit({
      type: "pong",
      nonce: sent.nonce,
      host: "savemedia-host",
      version: "0.0.1",
      capabilities: ["sink", "ytdlp"],
    });
    const r = await promise;
    if (r.type !== "pong") throw new Error("expected pong");
    expect(r.capabilities).toEqual(["sink", "ytdlp"]);
  });

  it("error response rejects with NativeHostProtocolError", async () => {
    const fake = makeFakePort();
    const bridge = createNativeBridge(() => fake.port);
    const promise = bridge.request({ type: "ping", version: "1" });
    const sent = fake.sent[0] as { nonce: string };
    fake.emit({
      type: "error",
      nonce: sent.nonce,
      code: "native_host_dependency",
      detail: "yt-dlp not on PATH",
    });
    await expect(promise).rejects.toBeInstanceOf(NativeHostProtocolError);
  });

  it("disconnect rejects all pending requests with NativeHostNotAvailableError", async () => {
    const fake = makeFakePort();
    const bridge = createNativeBridge(() => fake.port);
    const a = bridge.request({ type: "ping", version: "1" });
    const b = bridge.request({ type: "probe", url: "https://x" });
    fake.emitDisconnect();
    await expect(a).rejects.toBeInstanceOf(NativeHostNotAvailableError);
    await expect(b).rejects.toBeInstanceOf(NativeHostNotAvailableError);
  });

  it("connectNative throwing surfaces NativeHostNotAvailableError", async () => {
    const bridge = createNativeBridge(() => { throw new Error("manifest not registered"); });
    await expect(bridge.request({ type: "ping", version: "1" }))
      .rejects.toBeInstanceOf(NativeHostNotAvailableError);
  });

  it("requestStream forwards progress messages and resolves on terminal response", async () => {
    const fake = makeFakePort();
    const bridge = createNativeBridge(() => fake.port);
    const onProgress = vi.fn();
    const promise = bridge.requestStream(
      { type: "download.ytdlp", url: "https://x", quality: "best", outputDir: "/tmp" },
      onProgress,
    );
    const sent = fake.sent[0] as { nonce: string };
    fake.emit({ type: "progress", nonce: sent.nonce, bytesWritten: 1, bytesTotal: 100, phase: "downloading" });
    fake.emit({ type: "progress", nonce: sent.nonce, bytesWritten: 50, bytesTotal: 100, phase: "downloading" });
    fake.emit({
      type: "complete",
      nonce: sent.nonce,
      outputPath: "/tmp/out.mp4",
      bytesWritten: 100,
      checksum: "abc",
    });
    const r = await promise;
    expect(r.type).toBe("complete");
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it("ignores messages with mismatched nonces (cross-request safety)", async () => {
    const fake = makeFakePort();
    const bridge = createNativeBridge(() => fake.port);
    const promise = bridge.request({ type: "ping", version: "1" });
    fake.emit({
      type: "pong",
      nonce: "stranger",
      host: "x",
      version: "y",
      capabilities: [],
    });
    expect(globalThis).toBeDefined();
    // promise still pending — emit the correct response now
    const sent = fake.sent[0] as { nonce: string };
    fake.emit({
      type: "pong",
      nonce: sent.nonce,
      host: "savemedia-host",
      version: "0.0.1",
      capabilities: [],
    });
    const r = await promise;
    if (r.type !== "pong") throw new Error("expected pong");
    expect(r.host).toBe("savemedia-host");
  });
});
