// Which side of the user's network an address is on, and what a page on the
// public internet may make savemedia request there.
//
// The rule: for a page on the internet, savemedia requests a server inside
// the user's network (this computer, a private or link-local address, a name
// that only resolves locally) only when the browser itself received an
// answer from that same origin at a local address, in the same tab. Then the
// browser has been there for this page and savemedia saves what it received.
// A local server the page only names is never requested: the browser's own
// permission for local network requests is the browser's to give.
//
// Whether an IP address is local is read by core's address parser
// (packages/core/src/net/address.ts), the same one the network-block
// explanation uses. A public name that resolves to a local address is only
// known once the browser reports where it connected.
//
// Which names only resolve locally is core's list too (isLocalHostName): a
// name of one label such as "nas", and the names under localhost, local,
// home.arpa and internal. Such a name is known to be local before any
// request, so a page on the internet never makes savemedia ask it.
import { addressScope, isLocalHostName, isLocalScope } from "@savemedia/core";

/** A loopback, private, link-local or carrier-shared address, or a name that only resolves locally. */
export function isPrivateAddress(hostOrIp: string | null | undefined): boolean {
  let host = (hostOrIp ?? "").trim().toLowerCase();
  if (!host) return false;
  // A name written as fully qualified ("localhost.") is the same name; so is an address written that way.
  if (host.endsWith(".")) host = host.slice(0, -1);
  const scope = addressScope(host);
  // Carrier-shared addresses (100.64.0.0/10) count here: a home router's outer side and overlay networks use them.
  if (scope !== null) return isLocalScope(scope) || scope === "shared";
  // An IPv6 address the parser does not read is no name. A caller passes a host name without a port.
  return !host.includes(":") && isLocalHostName(host);
}

/**
 * The first of these that is an http(s) address. A frame without an address
 * of its own (about:blank, srcdoc, blob:, data:) acts for the document that
 * made it, so its creator's address stands in.
 */
export function webPage(...candidates: readonly (string | null | undefined)[]): string | undefined {
  return candidates.find((value): value is string => !!value && /^https?:\/\//i.test(value));
}

function hostOf(url: string): string | null {
  try { return new URL(url).hostname; } catch { return null; }
}

/** The origin (scheme, host and port) of an http(s) address, else null. */
export function webOrigin(url: string | null | undefined): string | null {
  try {
    const { protocol, origin } = new URL(url ?? "");
    return protocol === "https:" || protocol === "http:" ? origin : null;
  } catch { return null; }
}

/**
 * True when a page on the public internet points at a server inside the
 * user's network: by the address in the link, or by the server address the
 * browser connected to. A page that is itself local may use local servers.
 */
export function publicPageToPrivateServer(pageUrl: string, targetUrl: string, serverIp?: string | null): boolean {
  const page = hostOf(pageUrl);
  if (page === null || isPrivateAddress(page)) return false;
  return isPrivateAddress(hostOf(targetUrl)) || isPrivateAddress(serverIp);
}

/**
 * Whether the browser itself received an answer from this address's origin
 * at a local address, in the tab at hand. Only the browser's own requests
 * count, never one savemedia made.
 */
export type ObservedLocal = (url: string) => boolean;

/**
 * True for a page with a public name whose own origin the browser reached at an address inside the user's
 * network: the page lives on an intranet under a name of its own, or the browser reaches the internet
 * through a proxy inside the network, whose address it then reports for every server. Either way, the
 * server address the browser reports for a request of that tab says nothing about where a public name
 * leads. Only an address that is itself local still tells a local server apart.
 */
export function reachedLocallyByName(pageUrl: string | null | undefined, observed: ObservedLocal | undefined): boolean {
  const host = pageUrl ? hostOf(pageUrl) : null;
  return host !== null && !isPrivateAddress(host) && (observed?.(pageUrl!) ?? false);
}

/** The test for a fixed list of origins, as a job carries it. */
export function observedAmong(origins: readonly string[] | undefined): ObservedLocal {
  const known = new Set(origins ?? []);
  return url => {
    const origin = webOrigin(url);
    return origin !== null && known.has(origin);
  };
}

/**
 * True when savemedia must not request `targetUrl` for this page, or must
 * not use an answer that came from `serverIp`: the page is on the internet,
 * the server is inside the user's network, and the browser itself has not
 * received anything from that origin there for this tab.
 */
export function unobservedLocalTarget(pageUrl: string, targetUrl: string, observed: ObservedLocal | undefined, serverIp?: string | null): boolean {
  return publicPageToPrivateServer(pageUrl, targetUrl, serverIp) && !(observed?.(targetUrl) ?? false);
}
