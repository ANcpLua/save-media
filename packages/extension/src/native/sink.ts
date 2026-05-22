import type { NativeBridge } from "./bridge";
import { NATIVE_SINK_CHUNK_BYTES } from "./types";

/**
 * Stream a Blob to the native host's sink in 1 MB chunks. Used when the
 * estimated output size exceeds the in-browser 2 GB ceiling.
 */
export interface StreamSinkResult {
  readonly outputPath: string;
  readonly bytesWritten: number;
  readonly checksum: string;
}

export async function streamToNativeSink(
  bridge: NativeBridge,
  filename: string,
  source: Blob,
  signal: AbortSignal,
  onProgress: (bytesWritten: number, bytesTotal: number) => void,
): Promise<StreamSinkResult> {
  if (signal.aborted) throw new DOMException("user-cancelled", "AbortError");

  const opened = await bridge.request({
    type: "sink.open",
    filename,
    expectedSize: source.size,
  });
  if (opened.type !== "sink.opened") {
    throw new Error(`expected sink.opened, got ${opened.type}`);
  }
  const sinkId = opened.sinkId;
  let offset = 0;
  const sha = await hashBlob(source);

  try {
    const reader = source.stream().getReader();
    while (true) {
      if (signal.aborted) {
        await bridge.request({ type: "sink.abort", sinkId });
        throw new DOMException("user-cancelled", "AbortError");
      }
      const { value, done } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.byteLength; i += NATIVE_SINK_CHUNK_BYTES) {
        const slice = value.subarray(i, Math.min(i + NATIVE_SINK_CHUNK_BYTES, value.byteLength));
        const ack = await bridge.request({
          type: "sink.chunk",
          sinkId,
          offset,
          dataB64: bytesToBase64(slice),
        });
        if (ack.type !== "sink.ack") {
          throw new Error(`expected sink.ack, got ${ack.type}`);
        }
        offset = ack.bytesAcked;
        onProgress(offset, source.size);
      }
    }
    const done = await bridge.request({
      type: "sink.close",
      sinkId,
      finalChecksum: sha,
    });
    if (done.type !== "complete") {
      throw new Error(`expected complete, got ${done.type}`);
    }
    return { outputPath: done.outputPath, bytesWritten: done.bytesWritten, checksum: done.checksum };
  } catch (err) {
    if (!signal.aborted) {
      try { await bridge.request({ type: "sink.abort", sinkId }); } catch { /* ignore */ }
    }
    throw err;
  }
}

async function hashBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  // btoa needs a binary string; do it in 32 KB chunks so we don't blow the
  // JS string length for very large slices.
  const CHUNK = 32 * 1024;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}
