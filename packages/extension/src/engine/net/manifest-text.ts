import { manifestTooLarge, MAX_MANIFEST_BYTES } from "@savemedia/core";

interface TextResponse {
  readonly body?: unknown;
  text(): Promise<string>;
}

interface ChunkReader { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> }

/**
 * A playlist's or manifest's text, read as a stream and refused above the
 * limit instead of filling memory. Capture and the jobs read every manifest
 * through this, so an endless body ends as manifest_too_large.
 */
export async function readManifestText(response: TextResponse, url: string, receivedBytes?: (bytes: number) => void): Promise<string> {
  const body = response.body as { getReader?: () => ChunkReader } | null | undefined;
  const reader = body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (text.length > MAX_MANIFEST_BYTES) throw manifestTooLarge(url, "bytes");
    return text;
  }
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    receivedBytes?.(value.byteLength);
    received += value.byteLength;
    if (received > MAX_MANIFEST_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw manifestTooLarge(url, "bytes");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
