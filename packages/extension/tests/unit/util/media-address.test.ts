import { describe, expect, it } from "vitest";
import type { StreamSource } from "@savemedia/core";
import { hasAddress, offersFile, sourceAddress } from "../../../src/util/media-address";
import { urlsOf } from "../../../src/util/tab-media-state";
import { directDescriptor, hlsDescriptor } from "../popup/helpers/descriptors";

const row = (source: StreamSource) => ({ source });
const redirected = row({ kind: "direct-url", url: "https://site.example/get/31?b=2&a=1", finalUrl: "https://cdn.example/files/31.mov?sig=x", headers: {} });
const plain = row({ kind: "direct-url", url: "https://cdn.example/clip.mp4", headers: {} });
const playlist = row({ kind: "hls-manifest", manifestUrl: "https://cdn.example/master.m3u8?b=2&a=1", type: "master" });
const manifest = row({ kind: "dash-manifest", manifestUrl: "https://cdn.example/stream.mpd" });
const element = row({ kind: "media-element", element: "video", elementSrc: "https://cdn.example/element.mp4" });

describe("a row's address", () => {
  it("is where a redirected file was answered from, and the address savemedia asks when the entry is wanted", () => {
    expect(sourceAddress(redirected)).toBe("https://cdn.example/files/31.mov?sig=x");
    expect(sourceAddress(redirected, "final")).toBe("https://cdn.example/files/31.mov?sig=x");
    expect(sourceAddress(redirected, "entry")).toBe("https://site.example/get/31?b=2&a=1");
  });

  it.each([[plain, "https://cdn.example/clip.mp4"], [playlist, "https://cdn.example/master.m3u8?b=2&a=1"],
    [manifest, "https://cdn.example/stream.mpd"], [element, "https://cdn.example/element.mp4"]] as const)(
    "is one and the same for a row that was not redirected", (descriptor, address) => {
      expect(sourceAddress(descriptor, "entry")).toBe(address);
      expect(sourceAddress(descriptor, "final")).toBe(address);
    });

  it("is matched as a resource: the order of the parameters and a fragment do not matter, another parameter does", () => {
    expect(hasAddress(redirected, "https://site.example/get/31?a=1&b=2#t=10")).toBe(true);
    expect(hasAddress(redirected, "https://cdn.example/files/31.mov?sig=x")).toBe(true);
    expect(hasAddress(redirected, "https://cdn.example/files/31.mov?sig=y")).toBe(false);
    expect(hasAddress(playlist, "https://cdn.example/master.m3u8?a=1&b=2")).toBe(true);
    expect(hasAddress(element, "https://cdn.example/element.mp4")).toBe(true);
    expect(hasAddress(element, "https://cdn.example/other.mp4")).toBe(false);
  });

  it("is the file a page offers only for a direct file", () => {
    expect(offersFile(redirected, "https://site.example/get/31?a=1&b=2")).toBe(true);
    expect(offersFile(redirected, "https://cdn.example/files/31.mov?sig=x")).toBe(true);
    expect(offersFile(plain, "https://cdn.example/other.mp4")).toBe(false);
    // A playlist or an element at the offered address is not the offered file.
    expect(offersFile(playlist, "https://cdn.example/master.m3u8?b=2&a=1")).toBe(false);
    expect(offersFile(element, "https://cdn.example/element.mp4")).toBe(false);
  });

  it("is the first of a row's addresses, with the answered address after it", () => {
    expect(urlsOf(directDescriptor({ source: redirected.source }))).toEqual(["https://site.example/get/31?b=2&a=1", "https://cdn.example/files/31.mov?sig=x"]);
    expect(urlsOf(directDescriptor({ source: plain.source }))).toEqual(["https://cdn.example/clip.mp4"]);
    expect(urlsOf(hlsDescriptor())[0]).toBe(sourceAddress(hlsDescriptor()));
  });
});
