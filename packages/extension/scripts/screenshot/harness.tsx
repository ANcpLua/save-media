// Store-screenshot harness. Mounts the REAL popup <App/> component (not a
// mockup) seeded with representative descriptors, framed on the brand navy
// canvas at exactly 1280x800. Whatever ships in the popup is what appears in
// the store screenshot — they cannot drift.
import { createRoot } from "react-dom/client";
import { App } from "../../src/popup/App";
import {
  directDescriptor,
  hlsDescriptor,
  dashDescriptor,
  drmDescriptor,
} from "../../tests/unit/popup/helpers/descriptors";
import type { StreamDescriptor, StreamId } from "@savemedia/core";

interface Scene {
  readonly id: string;
  readonly caption: string;
  readonly sub: string;
  readonly descriptors: readonly StreamDescriptor[];
}

const SCENES: readonly Scene[] = [
  {
    id: "01-direct-video",
    caption: "Save a verified direct video",
    sub: "Only complete, browser-visible media is offered for download.",
    descriptors: [
      directDescriptor({ title: "lecture-recording.mp4" }),
      hlsDescriptor({ title: "stream.m3u8" }),
    ],
  },
  {
    id: "02-stream-support",
    caption: "Knows what it can finish",
    sub: "Direct MP4/WebM/MKV and plain HLS VOD — assembled locally, no remote server.",
    descriptors: [
      hlsDescriptor({ title: "documentary-1080p.m3u8" }),
    ],
  },
  {
    id: "03-refusal-safety",
    caption: "Protected media is refused",
    sub: "DRM, DASH, encrypted, and live streams are detected and never bypassed.",
    descriptors: [
      drmDescriptor("cdm_required"),
      dashDescriptor({ title: "adaptive.mpd", id: "stream-dash-shot" as StreamId }),
    ],
  },
];

// Small promotional tile (Chrome/Edge): 440x280, logo + wordmark + tagline.
// Uses the real logo via the served public/ icons; no product UI screenshot,
// so it stays accurate and on-brand.
function PromoTile() {
  return (
    <div
      data-scene="promo-440x280"
      style={{
        width: 440,
        height: 280,
        background: "#0e1b26",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
        boxSizing: "border-box",
        padding: 24,
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      }}
    >
      <img src="/icons/icon-128.png" alt="" width={96} height={96} style={{ borderRadius: 20 }} />
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 30, fontWeight: 700, color: "#eef3f6", letterSpacing: -0.5 }}>savemedia</div>
        <div style={{ fontSize: 14, color: "#9fb2be", marginTop: 6 }}>
          Save verified video &amp; clear HLS VOD
        </div>
      </div>
    </div>
  );
}

function Frame({ scene }: { scene: Scene }) {
  return (
    <div
      data-scene={scene.id}
      style={{
        width: 1280,
        height: 800,
        background: "#0e1b26",
        display: "flex",
        alignItems: "center",
        gap: 64,
        padding: "0 80px",
        boxSizing: "border-box",
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      }}
    >
      <div style={{ flex: 1, color: "#eef3f6" }}>
        <h1 style={{ fontSize: 44, fontWeight: 700, margin: 0, lineHeight: 1.1, letterSpacing: -0.5 }}>
          {scene.caption}
        </h1>
        <p style={{ fontSize: 19, color: "#9fb2be", marginTop: 16, maxWidth: 380, lineHeight: 1.5 }}>
          {scene.sub}
        </p>
        <p
          style={{
            marginTop: 40,
            fontSize: 13,
            color: "#7d93a1",
            background: "#18242e",
            display: "inline-block",
            padding: "8px 14px",
            borderRadius: 999,
          }}
        >
          Runs locally · No telemetry · No remote services
        </p>
      </div>
      <div
        style={{
          width: 380,
          minHeight: 440,
          borderRadius: 16,
          overflow: "hidden",
          boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
          border: "1px solid #28343f",
          flexShrink: 0,
        }}
      >
        <App initialDescriptors={scene.descriptors} skipFetch />
      </div>
    </div>
  );
}

const params = new URLSearchParams(location.search);
const wanted = params.get("scene") ?? SCENES[0]!.id;

const root = document.getElementById("root");
if (root) {
  if (wanted === "promo-440x280") {
    createRoot(root).render(<PromoTile />);
  } else {
    const scene = SCENES.find(s => s.id === wanted) ?? SCENES[0]!;
    createRoot(root).render(<Frame scene={scene} />);
  }
}

// Expose the scene list so the Playwright driver can iterate without hardcoding.
(globalThis as unknown as { __SCENES__: readonly string[] }).__SCENES__ = SCENES.map(s => s.id);
