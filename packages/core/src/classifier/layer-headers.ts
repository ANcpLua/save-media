import type { ProtocolFamily, Container, Confidence } from "../types/stream";
import { detectContainerFromMime } from "./container-registry";

export interface HeaderClassification {
  readonly protocol: ProtocolFamily;
  readonly container: Container;
  readonly titleHint: string | null;
  readonly confidence: Confidence;
}

const CT_TO_PROTOCOL: Record<string, ProtocolFamily> = {
  "application/vnd.apple.mpegurl": "hls",
  "application/x-mpegurl": "hls",
  "audio/mpegurl": "hls",
  "application/dash+xml": "dash",
};

function lowerHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function extractFilename(contentDisposition: string): string | null {
  const star = /filename\*=([^']*)''([^;]+)/i.exec(contentDisposition);
  if (star) {
    try { return decodeURIComponent(star[2]!); } catch { /* fall through */ }
  }
  const plain = /filename="([^"]+)"|filename=([^;]+)/i.exec(contentDisposition);
  if (plain) return (plain[1] ?? plain[2] ?? "").trim();
  return null;
}

export function classifyByHeaders(headers: Record<string, string>): HeaderClassification {
  const h = lowerHeaders(headers);
  const ct = (h["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();

  const protocol: ProtocolFamily = CT_TO_PROTOCOL[ct] ?? "unknown";
  const container = detectContainerFromMime(ct);
  const cd = h["content-disposition"];
  const titleHint = cd ? extractFilename(cd) : null;

  return {
    protocol,
    container,
    titleHint,
    confidence: {
      protocol: protocol === "unknown" ? "guessed" : "probable",
      container: container === "unknown" ? "guessed" : "probable",
      codecs: "guessed",
    },
  };
}
