import type { StreamDescriptor } from "@savemedia/core";
import { declaredTotalBytes } from "./expected-size";

/**
 * The address that identifies a resource: its URL without the fragment,
 * with the query parameters in canonical order. Parameters are never
 * interpreted. Whether a different link is the same file is decided by the
 * server's validators and length (fileIdentity) or by comparing the bytes.
 */
export function canonicalAddress(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.searchParams.sort();
    return url.href;
  } catch { return value; }
}

type Sourced = Pick<StreamDescriptor, "source">;

/**
 * The one address a row stands for. A direct file can have two: "entry" is the
 * address savemedia requests, so the site's own redirect chooses the destination
 * again, and "final" is where the file was answered from, the server a message
 * or the Server row names. Every other kind of row has one address.
 */
export function sourceAddress(descriptor: Sourced, which: "entry" | "final" = "final"): string {
  const source = descriptor.source;
  if (source.kind === "direct-url") return which === "final" ? source.finalUrl ?? source.url : source.url;
  return source.kind === "media-element" ? source.elementSrc : source.manifestUrl;
}

/** Whether a row stands for this address: its entry address or the address it was answered from, compared as resources. */
export function hasAddress(descriptor: Sourced, url: string): boolean {
  const address = canonicalAddress(url);
  return [sourceAddress(descriptor, "entry"), sourceAddress(descriptor, "final")].some(own => canonicalAddress(own) === address);
}

/** Whether a row is the direct file at this address, such as the file a page offers by a link. */
export function offersFile(descriptor: Sourced, url: string): boolean {
  return descriptor.source.kind === "direct-url" && hasAddress(descriptor, url);
}

/**
 * A verified direct file's identity: its origin and path, its declared
 * length and its strong ETag or Last-Modified date, as its probe response
 * stated them. A link that differs only in a signature keeps this identity;
 * without both a length and a validator the canonical address stands alone.
 */
export function fileIdentity(url: string, headers: Readonly<Record<string, string>>): string {
  return validatedIdentity(url, headers) ?? canonicalAddress(url);
}

/** fileIdentity when the response stated both a length and a validator, else null. */
export function validatedIdentity(url: string, headers: Readonly<Record<string, string>>): string | null {
  const total = declaredTotalBytes(headers);
  const etag = headers.etag?.trim();
  const validator = etag && /^"[^"\r\n]*"$/.test(etag) ? etag : headers["last-modified"]?.trim();
  if (!total || !validator) return null;
  try {
    const { origin, pathname } = new URL(url);
    return JSON.stringify([origin + pathname, total, validator]);
  } catch { return null; }
}
