// What a response's bytes are, for Alt+S image saves. Only the bytes decide:
// a Content-Type never makes bytes an image. Imports nothing; SVG is checked
// with the DOMParser of the document the image job runs in.

export type ImageType = "jpeg" | "png" | "gif" | "webp" | "avif" | "jxl" | "bmp" | "ico" | "svg";

export const IMAGE_MIME: Readonly<Record<ImageType, string>> = {
  jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  jxl: "image/jxl", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
};

export const IMAGE_EXTENSION: Readonly<Record<ImageType, string>> = {
  jpeg: "jpg", png: "png", gif: "gif", webp: "webp", avif: "avif", jxl: "jxl", bmp: "bmp", ico: "ico", svg: "svg",
};

function starts(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
  if (bytes.length < at + signature.length) return false;
  return signature.every((value, index) => bytes[at + index] === value);
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

function u32le(bytes: Uint8Array, at: number): number {
  return bytes.length >= at + 4 ? (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0 : -1;
}

function isAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== "ftyp") return false;
  const size = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  const end = Math.min(bytes.length, size >= 16 ? size : 16);
  for (let at = 8; at + 4 <= end; at += at === 8 ? 8 : 4) {
    const brand = ascii(bytes, at, 4);
    if (brand === "avif" || brand === "avis") return true;
  }
  return false;
}

/** The text of a UTF-8 head, or null when the bytes are not text. */
function textOf(bytes: Uint8Array): string | null {
  if (bytes.some(value => value === 0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length)); }
  catch {
    // A multi-byte character cut at the end of the head is still text.
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, Math.max(0, bytes.length - 3))); }
    catch { return null; }
  }
}

/** The markup after the byte order mark, whitespace, XML declaration, comments and doctype. */
function markupRoot(text: string): string {
  let rest = text.replace(/^\uFEFF/, "");
  for (;;) {
    const before = rest;
    rest = rest.replace(/^\s+/, "").replace(/^<\?xml[\s\S]*?\?>/i, "").replace(/^<!--[\s\S]*?-->/, "")
      .replace(/^<!doctype\s+svg[^>]*>/i, "");
    if (rest === before) return rest;
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

interface SvgParser { new(): { parseFromString(text: string, type: "image/svg+xml"): Document } }

/** A link or animation value that runs script, read as the browser reads it: without whitespace and control characters. */
function runsScript(value: string): boolean {
  return value.split(";").some(part => /^(?:javascript|vbscript):/i.test(part.replace(/[\u0000-\u0020\u007f-\u009f]+/g, "")));
}

/**
 * SVG that runs nothing when it is opened from the Downloads folder: no
 * script, no embedded HTML, no event handlers, no script links and no
 * animation that sets one. Decided on the parsed document, because prefixes,
 * namespaces and character references hide all of these from the text.
 * Without a parser nothing is taken to be inert.
 */
export function inertSvg(text: string, Parser: SvgParser | undefined = (globalThis as { DOMParser?: SvgParser }).DOMParser): boolean {
  if (/<\s*script\b/i.test(text) || /<\s*foreignObject\b/i.test(text) || /\son[a-z]+\s*=/i.test(text)) return false;
  if (!Parser) return false;
  let doc: Document;
  try { doc = new Parser().parseFromString(text, "image/svg+xml"); } catch { return false; }
  const root = doc.documentElement;
  if (!root || root.localName !== "svg" || root.namespaceURI !== SVG_NS || doc.getElementsByTagName("parsererror").length) return false;
  // A style sheet instruction can transform the document into anything.
  for (let node = doc.firstChild; node; node = node.nextSibling) if (node.nodeType === 7 /* PROCESSING_INSTRUCTION_NODE */) return false;
  const elements = [root, ...Array.from(root.getElementsByTagName("*"))];
  for (const element of elements) {
    const name = element.localName.toLowerCase();
    // HTML inside an SVG is live: its scripts, frames and handlers run.
    if (name === "script" || name === "foreignobject" || element.namespaceURI === XHTML_NS) return false;
    const animates = name === "set" || name.startsWith("animate");
    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.localName.toLowerCase();
      if (attribute.namespaceURI === null && attributeName.startsWith("on")) return false;
      if (runsScript(attribute.value)) return false;
      if (animates && attributeName === "attributename" && /^(?:xlink:)?href$/i.test(attribute.value.trim())) return false;
    }
  }
  return true;
}

/** The image type the first bytes name, for every type but SVG. */
export function identifyBinaryImage(bytes: Uint8Array): Exclude<ImageType, "svg"> | null {
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (isAvif(bytes)) return "avif";
  if (starts(bytes, [0xff, 0x0a]) || starts(bytes, [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a])) return "jxl";
  if (starts(bytes, [0x42, 0x4d]) && u32le(bytes, 6) === 0 && [12, 40, 52, 56, 108, 124].includes(u32le(bytes, 14))) return "bmp";
  if ((starts(bytes, [0, 0, 1, 0]) || starts(bytes, [0, 0, 2, 0])) && bytes.length >= 10
    && (bytes[4]! | (bytes[5]! << 8)) >= 1 && bytes[9] === 0) return "ico";
  return null;
}

/** Whether the bytes are text: only text can still be an SVG. */
export function isText(bytes: Uint8Array): boolean {
  return textOf(bytes) !== null;
}

/**
 * The image type of the given bytes, or null. For SVG pass the whole file:
 * an SVG that carries script is not accepted as an image.
 */
export function identifyImage(bytes: Uint8Array, Parser?: SvgParser): ImageType | null {
  const binary = identifyBinaryImage(bytes);
  if (binary) return binary;
  const text = textOf(bytes);
  if (text !== null && /^<svg[\s>/]/i.test(markupRoot(text)) && inertSvg(text, Parser)) return "svg";
  return null;
}

/** What bytes that are not an image are instead, for a plain refusal. */
export function notImageKind(bytes: Uint8Array): "page" | "program" | "data" | "unknown" {
  if (starts(bytes, [0x4d, 0x5a]) || starts(bytes, [0x7f, 0x45, 0x4c, 0x46]) || starts(bytes, [0x23, 0x21])
    || starts(bytes, [0xca, 0xfe, 0xba, 0xbe]) || starts(bytes, [0xfe, 0xed, 0xfa, 0xce]) || starts(bytes, [0xfe, 0xed, 0xfa, 0xcf])
    || starts(bytes, [0xce, 0xfa, 0xed, 0xfe]) || starts(bytes, [0xcf, 0xfa, 0xed, 0xfe])
    || starts(bytes, [0x50, 0x4b, 0x03, 0x04]) || starts(bytes, [0x50, 0x4b, 0x05, 0x06]) || starts(bytes, [0x52, 0x61, 0x72, 0x21])
    || starts(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || starts(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    || starts(bytes, [0x78, 0x61, 0x72, 0x21]) || starts(bytes, [0x1f, 0x8b])) return "program";
  const text = textOf(bytes);
  if (text === null) return "unknown";
  const root = markupRoot(text).replace(/^<!doctype[^>]*>/i, "").replace(/^\s+/, "");
  if (/^<!doctype\s+html/i.test(markupRoot(text)) || /^<(html|head|body|script)[\s>/]/i.test(root)) return "page";
  return "data";
}
