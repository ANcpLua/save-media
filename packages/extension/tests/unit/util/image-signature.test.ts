import { describe, expect, it } from "vitest";
import { IMAGE_EXTENSION, IMAGE_MIME, identifyBinaryImage, identifyImage, inertSvg, notImageKind } from "../../../src/util/image-signature";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);
const pad = (head: Uint8Array, length = 64) => { const out = new Uint8Array(length); out.set(head); return out; };

describe("image-signature", () => {
  it("identifies every accepted image type by its bytes", () => {
    expect(identifyImage(pad(bytes(0xff, 0xd8, 0xff, 0xe0)))).toBe("jpeg");
    expect(identifyImage(pad(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)))).toBe("png");
    expect(identifyImage(pad(text("GIF89a")))).toBe("gif");
    expect(identifyImage(pad(text("GIF87a")))).toBe("gif");
    expect(identifyImage(pad(new Uint8Array([...text("RIFF"), 1, 2, 3, 4, ...text("WEBP")])))).toBe("webp");
    expect(identifyImage(pad(new Uint8Array([0, 0, 0, 0x1c, ...text("ftypavif"), 0, 0, 0, 0, ...text("mif1")])))).toBe("avif");
    expect(identifyImage(pad(new Uint8Array([0, 0, 0, 0x1c, ...text("ftypmif1"), 0, 0, 0, 0, ...text("avis")])))).toBe("avif");
    expect(identifyImage(pad(bytes(0xff, 0x0a, 1, 2)))).toBe("jxl");
    expect(identifyImage(pad(bytes(0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a)))).toBe("jxl");
    expect(identifyImage(pad(bytes(0x42, 0x4d, 9, 9, 9, 9, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0)))).toBe("bmp");
    expect(identifyImage(pad(bytes(0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0)))).toBe("ico");
    expect(identifyImage(text("﻿<?xml version=\"1.0\"?>\n<!-- drawn by hand -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"x\">\n<svg xmlns=\"http://www.w3.org/2000/svg\"><rect/></svg>"))).toBe("svg");
    for (const type of ["jpeg", "png", "gif", "webp", "avif", "jxl", "bmp", "ico", "svg"] as const) {
      expect(IMAGE_MIME[type]).toMatch(/^image\//);
      expect(IMAGE_EXTENSION[type]).toMatch(/^[a-z]{3,4}$/);
    }
  });

  it("checks the structure of BMP and ICO, not only their first bytes", () => {
    expect(identifyImage(text("BM text that merely starts like a bitmap file"))).toBeNull();
    expect(identifyImage(pad(bytes(0x42, 0x4d, 9, 9, 9, 9, 0, 0, 0, 0, 54, 0, 0, 0, 41, 0, 0, 0)))).toBeNull();
    expect(identifyImage(pad(bytes(0, 0, 1, 0, 0, 0, 16, 16, 0, 0)))).toBeNull();
    expect(identifyImage(pad(bytes(0, 0, 1, 0, 1, 0, 16, 16, 0, 7)))).toBeNull();
  });

  it("does not take an MP4 video or an HTML page for an image", () => {
    expect(identifyImage(pad(new Uint8Array([0, 0, 0, 0x18, ...text("ftypisom"), 0, 0, 0, 0, ...text("mp42")])))).toBeNull();
    expect(identifyImage(text("<!doctype html><html><body><svg></svg></body></html>"))).toBeNull();
  });

  it("refuses SVG that carries script, embedded HTML or event handlers", () => {
    expect(identifyImage(text("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>"))).toBeNull();
    expect(identifyImage(text("<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(1)\"></svg>"))).toBeNull();
    expect(identifyImage(text("<svg><foreignObject><body/></foreignObject></svg>"))).toBeNull();
    expect(identifyImage(text("<svg><a href=\"javascript:alert(1)\">x</a></svg>"))).toBeNull();
    expect(notImageKind(text("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>"))).toBe("data");
  });

  it("names what refused bytes are", () => {
    expect(notImageKind(text("<!DOCTYPE html><html><body>Sign in</body></html>"))).toBe("page");
    expect(notImageKind(text("  <html><head></head></html>"))).toBe("page");
    expect(notImageKind(text("<script>location='x'</script>"))).toBe("page");
    expect(notImageKind(pad(bytes(0x4d, 0x5a, 0x90, 0x00)))).toBe("program");
    expect(notImageKind(pad(bytes(0x7f, 0x45, 0x4c, 0x46)))).toBe("program");
    expect(notImageKind(pad(bytes(0xcf, 0xfa, 0xed, 0xfe)))).toBe("program");
    expect(notImageKind(pad(bytes(0xca, 0xfe, 0xba, 0xbe)))).toBe("program");
    expect(notImageKind(pad(bytes(0x50, 0x4b, 0x03, 0x04)))).toBe("program");
    expect(notImageKind(text("#!/bin/sh\nrm -rf ~"))).toBe("program");
    expect(notImageKind(pad(bytes(0x1f, 0x8b, 8)))).toBe("program");
    expect(notImageKind(text("{\"error\":\"not found\"}"))).toBe("data");
    expect(notImageKind(text("window.location = 'https://x.test'"))).toBe("data");
    expect(notImageKind(pad(bytes(1, 2, 3, 0, 9, 9)))).toBe("unknown");
  });

  // Each of these runs script when the saved file is opened in a browser, and each hid it from a check of the text.
  it.each([
    ["an SVG script under a prefix", `<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>`],
    ["an HTML script inside the SVG", `<svg xmlns="http://www.w3.org/2000/svg"><h:script xmlns:h="http://www.w3.org/1999/xhtml">alert(1)</h:script></svg>`],
    ["a frame in a prefixed foreignObject", `<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:foreignObject><iframe xmlns="http://www.w3.org/1999/xhtml" src="https://evil.example/"/></s:foreignObject></svg>`],
    ["a script link written with a character reference", `<svg xmlns="http://www.w3.org/2000/svg"><a href="&#106;avascript:alert(1)"><rect width="9" height="9"/></a></svg>`],
    ["a script link with whitespace inside", `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href=" java&#9;script:alert(1)"><rect/></a></svg>`],
    ["an animation that sets a link", `<svg xmlns="http://www.w3.org/2000/svg"><a><set attributeName="href" to="https://site.example/"/><rect/></a></svg>`],
    ["an animation value that is a script link", `<svg xmlns="http://www.w3.org/2000/svg"><a><animate attributeName="fill" values="red;javascript:alert(1)"/><rect/></a></svg>`],
    ["an HTML image with a handler", `<svg xmlns="http://www.w3.org/2000/svg"><h:img xmlns:h="http://www.w3.org/1999/xhtml" src="x"/></svg>`],
    ["a style sheet instruction", `<?xml version="1.0"?><?xml-stylesheet type="text/xsl" href="https://evil.example/x.xsl"?><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`],
    ["markup that is not well formed", `<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>`],
    ["an svg element outside the SVG namespace", `<svg><rect/></svg>`],
  ])("refuses %s", (_name, markup) => {
    expect(identifyImage(text(markup))).toBeNull();
    expect(inertSvg(markup)).toBe(false);
  });

  it("accepts drawings with an editor's own metadata, embedded pictures and plain animation", () => {
    const drawing = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
      xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:ed="http://editor.example/ns" ed:version="1.2">
      <metadata><rdf:RDF><dc:format>image/svg+xml</dc:format></rdf:RDF></metadata><ed:namedview pagecolor="#fff"/>
      <image xlink:href="data:image/png;base64,iVBORw0KGgo=" width="4" height="4"/>
      <a href="https://site.example/more"><rect width="9" height="9"><animate attributeName="opacity" values="0;1" dur="1s"/></rect></a></svg>`;
    expect(identifyImage(text(drawing))).toBe("svg");
  });

  it("takes no SVG to be inert where there is no parser to read it with", () => {
    const plain = `<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`;
    expect(inertSvg(plain)).toBe(true);
    expect(inertSvg(plain, null as unknown as undefined)).toBe(false);
    expect(identifyBinaryImage(text(plain))).toBeNull();
  });
});
