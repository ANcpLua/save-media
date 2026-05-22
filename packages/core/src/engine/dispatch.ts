import type { StreamDescriptor, Container, OutputContainer } from "../types/stream";
import type { JobPlan, UserChoice, DispatchRefusal } from "../types/job";

function asOutputContainer(c: Container): OutputContainer {
  if (c === "mp4" || c === "webm" || c === "mkv") return c;
  return "mp4";
}

export function dispatch(descriptor: StreamDescriptor, choice: UserChoice): JobPlan | DispatchRefusal {
  if (descriptor.drm) {
    return { kind: "refuse", reason: descriptor.drm.reason };
  }

  if (descriptor.capabilities.directDownload && choice.outputMode === "Original") {
    if (descriptor.source.kind === "direct-url") {
      return { kind: "direct", url: descriptor.source.url, filename: choice.filename };
    }
  }

  // HLS / DASH / Remux / Transcode plans are populated by Plan 3 (engine).
  // Plan 1 returns a placeholder RemuxPlan-shaped value when no other path applies.
  // The pure-logic core is enough to gate DRM refusal and route direct downloads;
  // the actual JobStep[] builders for HLS/DASH live in Plan 3.
  return {
    kind: "remux",
    steps: [
      { op: "remux", engine: "mediabunny", toContainer: "mp4" },
      { op: "verify", checks: ["container-validity"] },
      { op: "finalize", sink: "downloads" },
    ],
    fromContainer: asOutputContainer(descriptor.container),
    outputContainer: "mp4",
    outputFilename: choice.filename,
    estimatedBytes: null,
  };
}
