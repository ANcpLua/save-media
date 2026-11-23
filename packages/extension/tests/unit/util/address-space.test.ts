import { describe, expect, it } from "vitest";
import { addressScope } from "@savemedia/core";
import { isPrivateAddress, observedAmong, publicPageToPrivateServer, reachedLocallyByName, unobservedLocalTarget, webOrigin } from "../../../src/util/address-space";

describe("address-space", () => {
  it("recognises loopback, private, link-local and local names", () => {
    for (const host of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "localhost", "nas.localhost", "printer.local", "[::1]", "::1", "fd12:3456::1", "fe80::1", "::ffff:192.168.0.1", "::ffff:c0a8:1"]) {
      expect(isPrivateAddress(host), host).toBe(true);
    }
    for (const host of ["8.8.8.8", "172.32.0.1", "example.com", "2001:4860::8888", "192.169.1.1", "", null]) {
      expect(isPrivateAddress(host), String(host)).toBe(false);
    }
  });

  it("knows the names that only resolve inside the user's network before any request: one label, home.arpa, internal", () => {
    for (const host of ["nas", "nas.", "router", "printer.home.arpa", "x.home.arpa.", "router.internal", "x.internal"]) {
      expect(isPrivateAddress(host), host).toBe(true);
    }
    // Not public, and not the user's network either: a page under such a name stays a page on the internet for this rule.
    for (const host of ["news.example", "evil.example", "media.test", "internal.public-site.net", "12345::1"]) {
      expect(isPrivateAddress(host), host).toBe(false);
    }
    const page = "https://news.example/story";
    for (const target of ["http://nas/cgi-bin/x.mp4", "http://router.home.arpa/apply.cgi", "http://printer.internal/clip.mp4", "http://nas.:8080/x.mp4"]) {
      expect(unobservedLocalTarget(page, target, undefined), target).toBe(true);
    }
    // The browser played it for this page: saved, like any other local server.
    expect(unobservedLocalTarget(page, "http://nas/cgi-bin/x.mp4", observedAmong(["http://nas"]))).toBe(false);
    // A page under such a name is a page inside the network: its own server needs no observation.
    expect(unobservedLocalTarget("http://intranet/training", "http://intranet/media/onboarding.mp4", undefined, "10.20.0.5")).toBe(false);
    expect(publicPageToPrivateServer("http://wiki.corp.internal/", "http://192.168.1.1/x.mp4")).toBe(false);
  });

  it("flags a public page pointing into the private network, by link or by server address", () => {
    expect(publicPageToPrivateServer("https://evil.example/", "http://192.168.1.1/apply.cgi?x=.m3u8")).toBe(true);
    expect(publicPageToPrivateServer("https://evil.example/", "https://rebind.example/x.m3u8", "10.0.0.5")).toBe(true);
    expect(publicPageToPrivateServer("https://news.example/", "https://cdn.example/x.mp4", "93.184.216.34")).toBe(false);
    expect(publicPageToPrivateServer("http://192.168.1.20:8096/web/", "http://192.168.1.20:8096/v.mp4", "192.168.1.20")).toBe(false);
    expect(publicPageToPrivateServer("http://127.0.0.1:5174/page/a.html", "http://localhost:5174/v.mp4")).toBe(false);
  });

  it("knows a fully qualified name and the old site-local range", () => {
    for (const host of ["localhost.", "app.localhost.", "router.local.", "127.0.0.1.", "[fec0::1]", "feff::1"]) {
      expect(isPrivateAddress(host), host).toBe(true);
    }
    expect(isPrivateAddress("example.com.")).toBe(false);
    expect(publicPageToPrivateServer("https://news.example/story", "http://localhost.:8080/admin/x.mp4")).toBe(true);
    expect(publicPageToPrivateServer("https://news.example/story", "http://[fec0::1]/x.mp4")).toBe(true);
  });

  it("reads every IP address with core's parser: one reading of what an address is", () => {
    // What core calls local is local here, and the carrier-shared range on top of it.
    const samples = ["0.0.0.0", "10.0.0.1", "100.64.0.1", "100.128.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1", "172.32.0.1", "192.168.0.1",
      "198.18.0.1", "203.0.113.7", "224.0.0.1", "8.8.8.8", "::", "::1", "fc00::1", "fe80::1%en0", "fec0::1", "100::1", "2001:db8::1",
      "2606:4700::1111", "::ffff:10.0.0.1", "::ffff:8.8.8.8", "[::ffff:7f00:1]"];
    const inside = new Set(["unspecified", "loopback", "private", "link-local", "unique-local", "discard", "shared"]);
    for (const ip of samples) expect(isPrivateAddress(ip), ip).toBe(inside.has(addressScope(ip)!));
    // Text that is no address is a name, and only the local names are local.
    for (const text of ["256.1.1.1", "1.2.3", "12345::1", "media.example"]) {
      expect(addressScope(text)).toBeNull();
      expect(isPrivateAddress(text), text).toBe(false);
    }
  });

  it("names an origin by scheme, host and port, and only for a web address", () => {
    expect(webOrigin("http://192.168.1.10/movie.mp4?x=1#t")).toBe("http://192.168.1.10");
    expect(webOrigin("https://media.example:8443/a/b.m3u8")).toBe("https://media.example:8443");
    expect(webOrigin("https://media.example:443/a")).toBe("https://media.example");
    for (const other of ["blob:https://site.example/1", "data:video/mp4;base64,AA==", "file:///x.mp4", "not an address", "", null, undefined]) {
      expect(webOrigin(other), String(other)).toBeNull();
    }
  });

  it("lets a public page reach a local server only where the browser itself was answered from that origin", () => {
    const observed = observedAmong(["http://192.168.1.10", "https://media.corp-portal.net"]);
    const page = "https://news.example/story";
    // The browser was there for this page: what it received is saved.
    expect(unobservedLocalTarget(page, "http://192.168.1.10/movie.mp4", observed)).toBe(false);
    expect(unobservedLocalTarget(page, "https://media.corp-portal.net/seg1.ts", observed, "10.20.0.5")).toBe(false);
    // The page only names these: another device, another port, another scheme, and a name the browser never asked.
    expect(unobservedLocalTarget(page, "http://192.168.1.1/apply.cgi", observed)).toBe(true);
    expect(unobservedLocalTarget(page, "http://192.168.1.10:8080/admin", observed)).toBe(true);
    expect(unobservedLocalTarget(page, "https://192.168.1.10/movie.mp4", observed)).toBe(true);
    expect(unobservedLocalTarget(page, "https://rebind.example/x.mp4", observed, "10.0.0.5")).toBe(true);
    // Without anything observed, every local server is one the page only names.
    expect(unobservedLocalTarget(page, "http://192.168.1.10/movie.mp4", undefined)).toBe(true);
    expect(unobservedLocalTarget(page, "http://192.168.1.10/movie.mp4", observedAmong(undefined))).toBe(true);
    // A server on the internet and a page that is itself local need no observation.
    expect(unobservedLocalTarget(page, "https://cdn.example/x.mp4", undefined, "93.184.216.34")).toBe(false);
    expect(unobservedLocalTarget("http://192.168.1.20:8096/web/", "http://192.168.1.1/x.mp4", undefined)).toBe(false);
  });

  it("knows a page with a public name that the browser reached at a local address: a proxy there, or an intranet name", () => {
    const observed = observedAmong(["https://www.news-site.net", "http://192.168.1.20:8096", "http://nas.local"]);
    expect(reachedLocallyByName("https://www.news-site.net/story?id=1", observed)).toBe(true);
    // Another origin of the same site, and a page the browser was not answered for from a local address.
    expect(reachedLocallyByName("http://www.news-site.net/story", observed)).toBe(false);
    expect(reachedLocallyByName("https://other.example/", observed)).toBe(false);
    // A page at an address or name that is itself local is a local page already: its servers' addresses still tell.
    expect(reachedLocallyByName("http://192.168.1.20:8096/web/", observed)).toBe(false);
    expect(reachedLocallyByName("http://nas.local/videos", observed)).toBe(false);
    for (const none of [null, undefined, "", "about:blank", "not an address"]) expect(reachedLocallyByName(none, observed), String(none)).toBe(false);
    expect(reachedLocallyByName("https://www.news-site.net/story", undefined)).toBe(false);
  });
});
