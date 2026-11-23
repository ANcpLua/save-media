import { AES_128_KEY_BYTES, BROWSER_OUTPUT_LIMIT_BYTES, isDecryptableLength, segmentIv, type HlsSegmentKey, type JobError } from "@savemedia/core";
import { HlsKeyring, KeyMaterialError, decryptSegment } from "./crypto/hls-aes";
import { fetchWithRetry } from "./net/fetch-with-retry";
import { classifyNetworkFailure } from "./net/error-classification";
import { recoverRequest, responseHeaders } from "./net/range-recovery";
import { readThroughOutages } from "./net/reconnect";
import { isTransferError, TransferError, transportFailure } from "./net/transfer-error";
import { identifyResponse } from "./verify-direct";
import { BlobParts } from "./blob-parts";

export type Request = typeof fetchWithRetry;

/**
 * Playlists, keys and segments are requested the way the page's own player
 * requests them: with the user's cookies, and (prepareRequests) with the
 * page's Referer on every host the playlist names. A refusal is then the
 * server's answer to the player's request, not to a bare one of ours.
 */
export const AS_THE_PLAYER: RequestInit = { credentials: "include", cache: "default" };

/**
 * One response body, chunk by chunk, with the checks every media read makes:
 * the size the browser can hold, and the length the server stated.
 */
async function readBody(url: string, attemptSignal: AbortSignal, request: Request, receivedBytes: () => void,
  take: (chunk: Uint8Array) => void, begin?: (statedBytes: number | null) => void): Promise<void> {
  const response = await request(url, attemptSignal, "segment", AS_THE_PLAYER);
  // The length the server states for the body, when the body is sent as it is (no content coding).
  const declared = response.headers.get("content-length");
  const encoding = response.headers.get("content-encoding");
  const stated = (!encoding || encoding === "identity") && declared && /^\d+$/.test(declared) ? Number(declared) : null;
  begin?.(stated);
  const reader = response.body?.getReader();
  if (!reader) {
    take(new Uint8Array(await response.arrayBuffer()));
    return;
  }
  let size = 0;
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try { next = await reader.read(); }
      catch (error) { throw transportFailure(error, url, "body", size); }
      if (next.done) break;
      size += next.value.byteLength;
      if (size >= BROWSER_OUTPUT_LIMIT_BYTES) throw {code: "output_too_large_for_browser", severity: "terminal",
        estimatedBytes: size, limitBytes: BROWSER_OUTPUT_LIMIT_BYTES, measured: true} satisfies JobError;
      take(next.value);
      receivedBytes();
    }
    if (stated !== null && stated !== size) {
      throw new TransferError(size < stated ? "body-short" : "body-long", { url, received: size, expected: stated });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * One segment's bytes. A body that drops after its headers is read again at once. After an outage (no
 * answer, a stall, a busy server) the same segment is read again after a wait, as a direct file is, so a
 * connection that comes back within the waits costs nothing: the caller keeps the playlist it resolved and
 * the segments it already has. `onWait` hears each wait before it starts.
 *
 * A stall is not read again at once (stallOf): each one is one of the reconnects, so a server that
 * accepts the connection and then sends nothing holds a save for six stalls and the five waits between
 * them, about five minutes, and not for three stalls before every reconnect.
 */
export async function readSegment(url: string, signal: AbortSignal, request: Request, onWait: (waitMs: number) => void = () => undefined): Promise<Uint8Array> {
  return readThroughOutages(() => recoverRequest(async (attemptSignal, receivedBytes) => {
    const segment = new SegmentBytes();
    try {
      await readBody(url, attemptSignal, request, receivedBytes, chunk => segment.take(chunk), stated => segment.expect(stated));
    } catch (error) {
      throw stallOf(error, attemptSignal, url) ?? error;
    }
    return segment.bytes();
  }, signal, 3), signal, onWait);
}

/**
 * A read that stalled: the server sent nothing for as long as a request waits for a byte. That time is
 * spent, so the request's quick retries count as made: the same request is not repeated at once, and the
 * stall goes to the reconnects as one outage, like a request that got no answer after its own retries.
 */
function stallOf(error: unknown, attemptSignal: AbortSignal, url: string): TransferError | null {
  const stalled = isTransferError(error, "timeout") || (attemptSignal.aborted && (attemptSignal.reason as { name?: unknown } | undefined)?.name === "TimeoutError");
  if (!stalled) return null;
  const facts = isTransferError(error) ? error.facts : { url, during: "body" as const };
  return new TransferError("timeout", { ...facts, retriesSpent: true }, false);
}

/**
 * One segment's bytes in one buffer. A length the server states sizes the buffer before the first byte
 * arrives, so a segment as long as the video is held once, not once as chunks and again joined. Without
 * a stated length the chunks are joined at the end.
 */
class SegmentBytes {
  private whole: Uint8Array | null = null;
  private used = 0;
  private chunks: Uint8Array[] = [];

  expect(statedBytes: number | null): void {
    if (statedBytes === null || statedBytes >= BROWSER_OUTPUT_LIMIT_BYTES) return;
    try { this.whole = new Uint8Array(statedBytes); } catch { /* no room for one buffer: joined at the end */ }
  }

  take(chunk: Uint8Array): void {
    if (this.whole && this.used + chunk.byteLength <= this.whole.byteLength) {
      this.whole.set(chunk, this.used);
      this.used += chunk.byteLength;
      return;
    }
    // More bytes than were stated: the read refuses this body at its end. Until then they are kept as they come.
    if (this.whole) {
      this.chunks.push(this.whole.subarray(0, this.used));
      this.whole = null;
    }
    this.chunks.push(chunk);
  }

  bytes(): Uint8Array {
    if (this.whole) return this.used === this.whole.byteLength ? this.whole : this.whole.subarray(0, this.used);
    return this.chunks.length === 1 ? this.chunks[0]! : concatBytes(this.chunks);
  }
}

/** The first bytes of a file, enough to say what it is. */
const HEAD_BYTES = 4096;

/**
 * An address that is a whole track by itself, such as a DASH representation
 * kept in one file. It can be as long as the video, so it is folded into
 * Blobs as it arrives and never held in the engine document's memory.
 * `identify` sees the file's first bytes once, before the rest is read: it
 * says what the file is, or refuses by throwing. `onBytes` gets the bytes
 * received so far. A body that drops is read again from its start, like a
 * segment.
 */
export async function readFile<T>(url: string, signal: AbortSignal, request: Request,
  identify: (head: Uint8Array) => T, onBytes: (received: number) => void): Promise<{ readonly file: Blob; readonly identity: T }> {
  return recoverRequest(async (attemptSignal, receivedBytes) => {
    const parts = new BlobParts();
    const head = new Uint8Array(HEAD_BYTES);
    let identity: { readonly is: T } | undefined;
    await readBody(url, attemptSignal, request, receivedBytes, chunk => {
      if (parts.size < head.length) head.set(chunk.subarray(0, head.length - parts.size), parts.size);
      parts.append(chunk);
      if (!identity && parts.size >= head.length) identity = { is: identify(head) };
      onBytes(parts.size);
    });
    identity ??= { is: identify(head.subarray(0, parts.size)) };
    return { file: parts.toBlob(), identity: identity.is };
  }, signal, 3);
}

/** The AES-128 keys of one stream, each fetched once, the way the player fetches them. */
export function playerKeyring(signal: AbortSignal, request: Request): HlsKeyring {
  return new HlsKeyring(keyUri => fetchKeyBytes(keyUri, signal, request));
}

/**
 * The key is a 16-byte file on the same HTTP the player uses. A key server
 * that answers the player's own request with 401, 402 or 403 is handing out
 * licences, not keys: that stream is licence bound and stays refused. A page
 * or data document in place of the key is reported as what it is; any other
 * answer is not an AES-128 key, and savemedia does not guess at encryption.
 */
async function fetchKeyBytes(keyUri: string, signal: AbortSignal, request: Request): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await request(keyUri, signal, "manifest", AS_THE_PLAYER);
  } catch (err) {
    if (signal.aborted) throw err;
    const status = isTransferError(err, "http-status") ? err.facts.status ?? 0 : 0;
    if (status === 401 || status === 402 || status === 403) {
      throw { code: "license_bound_stream", severity: "terminal", keyUri, httpStatus: status } satisfies JobError;
    }
    throw classifyNetworkFailure(err, "manifest", keyUri) ?? err;
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    signal.throwIfAborted();
    throw { code: "network_unreachable", severity: "terminal", phase: "manifest", url: originOf(keyUri), during: "transfer" } satisfies JobError;
  }
  if (bytes.byteLength !== AES_128_KEY_BYTES) {
    const identity = identifyResponse(bytes, responseHeaders(response));
    throw { code: "hls_key_unusable", severity: "terminal", keyUri, byteLength: bytes.byteLength,
      response: identity.kind === "document" ? identity.response : "binary" } satisfies JobError;
  }
  return bytes;
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return ""; }
}

/**
 * A page or data document where a segment was expected says what it is.
 * Only its bytes decide: segment servers often declare a wrong type.
 */
export function refuseDocument(bytes: Uint8Array): void {
  const identity = identifyResponse(bytes.subarray(0, 4096), {});
  if (identity.kind === "document") throw { code: "unexpected_media_response", severity: "terminal", response: identity.response } satisfies JobError;
}

/**
 * One segment's plain bytes. A segment its key covers is decrypted with that
 * key. Ciphertext that is not whole AES blocks is no AES-128 segment, and a
 * key that does not decrypt it is not the stream's key: either refuses
 * instead of writing garbage. `playlistUrl` names the media playlist.
 */
export async function plainSegmentBytes(body: Uint8Array, key: HlsSegmentKey | null, keyring: HlsKeyring,
  playlistUrl: string): Promise<Uint8Array> {
  if (!key) return body;
  if (!isDecryptableLength(body.byteLength)) {
    refuseDocument(body);
    throw { code: "hls_encryption_unsupported", severity: "terminal", manifestUrl: playlistUrl, method: "AES-128" } satisfies JobError;
  }
  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await keyring.keyFor(key.keyUri);
  } catch (err) {
    if (err instanceof KeyMaterialError) {
      throw { code: "hls_key_unusable", severity: "terminal", keyUri: err.keyUri, response: "binary", byteLength: err.byteLength } satisfies JobError;
    }
    throw err;
  }
  try {
    return await decryptSegment(cryptoKey, segmentIv(key.iv, key.mediaSequence), body);
  } catch {
    // WebCrypto rejects the padding a wrong key leaves.
    refuseDocument(body);
    throw { code: "hls_key_unusable", severity: "terminal", keyUri: key.keyUri, response: "rejected", byteLength: AES_128_KEY_BYTES } satisfies JobError;
  }
}

/**
 * An EXT-X-KEY that precedes EXT-X-MAP covers the init section too (RFC
 * 8216 4.3.2.4), but packagers also leave the section clear while declaring
 * the key first. Its own bytes decide: a section that opens with an ftyp box
 * is clear; any other is decrypted with its key.
 */
export async function plainInitSection(bytes: Uint8Array, key: HlsSegmentKey | null | undefined, keyring: HlsKeyring,
  playlistUrl: string): Promise<Uint8Array> {
  if (!key || startsWithFileType(bytes)) return bytes;
  return plainSegmentBytes(bytes, key, keyring, playlistUrl);
}

function startsWithFileType(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
