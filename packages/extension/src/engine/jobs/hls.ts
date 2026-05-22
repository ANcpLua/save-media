import type {
  HlsPlainPlan,
  HlsAesPlan,
  StreamDescriptor,
  Variant,
  HlsEncryption,
} from "@savemedia/core";
import { RETRY_POLICY, computeBackoffMs, isRetryableStatus } from "@savemedia/core";
import type { JobResult, ProgressFn } from "../job";
import { parseHlsMediaPlaylistRuntime, type RuntimeSegment } from "../parsers/hls";
import { fetchWithRetry } from "../net/fetch-with-retry";

/**
 * Engine-side HLS job runner. Supports plain (clear) and AES-128 plans.
 * SAMPLE-AES / SAMPLE-AES-CTR / CDM-bound keys are filtered out at dispatch.
 */
export async function runHlsJob(
  plan: HlsPlainPlan | HlsAesPlan,
  descriptor: StreamDescriptor,
  onProgress: ProgressFn,
  signal: AbortSignal,
): Promise<JobResult> {
  const variant = findVariant(descriptor, plan.variantId);
  if (!variant) {
    throw {
      code: "no_variant_meets_minimum",
      severity: "terminal",
      minHeightRequired: 720,
      maxAvailableHeight: 0,
    };
  }

  const playlistUrl = playlistUrlOf(variant);
  if (!playlistUrl) {
    throw {
      code: "manifest_malformed",
      severity: "terminal",
      url: descriptor.pageUrl,
      parserError: "variant missing media playlist URL",
    };
  }

  onProgress(0, null, "fetching-playlist");
  const playlistResp = await fetchWithRetry(playlistUrl, signal, "manifest");
  const playlistText = await playlistResp.text();
  const media = parseHlsMediaPlaylistRuntime(playlistText, playlistUrl);

  if (media.segments.length === 0) {
    throw {
      code: "manifest_malformed",
      severity: "terminal",
      url: playlistUrl,
      parserError: "media playlist has zero segments",
    };
  }

  const cryptoKey = plan.kind === "hls-aes"
    ? await loadAesKey(plan.encryption, signal)
    : null;

  return fetchSegments(media.segments, plan, onProgress, signal, cryptoKey);
}

async function fetchSegments(
  segments: readonly RuntimeSegment[],
  plan: HlsPlainPlan | HlsAesPlan,
  onProgress: ProgressFn,
  signal: AbortSignal,
  cryptoKey: CryptoKey | null,
): Promise<JobResult> {
  const failed: number[] = [];
  let consecutiveFailures = 0;
  let bytesWritten = 0;
  const parts: BlobPart[] = [];

  for (let i = 0; i < segments.length; i++) {
    if (signal.aborted) {
      throw new DOMException("user-cancelled", "AbortError");
    }
    const seg = segments[i]!;
    try {
      const resp = await fetchWithRetry(seg.uri, signal, "segment");
      let body: Uint8Array = new Uint8Array(await resp.arrayBuffer());
      if (cryptoKey) {
        body = await decryptAes128(body, cryptoKey, seg, i);
      }
      parts.push(body as BlobPart);
      bytesWritten += body.byteLength;
      consecutiveFailures = 0;
      onProgress(bytesWritten, null, `segment ${i + 1}/${segments.length}`);
    } catch (err) {
      if (signal.aborted) throw err;
      failed.push(i);
      consecutiveFailures += 1;
      const overBudget = failed.length / segments.length > RETRY_POLICY.job.maxFailedSegmentRatio;
      const tooManyInARow = consecutiveFailures >= RETRY_POLICY.job.maxConsecutiveFailures;
      if (overBudget || tooManyInARow) {
        throw {
          code: "segment_budget_exhausted",
          severity: "terminal",
          failedSegments: failed,
          totalSegments: segments.length,
        };
      }
    }
  }

  if (signal.aborted) {
    throw new DOMException("user-cancelled", "AbortError");
  }

  onProgress(bytesWritten, bytesWritten, "muxing");
  const blob = new Blob(parts, { type: mimeForOutput(plan) });
  onProgress(bytesWritten, bytesWritten, "finalizing");
  return {
    blobUrl: URL.createObjectURL(blob),
    filename: plan.outputFilename,
    checksum: "",
  };
}

async function loadAesKey(encryption: HlsEncryption, signal: AbortSignal): Promise<CryptoKey> {
  const resp = await fetchWithRetry(encryption.keyUri, signal, "manifest");
  const raw = await resp.arrayBuffer();
  if (raw.byteLength !== 16) {
    throw {
      code: "license_bound_stream",
      severity: "terminal",
      keyUri: encryption.keyUri,
      httpStatus: resp.status,
    };
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-CBC", length: 128 }, false, ["decrypt"]);
}

async function decryptAes128(
  ciphertext: Uint8Array,
  key: CryptoKey,
  segment: RuntimeSegment,
  index: number,
): Promise<Uint8Array> {
  const iv = segment.iv ?? mediaSequenceIv(segment.mediaSequence ?? index);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: iv as BufferSource }, key, ciphertext as BufferSource);
  // Copy into a fresh ArrayBuffer-backed Uint8Array so callers can pass it
  // through Blob() without TS objecting about ArrayBufferLike vs ArrayBuffer.
  const out = new Uint8Array(plain.byteLength);
  out.set(new Uint8Array(plain));
  return out;
}

function mediaSequenceIv(sequenceNumber: number): Uint8Array {
  // HLS spec § 4.3.2.4: if IV is absent, the sequence number is the IV,
  // big-endian, padded to 16 bytes.
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  view.setUint32(12, sequenceNumber, false);
  return iv;
}

function findVariant(d: StreamDescriptor, variantId: string): Variant | null {
  for (const v of d.variants) if (v.id === variantId) return v;
  return d.variants[0] ?? null;
}

function playlistUrlOf(v: Variant): string | null {
  if (v.segmentRef.kind === "hls-segments") return v.segmentRef.playlistUrl;
  return null;
}

function mimeForOutput(plan: HlsPlainPlan | HlsAesPlan): string {
  switch (plan.outputContainer) {
    case "mp4": return "video/mp4";
    case "webm": return "video/webm";
    case "mkv": return "video/x-matroska";
  }
}

export { isRetryableStatus, computeBackoffMs };
