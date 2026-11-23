// When the user's network keeps savemedia from a media server, say so in
// plain words and say what the user can check. Nothing here goes around a
// block: this module only reads what the browser reported about a request
// savemedia already made. It asks nothing of the network and changes no
// setting.
//
// The browser's error codes choose wording only. They never change a request
// or a retry. Browsers rename codes, so a code this module does not know
// replaces no text: the error keeps its own words, and the code itself is
// shown under Technical details.
//
// Wording rules (the same in every text catalogue):
// - Title: what happened, at most about 8 words, sentence case, no period, no codes, no HTTP numbers, no protocol words.
// - Body: plain sentences on what happened. A server name appears only in network messages.
// - Hint: what the user can do, starting with a verb, or null when nothing helps.
// - Technical details: labelled rows for codes, statuses, hosts and addresses. Never a path or query. Last row: Error code.
// - Names: "savemedia" in lowercase, "your browser", "Downloads folder".
// - Never tell the user to use a site's button or control.
// - Never suggest a VPN, another DNS server, switching a filter off or any other way around a block.
import { addressScope, isLocalScope, isPublicHostName, SCOPE_LABEL } from "../net/address";
import type { BrowserRequestDiagnostic } from "./taxonomy";

/** The shape of a browser error code. Anything else a browser reports is prose and is not kept. */
export const BROWSER_ERROR_CODE = /^(?:net::ERR_|NS_ERROR_|NS_BINDING_|SEC_ERROR_|SSL_ERROR_|MOZILLA_PKIX_ERROR_)[A-Z0-9_]{1,80}$/;

export type NetworkBlockKind =
  | "private-address" | "name-not-found" | "dns-failed" | "untrusted-certificate" | "certificate-name"
  | "certificate-date" | "certificate-other" | "secure-connection" | "admin-policy" | "other-extension"
  | "firewall" | "proxy" | "offline" | "redirected-to-page";

export interface NetworkBlock {
  readonly kind: NetworkBlockKind;
  /** The server the message names. */
  readonly host: string;
  readonly ip: string | null;
  /** Where a redirect led, for "redirected-to-page". */
  readonly toHost: string | null;
  readonly code: string | null;
}

export interface NetworkBlockText {
  readonly title: string;
  readonly body: string;
  readonly hint: string;
  /** Whether trying again can help without the user changing anything else first. */
  readonly retry: boolean;
}

const ABORTED = new Set(["net::ERR_ABORTED", "NS_BINDING_ABORTED"]);
const UNTRUSTED = new Set(["net::ERR_CERT_AUTHORITY_INVALID", "net::ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN",
  "net::ERR_CERTIFICATE_TRANSPARENCY_REQUIRED", "SEC_ERROR_UNKNOWN_ISSUER", "SEC_ERROR_UNTRUSTED_ISSUER", "SEC_ERROR_CA_CERT_INVALID",
  "MOZILLA_PKIX_ERROR_MITM_DETECTED", "MOZILLA_PKIX_ERROR_SELF_SIGNED_CERT"]);
const CERTIFICATE_NAME = new Set(["net::ERR_CERT_COMMON_NAME_INVALID", "SSL_ERROR_BAD_CERT_DOMAIN"]);
const CERTIFICATE_DATE = new Set(["net::ERR_CERT_DATE_INVALID", "SEC_ERROR_EXPIRED_CERTIFICATE", "SEC_ERROR_EXPIRED_ISSUER_CERTIFICATE",
  "MOZILLA_PKIX_ERROR_NOT_YET_VALID_CERTIFICATE"]);
const NAME_NOT_FOUND = new Set(["net::ERR_NAME_NOT_RESOLVED", "net::ERR_NAME_RESOLUTION_FAILED", "NS_ERROR_UNKNOWN_HOST"]);
const PRIVATE_NETWORK_CHECK = "net::ERR_BLOCKED_BY_PRIVATE_NETWORK_ACCESS_CHECKS";

function certificateKind(code: string): NetworkBlockKind | null {
  if (UNTRUSTED.has(code)) return "untrusted-certificate";
  if (CERTIFICATE_NAME.has(code)) return "certificate-name";
  if (CERTIFICATE_DATE.has(code)) return "certificate-date";
  if (/^(?:net::ERR_CERT_|SEC_ERROR_|MOZILLA_PKIX_ERROR_)/.test(code)) return "certificate-other";
  return null;
}

/** The browser refused the server's certificate. A retry of the same request gets the same certificate. */
export function isCertificateError(code: string | null | undefined): boolean {
  return !!code && certificateKind(code) !== null;
}

function hostName(host: string): string {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.split(":").length === 2 ? host.slice(0, host.indexOf(":")) : host;
}

/**
 * The block a browser error code names, or null. A connection that was
 * refused, reset, timed out or changed names none: such a code says nothing
 * about a filter, and the error's own text already says what happened (what
 * arrived before a drop, a stall). The same goes for a code this module
 * does not know.
 */
function kindOfCode(code: string): NetworkBlockKind | null {
  const certificate = certificateKind(code);
  if (certificate) return certificate;
  if (/^(?:net::ERR_SSL_|SSL_ERROR_)/.test(code)) return "secure-connection";
  if (NAME_NOT_FOUND.has(code)) return "name-not-found";
  if (/^net::ERR_DNS_/.test(code)) return "dns-failed";
  if (code === "net::ERR_INTERNET_DISCONNECTED" || code === "NS_ERROR_OFFLINE") return "offline";
  if (/^net::ERR_(?:PROXY_|TUNNEL_CONNECTION_FAILED|MANDATORY_PROXY_)/.test(code) || /^NS_ERROR_(?:PROXY_|UNKNOWN_PROXY_HOST)/.test(code)) return "proxy";
  if (code === "net::ERR_BLOCKED_BY_ADMINISTRATOR" || code === "NS_ERROR_BLOCKED_BY_POLICY") return "admin-policy";
  if (code === "net::ERR_BLOCKED_BY_CLIENT") return "other-extension";
  if (code === "net::ERR_NETWORK_ACCESS_DENIED") return "firewall";
  return null;
}

/**
 * What kept the request from the server, or null when the browser's report
 * names no such thing and the error's own text stands. `answeredWithPage` is
 * true when the answer's own bytes are a web page (never judged by a header).
 * The first rule that matches decides.
 */
export function networkBlock(d: BrowserRequestDiagnostic, ctx: { readonly answeredWithPage: boolean }): NetworkBlock | null {
  if (d.code !== null && ABORTED.has(d.code)) return null;
  const block = (kind: NetworkBlockKind, host: string, ip: string | null): NetworkBlock =>
    ({ kind, host, ip, toHost: d.redirect?.toHost ?? null, code: d.code });

  // A public name at a local address. A plain refusal by status (no browser error, no page) is the server's own answer and never counts.
  if (ctx.answeredWithPage || d.code !== null) {
    const candidates: readonly (readonly [string, string | null])[] = [
      [d.finalHost ?? d.redirect?.toHost ?? d.host, d.ip],
      [d.host, d.redirect?.fromIp ?? null],
    ];
    for (const [host, ip] of candidates) {
      if (ip && isLocalScope(addressScope(ip)) && isPublicHostName(hostName(host))) return block("private-address", host, ip);
    }
  }
  if (d.code === PRIVATE_NETWORK_CHECK && isPublicHostName(hostName(d.host))) return block("private-address", d.host, d.ip);

  const fromCode = d.code === null ? null : kindOfCode(d.code);
  // Certificates, name lookup and what blocks on this computer are named before a redirect.
  // A request that was sent on failed at the server it was sent to: that is the server the message names.
  if (fromCode) return block(fromCode, d.finalHost ?? d.host, d.ip);
  if (ctx.answeredWithPage && d.redirect && hostName(d.redirect.toHost) !== hostName(d.host)) return block("redirected-to-page", d.host, d.ip);
  return null;
}

const SECURE_DNS = "the secure DNS setting in your browser's settings";

/** The text for a block. It names the server so the user can find it in a filter; it never says how to get around one. */
export function networkBlockText(block: NetworkBlock): NetworkBlockText {
  const name = block.host;
  switch (block.kind) {
    case "private-address":
      return { title: "Blocked or redirected by your network",
        body: `Your network gave ${name} a local address instead of its address on the internet. Network filters, parental controls and some providers do this to block a server. On a company network this can be normal.`,
        hint: `Check your network filter, or ${SECURE_DNS}.`, retry: true };
    case "name-not-found":
      return { title: "Server not found", body: `Your network could not find ${name}.`,
        hint: `Check your connection. If other sites work, a network filter or ${SECURE_DNS} may block this server.`, retry: true };
    case "dns-failed":
      return { title: "Server lookup failed", body: `Your network's name lookup failed for ${name}.`,
        hint: `Check your connection and ${SECURE_DNS}.`, retry: true };
    case "untrusted-certificate":
      return { title: "Secure connection not trusted",
        body: `The server that answered for ${name} showed a certificate your browser does not trust. A network filter that sends a server to its own block page, or security software that inspects secure connections, can cause this.`,
        hint: `Check your network filter or security software, or ${SECURE_DNS}.`, retry: true };
    case "certificate-name":
      return { title: "Secure connection failed",
        body: `The server that answered for ${name} showed a certificate for a different name. A network filter that sends a server to its own block page can cause this.`,
        hint: `Check your network filter, or ${SECURE_DNS}.`, retry: true };
    case "certificate-date":
      return { title: "Secure connection failed", body: `The certificate for ${name} has expired or is not valid yet.`,
        hint: "Check that your computer's date and time are correct.", retry: true };
    case "certificate-other":
      return { title: "Secure connection failed", body: `Your browser could not verify the secure connection to ${name}.`,
        hint: `Check your network filter or security software, or ${SECURE_DNS}.`, retry: true };
    case "secure-connection":
      return { title: "Secure connection failed", body: `Your browser could not set up a secure connection to ${name}.`,
        hint: "Try again later. If it keeps failing, check your network filter or security software.", retry: true };
    case "admin-policy":
      return { title: "Blocked by your organisation", body: `A browser policy set by your administrator blocks ${name}.`,
        hint: "Ask your administrator if you need access.", retry: false };
    case "other-extension":
      return { title: "Blocked by another extension", body: `Another browser extension blocked the request to ${name}.`,
        hint: "Check that extension's settings for this site.", retry: true };
    case "firewall":
      return { title: "Blocked on this computer", body: `A firewall or security program on this computer blocked the connection to ${name}.`,
        hint: "Check your firewall or security software.", retry: true };
    case "proxy":
      return { title: "Proxy connection failed", body: `Your browser's proxy could not connect to ${name}.`,
        hint: "Check your proxy settings.", retry: true };
    case "offline":
      return { title: "You're offline", body: "Your computer is not connected to the internet.", hint: "Reconnect, then try again.", retry: true };
    case "redirected-to-page": {
      const to = block.toHost ?? "another server";
      return { title: "Sent to a web page",
        body: `The request for ${name} was sent to ${to}, which answered with a web page instead of the video.`,
        hint: `If ${to} belongs to your network filter or provider, it blocks this server. Otherwise reload the page, start playback, then try again.`,
        retry: true };
    }
  }
}

/** The rows a browser report adds under Technical details. The address is shown on this device only. */
export function diagnosticRows(d: BrowserRequestDiagnostic): { readonly label: string; readonly value: string }[] {
  const rows: { label: string; value: string }[] = [{ label: "Server", value: d.host }];
  if (d.ip) {
    const scope = addressScope(d.ip);
    rows.push({ label: "Address", value: scope ? `${d.ip} (${SCOPE_LABEL[scope]})` : d.ip });
  }
  if (d.redirect) rows.push({ label: "Redirected to", value: `${d.redirect.toHost} (HTTP ${d.redirect.status})` });
  // Sent on within the same name, such as to another port: no redirect to another server, but not the server that was asked.
  else if (d.finalHost && d.finalHost !== d.host) rows.push({ label: "Sent on to", value: d.finalHost });
  if (d.code) rows.push({ label: "Browser error", value: d.code });
  return rows;
}
