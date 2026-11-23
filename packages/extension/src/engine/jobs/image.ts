// One image, fetched once. The bytes that were checked are the bytes that
// are saved: nothing is requested a second time, so a server cannot show the
// check one file and the download another.
import { isJobError, type JobError } from "@savemedia/core";
import { IMAGE_EXTENSION, IMAGE_MIME, identifyBinaryImage, identifyImage, isText, notImageKind, type ImageType } from "../../util/image-signature";
import { unobservedLocalTarget, type ObservedLocal } from "../../util/address-space";
import { checkResponseStatus, rangeFailure, recoverRequest } from "../net/range-recovery";
import { transportFailure } from "../net/transfer-error";
import { BlobParts } from "../blob-parts";
import { concatBytes } from "../hls-segments";

export type ImageJobResult =
  | { readonly kind: "image"; readonly blob: Blob; readonly filename: string; readonly imageType: ImageType }
  | { readonly kind: "refused"; readonly received: "page" | "program" | "data" | "unknown" };

type ImageFetch = (url: string, init: RequestInit) => Promise<Response>;

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]+/g;

/**
 * The file name: the last path segment's stem with the extension of the
 * type the bytes are. The server's own name and extension are never used,
 * so a response cannot name the file it lands as.
 */
export function imageFilename(url: string, type: ImageType): string {
  let stem = "";
  if (/^https?:/i.test(url)) {
    try {
      const segment = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "");
      const dot = segment.lastIndexOf(".");
      stem = (dot > 0 ? segment.slice(0, dot) : segment).replace(ILLEGAL, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 120);
    } catch { stem = ""; }
  }
  return `${/[\p{L}\p{N}]/u.test(stem) ? stem : "image"}.${IMAGE_EXTENSION[type]}`;
}

/** The first bytes that decide what a response is, and the most text that is read to check an SVG. */
const HEAD_BYTES = 4096;
const MAX_SVG_BYTES = 16 * 1024 * 1024;

/**
 * The image is requested once. A request that delivers no byte for the stall window ends as a timeout, as
 * every other read of the engine does, so a server that stops answering cannot hold the save for good.
 */
export async function runImageJob(url: string, signal: AbortSignal, fetchFn: ImageFetch = (input, init) => fetch(input, init),
  pageUrl?: string, observed?: ObservedLocal): Promise<ImageJobResult> {
  try {
    return await recoverRequest((attemptSignal, receivedBytes) =>
      readImage(url, attemptSignal, receivedBytes, fetchFn, pageUrl, observed), signal, 1);
  } catch (error) {
    signal.throwIfAborted();
    throw rangeFailure(error, url, "direct");
  }
}

async function readImage(url: string, signal: AbortSignal, receivedBytes: () => void, fetchFn: ImageFetch,
  pageUrl: string | undefined, observed: ObservedLocal | undefined): Promise<ImageJobResult> {
  let response: Response;
  try {
    response = await fetchFn(url, /^data:/i.test(url) ? { signal } : { credentials: "include", signal });
  } catch (error) {
    throw transportFailure(error, url, "request");
  }
  checkResponseStatus(response, url);
  receivedBytes();
  // A redirect may have led a public page's image request into the user's network, to a server the browser
  // was not answered from for this tab: nothing of it is kept.
  if (pageUrl && response.url && unobservedLocalTarget(pageUrl, response.url, observed)) {
    void response.body?.cancel().catch(() => undefined);
    throw { code: "private_network_target", severity: "terminal", host: new URL(response.url).hostname } satisfies JobError;
  }
  // Folded into Blobs as the bytes arrive: the engine document never holds a large image as byte arrays.
  const parts = new BlobParts();
  // Text that may be an SVG is read whole to be checked, so its chunks are kept as well, up to MAX_SVG_BYTES.
  let text: Uint8Array[] | null = [];
  const head = new Uint8Array(HEAD_BYTES);
  let headLength = 0;
  let received = 0;
  // Decided once, by the first bytes: a binary image, text that may be an SVG, or a refusal.
  let found: Exclude<ImageType, "svg"> | "text" | null = null;
  let refused: ImageJobResult | null = null;
  const take = (chunk: Uint8Array): void => {
    parts.append(chunk);
    text?.push(chunk);
    received += chunk.byteLength;
    const fits = Math.min(chunk.byteLength, HEAD_BYTES - headLength);
    head.set(chunk.subarray(0, fits), headLength);
    headLength += fits;
  };
  const decide = (): void => {
    const first = head.subarray(0, headLength);
    found = identifyBinaryImage(first);
    if (found) {
      text = null;
      return;
    }
    const other = notImageKind(first);
    // A program, an archive, a web page or bytes that are no text: refused without reading the rest.
    if (other === "data" && isText(first)) found = "text";
    else refused = { kind: "refused", received: other };
  };
  const reader = response.body?.getReader();
  try {
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        take(value);
        receivedBytes();
        if (!found && !refused && headLength >= HEAD_BYTES) decide();
        // Text longer than any SVG image is not read to its end.
        if (found === "text" && received > MAX_SVG_BYTES) refused = { kind: "refused", received: "data" };
        if (refused) break;
      }
    } else take(new Uint8Array(await response.arrayBuffer()));
  } catch (error) {
    void reader?.cancel().catch(() => undefined);
    if (isJobError(error)) throw error;
    throw transportFailure(error, url, "body", received);
  }
  if (!found && !refused) decide();
  if (refused) {
    void reader?.cancel().catch(() => undefined);
    return refused;
  }
  // A binary image is known by its first bytes. SVG is text: all of it is read, so script anywhere refuses it.
  const type: ImageType | null = found === "text" ? (text && received <= MAX_SVG_BYTES ? identifyImage(concatBytes(text)) : null) : found;
  if (!type) return { kind: "refused", received: notImageKind(head.subarray(0, headLength)) };
  return { kind: "image", blob: parts.toBlob(IMAGE_MIME[type]), filename: imageFilename(url, type), imageType: type };
}
