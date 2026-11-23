import { describe, expect, it } from "vitest";
import { addressScope, isLocalHostName, isLocalScope, isPublicHostName, SCOPE_LABEL } from "../../src/net/address";

describe("addressScope", () => {
  it.each([
    ["0.0.0.0", "unspecified"], ["0.255.255.255", "unspecified"], ["1.0.0.0", "public"],
    ["9.255.255.255", "public"], ["10.0.0.0", "private"], ["10.255.255.255", "private"], ["11.0.0.0", "public"],
    ["100.63.255.255", "public"], ["100.64.0.0", "shared"], ["100.127.255.255", "shared"], ["100.128.0.0", "public"],
    ["126.255.255.255", "public"], ["127.0.0.1", "loopback"], ["127.255.255.255", "loopback"], ["128.0.0.0", "public"],
    ["169.253.255.255", "public"], ["169.254.0.0", "link-local"], ["169.254.255.255", "link-local"], ["169.255.0.0", "public"],
    ["172.15.255.255", "public"], ["172.16.0.0", "private"], ["172.31.255.255", "private"], ["172.32.0.0", "public"],
    ["192.0.0.1", "reserved"], ["192.0.2.1", "documentation"], ["192.167.255.255", "public"], ["192.168.0.0", "private"],
    ["192.168.255.255", "private"], ["192.169.0.0", "public"],
    ["198.17.255.255", "public"], ["198.18.0.0", "benchmarking"], ["198.19.255.255", "benchmarking"], ["198.20.0.0", "public"],
    ["198.51.100.7", "documentation"], ["203.0.113.7", "documentation"], ["223.255.255.255", "public"],
    ["224.0.0.1", "multicast"], ["239.255.255.255", "multicast"], ["240.0.0.1", "reserved"], ["255.255.255.255", "reserved"],
    ["::", "unspecified"], ["::1", "loopback"], ["[::1]", "loopback"], ["::2", "public"],
    ["fc00::1", "unique-local"], ["fdff:ffff::1", "unique-local"], ["fe00::1", "public"],
    ["fe80::1", "link-local"], ["febf::1", "link-local"], ["fe80::1%en0", "link-local"], ["fec0::1", "unique-local"],
    ["100::1", "discard"], ["100:0:0:1::1", "public"], ["2001:db8::1", "documentation"], ["ff02::1", "multicast"],
    ["2606:4700::1111", "public"],
    ["::ffff:10.0.0.1", "private"], ["::ffff:7f00:1", "loopback"], ["::ffff:8.8.8.8", "public"],
  ])("%s is %s", (ip, scope) => {
    expect(addressScope(ip)).toBe(scope);
  });

  it.each(["", "media.example", "256.1.1.1", "1.2.3", "12345::1", "::1::2", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "g::1", null, undefined])(
    "%s is not an address", text => {
      expect(addressScope(text)).toBeNull();
    });

  it("counts only the scopes a public server never has as local", () => {
    const local = (Object.keys(SCOPE_LABEL) as (keyof typeof SCOPE_LABEL)[]).filter(scope => isLocalScope(scope));
    expect(local.sort()).toEqual(["discard", "link-local", "loopback", "private", "unique-local", "unspecified"]);
    expect(isLocalScope(null)).toBe(false);
  });
});

describe("isPublicHostName", () => {
  it.each(["media.public-site.net", "cdn.public-site.net:8443", "a.b.co.uk", "media.e2e.ancplua.dev", "public-site.net."])("%s is public", host => {
    expect(isPublicHostName(host)).toBe(true);
  });

  it.each(["localhost", "printer", "nas.local", "media.test", "cdn.example.com", "example.org", "site.example", "host.invalid", "a.onion",
    "svc.internal", "1.0.0.127.in-addr.arpa", "x.alt", "127.0.0.1", "127.0.0.1:8443", "[::1]", "[::1]:8443", "::1", "10.0.0.1", "", null,
    "bad host.net"])("%s is not", host => {
    expect(isPublicHostName(host)).toBe(false);
  });
});

describe("isLocalHostName", () => {
  it.each(["localhost", "app.localhost", "nas", "nas.", "NAS", "router:8080", "my_nas", "printer.local", "nas.home.arpa", "x.home.arpa.",
    "router.internal", "svc.corp.internal:8443", "internal", "local"])("%s only resolves inside the user's network", host => {
    expect(isLocalHostName(host)).toBe(true);
    expect(isPublicHostName(host)).toBe(false);
  });

  // Names that are not public and say nothing about the user's network, public names, and IP addresses (addressScope reads those).
  it.each(["news.example", "media.test", "host.invalid", "a.onion", "x.alt", "1.0.0.127.in-addr.arpa", "example.com", "media.public-site.net",
    "internal.public-site.net", "localhost.public-site.net", "127.0.0.1", "192.168.1.1:80", "[::1]", "::1", "", null, undefined,
    "bad host"])("%s does not", host => {
    expect(isLocalHostName(host)).toBe(false);
  });
});
