import { describe, expect, it } from "vitest";
import { BROWSER_ERROR_CODE, diagnosticRows, isCertificateError, networkBlock, networkBlockText, type NetworkBlockKind } from "../../src/errors/network-block";
import { diagnostic } from "./samples";

const PUBLIC = "media.public-site.net";
const kind = (fields: Parameters<typeof diagnostic>[0], answeredWithPage = false): NetworkBlockKind | null =>
  networkBlock(diagnostic({ host: PUBLIC, ...fields }), { answeredWithPage })?.kind ?? null;

describe("networkBlock", () => {
  it("is silent about a request savemedia cancelled itself", () => {
    expect(kind({ code: "net::ERR_ABORTED", ip: "10.0.0.1" }, true)).toBeNull();
    expect(kind({ code: "NS_BINDING_ABORTED" })).toBeNull();
  });

  it.each(["0.0.0.0", "127.0.0.1", "10.0.0.1", "172.16.4.4", "192.168.1.1", "169.254.1.1", "fd00::1", "::1", "100::1", "::ffff:10.0.0.1"])(
    "a web page from %s for a public name is a private address", ip => {
      expect(kind({ ip }, true)).toBe("private-address");
    });

  it("a browser error at a local address for a public name is a private address, before the error's own kind", () => {
    expect(kind({ code: "net::ERR_CONNECTION_REFUSED", ip: "10.0.0.1" })).toBe("private-address");
    expect(kind({ code: "net::ERR_CERT_COMMON_NAME_INVALID", ip: "10.0.0.1" })).toBe("private-address");
  });

  it.each(["100.64.1.2", "198.18.0.5", "203.0.113.9", "8.8.8.8"])("an address in %s never counts as local", ip => {
    expect(kind({ ip }, true)).toBeNull();
    expect(kind({ code: "net::ERR_CONNECTION_REFUSED", ip })).toBeNull();
  });

  it("a server's own refusal at a local address is not a block", () => {
    expect(kind({ ip: "10.0.0.1" }, false)).toBeNull();
  });

  it.each(["media.test", "cdn.example.com", "127.0.0.1:8443", "nas", "nas.local"])("%s at a local address is where it belongs", host => {
    expect(kind({ host, ip: "127.0.0.1" }, true)).toBeNull();
    expect(kind({ host, code: "net::ERR_CONNECTION_REFUSED", ip: "127.0.0.1" })).toBeNull();
  });

  it("looks at the host a redirect led to, and at the address that sent the redirect", () => {
    const toFilter = networkBlock(diagnostic({ host: PUBLIC, ip: "192.168.1.1", finalHost: "filter.public-site.net",
      redirect: { toHost: "filter.public-site.net", status: 302, fromIp: "192.168.1.1" } }), { answeredWithPage: true });
    expect(toFilter).toMatchObject({ kind: "private-address", host: "filter.public-site.net", ip: "192.168.1.1", toHost: "filter.public-site.net" });
    const fromLocal = networkBlock(diagnostic({ host: PUBLIC, ip: "203.0.113.9", finalHost: "portal.public-site.net",
      redirect: { toHost: "portal.public-site.net", status: 302, fromIp: "10.0.0.1" } }), { answeredWithPage: true });
    expect(fromLocal).toMatchObject({ kind: "private-address", host: PUBLIC, ip: "10.0.0.1" });
  });

  it("names the browser's own private network check", () => {
    expect(kind({ code: "net::ERR_BLOCKED_BY_PRIVATE_NETWORK_ACCESS_CHECKS" })).toBe("private-address");
  });

  it.each([
    ["net::ERR_CERT_AUTHORITY_INVALID", "untrusted-certificate"], ["net::ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN", "untrusted-certificate"],
    ["net::ERR_CERTIFICATE_TRANSPARENCY_REQUIRED", "untrusted-certificate"], ["SEC_ERROR_UNKNOWN_ISSUER", "untrusted-certificate"],
    ["MOZILLA_PKIX_ERROR_SELF_SIGNED_CERT", "untrusted-certificate"],
    ["net::ERR_CERT_COMMON_NAME_INVALID", "certificate-name"], ["SSL_ERROR_BAD_CERT_DOMAIN", "certificate-name"],
    ["net::ERR_CERT_DATE_INVALID", "certificate-date"], ["SEC_ERROR_EXPIRED_CERTIFICATE", "certificate-date"],
    ["net::ERR_CERT_REVOKED", "certificate-other"], ["SEC_ERROR_REVOKED_CERTIFICATE", "certificate-other"],
    ["net::ERR_SSL_PROTOCOL_ERROR", "secure-connection"], ["SSL_ERROR_NO_CYPHER_OVERLAP", "secure-connection"],
    ["net::ERR_NAME_NOT_RESOLVED", "name-not-found"], ["NS_ERROR_UNKNOWN_HOST", "name-not-found"],
    ["net::ERR_DNS_TIMED_OUT", "dns-failed"], ["net::ERR_DNS_SECURE_RESOLVER_HOSTNAME_RESOLUTION_FAILED", "dns-failed"],
    ["net::ERR_INTERNET_DISCONNECTED", "offline"], ["NS_ERROR_OFFLINE", "offline"],
    ["net::ERR_PROXY_CONNECTION_FAILED", "proxy"], ["net::ERR_TUNNEL_CONNECTION_FAILED", "proxy"], ["NS_ERROR_PROXY_CONNECTION_REFUSED", "proxy"],
    ["net::ERR_BLOCKED_BY_ADMINISTRATOR", "admin-policy"], ["net::ERR_BLOCKED_BY_CLIENT", "other-extension"],
    ["net::ERR_NETWORK_ACCESS_DENIED", "firewall"],
  ] as const)("%s is %s", (code, expected) => {
    const block = networkBlock(diagnostic({ host: PUBLIC, code, ip: "203.0.113.9" }), { answeredWithPage: false });
    expect(block).toMatchObject({ kind: expected, code });
  });

  it.each(["net::ERR_CONNECTION_REFUSED", "net::ERR_CONNECTION_RESET", "net::ERR_TIMED_OUT", "net::ERR_ADDRESS_UNREACHABLE", "net::ERR_EMPTY_RESPONSE",
    "net::ERR_NETWORK_CHANGED", "net::ERR_HTTP2_PROTOCOL_ERROR", "NS_ERROR_NET_RESET", "net::ERR_SOMETHING_NEW"])(
    "%s names no block: a plain connection failure and a code it does not know leave the error its own text", code => {
      expect(kind({ code, ip: "203.0.113.9" })).toBeNull();
      expect(kind({ code, ip: "203.0.113.9" }, true)).toBeNull();
    });

  it("a redirect to another public host that answers with a page is named as such", () => {
    const block = networkBlock(diagnostic({ host: PUBLIC, ip: "203.0.113.9", finalHost: "portal.public-site.net",
      redirect: { toHost: "portal.public-site.net", status: 302, fromIp: "203.0.113.8" } }), { answeredWithPage: true });
    expect(block).toMatchObject({ kind: "redirected-to-page", host: PUBLIC, toHost: "portal.public-site.net" });
    expect(networkBlock(diagnostic({ host: PUBLIC, redirect: { toHost: `${PUBLIC}:8443`, status: 302, fromIp: null } }), { answeredWithPage: true })).toBeNull();
    expect(networkBlock(diagnostic({ host: PUBLIC, redirect: { toHost: "portal.public-site.net", status: 302, fromIp: null } }), { answeredWithPage: false })).toBeNull();
  });

  it("names the server a request was sent on to when it failed there, and shows that server in a row of its own", () => {
    const sentOn = diagnostic({ host: "127.0.0.1:5001", code: "net::ERR_CERT_AUTHORITY_INVALID", finalHost: "127.0.0.1:5002" });
    const block = networkBlock(sentOn, { answeredWithPage: false });
    expect(block).toMatchObject({ kind: "untrusted-certificate", host: "127.0.0.1:5002" });
    expect(networkBlockText(block!).body).toContain("127.0.0.1:5002");
    expect(diagnosticRows(sentOn)).toEqual([
      { label: "Server", value: "127.0.0.1:5001" },
      { label: "Sent on to", value: "127.0.0.1:5002" },
      { label: "Browser error", value: "net::ERR_CERT_AUTHORITY_INVALID" },
    ]);
    const notFound = networkBlock(diagnostic({ host: PUBLIC, code: "net::ERR_NAME_NOT_RESOLVED", finalHost: "cdn2.public-site.net",
      redirect: { toHost: "cdn2.public-site.net", status: 302, fromIp: "203.0.113.8" } }), { answeredWithPage: false });
    expect(notFound).toMatchObject({ kind: "name-not-found", host: "cdn2.public-site.net" });
  });

  it("says nothing when a server simply answered", () => {
    expect(kind({ ip: "203.0.113.9" }, true)).toBeNull();
    expect(kind({})).toBeNull();
  });
});

describe("networkBlockText", () => {
  const KINDS: readonly NetworkBlockKind[] = ["private-address", "name-not-found", "dns-failed", "untrusted-certificate", "certificate-name",
    "certificate-date", "certificate-other", "secure-connection", "admin-policy", "other-extension", "firewall", "proxy", "offline",
    "redirected-to-page"];

  it.each(KINDS)("%s is plain, names no address or code, and suggests no way around a block", kind => {
    const text = networkBlockText({ kind, host: PUBLIC, ip: "10.0.0.1", toHost: "filter.public-site.net", code: "net::ERR_FAILED" });
    const all = `${text.title}\n${text.body}\n${text.hint}`;
    expect(text.title.length).toBeLessThanOrEqual(60);
    expect(all).not.toMatch(/10\.0\.0\.1|net::|ERR_|HTTP|\bTLS\b|\bSSL\b/);
    expect(all).not.toMatch(/\b(?:VPN|another DNS|different DNS|public DNS|turn off|switch off|disable|bypass|work around)\b/i);
    expect(all).not.toMatch(/[–—]|\p{Extended_Pictographic}|!|Chrome|SaveMedia/u);
    expect(text.hint).toMatch(/^[A-Z]/);
    if (kind !== "offline") expect(text.body).toContain(PUBLIC);
    expect(text.retry).toBe(kind !== "admin-policy");
  });

  it("uses the wording agreed for a local address", () => {
    const text = networkBlockText({ kind: "private-address", host: PUBLIC, ip: "10.0.0.1", toHost: null, code: null });
    expect(text.title).toBe("Blocked or redirected by your network");
    expect(text.body).toMatch(/local address instead of its address on the internet/);
    expect(text.body).toMatch(/Network filters, parental controls and some providers/);
    expect(text.body).toMatch(/On a company network this can be normal\.$/);
    expect(text.hint).toMatch(/secure DNS setting/);
  });

  it("names a redirecting filter and the secure DNS setting for a certificate the browser does not trust", () => {
    // What a DNS sinkhole with its own block page gives over HTTPS: the browser reports no address for the failed
    // connection, so the local-address text cannot apply and this one has to carry the same advice.
    const block = networkBlock(diagnostic({ host: PUBLIC, code: "net::ERR_CERT_AUTHORITY_INVALID", ip: null }), { answeredWithPage: false });
    expect(block).toMatchObject({ kind: "untrusted-certificate", ip: null });
    const text = networkBlockText(block!);
    expect(text.title).toBe("Secure connection not trusted");
    expect(text.body).toMatch(/A network filter that sends a server to its own block page/);
    expect(text.body).toMatch(/security software that inspects secure connections/);
    expect(text.hint).toBe("Check your network filter or security software, or the secure DNS setting in your browser's settings.");
    for (const kind of ["certificate-name", "certificate-other"] as const) {
      expect(networkBlockText({ kind, host: PUBLIC, ip: null, toHost: null, code: null }).hint).toMatch(/secure DNS setting/);
    }
  });

  it("points at the clock for a certificate date, and at the administrator for a policy", () => {
    expect(networkBlockText({ kind: "certificate-date", host: PUBLIC, ip: null, toHost: null, code: null }).hint)
      .toBe("Check that your computer's date and time are correct.");
    expect(networkBlockText({ kind: "admin-policy", host: PUBLIC, ip: null, toHost: null, code: null }).hint)
      .toBe("Ask your administrator if you need access.");
  });
});

describe("what the browser reported, as rows", () => {
  it("shows the address with its kind, the redirect with its status and the code, each on its own row", () => {
    expect(diagnosticRows(diagnostic({ host: PUBLIC, code: "net::ERR_CONNECTION_REFUSED", ip: "127.0.0.1",
      redirect: { toHost: "filter.public-site.net:8080", status: 302, fromIp: null } }))).toEqual([
      { label: "Server", value: PUBLIC },
      { label: "Address", value: "127.0.0.1 (this computer)" },
      { label: "Redirected to", value: "filter.public-site.net:8080 (HTTP 302)" },
      { label: "Browser error", value: "net::ERR_CONNECTION_REFUSED" },
    ]);
    expect(diagnosticRows(diagnostic({ host: PUBLIC }))).toEqual([{ label: "Server", value: PUBLIC }]);
  });
});

describe("browser error codes", () => {
  it("counts certificate refusals, and nothing else, as certificate errors", () => {
    expect(isCertificateError("net::ERR_CERT_AUTHORITY_INVALID")).toBe(true);
    expect(isCertificateError("net::ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN")).toBe(true);
    expect(isCertificateError("SEC_ERROR_UNKNOWN_ISSUER")).toBe(true);
    expect(isCertificateError("net::ERR_SSL_PROTOCOL_ERROR")).toBe(false);
    expect(isCertificateError("net::ERR_CONNECTION_RESET")).toBe(false);
    expect(isCertificateError(null)).toBe(false);
  });

  it("accepts code-shaped text only", () => {
    expect(BROWSER_ERROR_CODE.test("net::ERR_NAME_NOT_RESOLVED")).toBe(true);
    expect(BROWSER_ERROR_CODE.test("NS_ERROR_UNKNOWN_HOST")).toBe(true);
    expect(BROWSER_ERROR_CODE.test("SEC_ERROR_UNKNOWN_ISSUER")).toBe(true);
    expect(BROWSER_ERROR_CODE.test("Failed to fetch https://media.example/secret")).toBe(false);
    expect(BROWSER_ERROR_CODE.test("net::ERR_ lower")).toBe(false);
  });
});
