import type { Container, Confidence } from "../types/stream";
import { detectContainerFromBytes } from "./container-registry";

export interface MagicByteClassification {
  readonly container: Container;
  readonly confidence: Confidence;
}

export function classifyByMagicBytes(bytes: Uint8Array): MagicByteClassification {
  const container = detectContainerFromBytes(bytes);
  return {
    container,
    confidence: {
      protocol: "guessed",
      container: container === "unknown" ? "guessed" : "confirmed",
      codecs: "guessed",
    },
  };
}
