import { describe, expect, it } from "vitest";
import * as text from "../../../src/ui/text";
import * as toast from "../../../src/ui/toast-text";
import { LOCAL_FAILURE_CODES } from "../../../src/types/native";
import type { TransferStage } from "../../../src/types/transfer";
import { describeTransfer } from "../../../src/util/transfer-progress";
import { toastDetail } from "@savemedia/core";

/** Every string a catalogue holds or can produce: constants, record values, and functions called with plain sample arguments. */
function strings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "function") {
    try {
      const fn = value as (...args: unknown[]) => unknown;
      // Sample arguments by arity: counts, names and sizes are the only things these functions take.
      return strings(fn.length === 0 ? fn() : fn(...[3, "12.0 MB", 2].slice(0, fn.length)), seen);
    } catch { return []; }
  }
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap(item => strings(item, seen));
}

const localFailures = LOCAL_FAILURE_CODES.flatMap(code => {
  const message = text.localFailureMessage({ code, message: "" });
  return [message.title, message.body, message.hint ?? "", message.toastHint ?? ""];
});
const statusFailures = [401, 404, 407, 429, 451, 503, 418].flatMap(httpStatus => {
  const message = text.localFailureMessage({ code: "unknown", message: "", httpStatus });
  return [message.title, message.body, message.hint ?? "", message.toastHint ?? ""];
});
const STAGES: TransferStage[] = [
  { kind: "starting" }, { kind: "probing" }, { kind: "playlist" }, { kind: "downloading" }, { kind: "segment", index: 1, count: 2 },
  { kind: "track", track: "video" }, { kind: "track", track: "audio" }, { kind: "retrying", attempt: 1, maxAttempts: 3, waitMs: 2000, httpStatus: 503, part: null },
  { kind: "retrying", attempt: 1, maxAttempts: 3, waitMs: 2000, httpStatus: null, part: null }, { kind: "reconnecting", waitMs: 2000 }, { kind: "resuming" },
  { kind: "rechecking" }, { kind: "restarting", cause: "retained-rejected" }, { kind: "restarting", cause: "ranges-unusable" },
  { kind: "remuxing", fraction: null }, { kind: "merging", fraction: null }, { kind: "verifying" }, { kind: "finalizing" }, { kind: "writing" },
];

const ALL = [...new Set([
  ...strings(text), ...strings(toast.TOAST_LABELS), toast.RECONNECT_HINT, ...localFailures, ...statusFailures,
  ...STAGES.map(stage => describeTransfer({ stage }).label),
])].filter(item => item.length > 0);

/** The browsers yt-dlp can read cookies from are a choice of cookie source in one menu, and appear nowhere in these catalogues. */
describe("every string the extension shows", () => {
  it("covers the catalogues", () => {
    expect(ALL.length).toBeGreaterThan(150);
    expect(ALL).toContain("Save only what you have the right to keep.");
    expect(ALL).toContain("Blocked for legal reasons");
    expect(ALL).toContain("Checking");
    expect(ALL).toContain("Joining video and audio");
  });

  it.each(ALL)("%s", item => {
    // The product is savemedia, in lowercase, also at the start of a sentence.
    expect(item).not.toMatch(/SaveMedia|Savemedia|Save Media/);
    // Shared strings say "your browser", never a browser's name.
    expect(item).not.toMatch(/\b(?:Chrome|Chromium|Firefox|Edge|Safari|Brave)\b/);
    // No long dashes, no pictographs, no shouting, no begging.
    expect(item).not.toMatch(/[–—]|\p{Extended_Pictographic}|!|\bplease\b/iu);
    expect(item).not.toMatch(/\.\.\./);
    // Codes and protocol words belong under Technical details.
    expect(item).not.toMatch(/net::|ERR_|\b[a-z]+_[a-z_]+\b|\bCDM\b|\bEME\b|\bMIME\b|\bBlob\b|remux|manifest/);
    // savemedia works from what the browser receives: nothing points at a site's own controls.
    expect(item).not.toMatch(/site'?s (?:own )?(?:download )?(?:button|control|player)|use the site|download button/i);
    // Nothing suggests a way around a block.
    expect(item).not.toMatch(/\b(?:VPN|another DNS|different DNS|public DNS|turn off|switch off|disable|bypass|work around|circumvent)\b/i);
    // Encryption is never a feature that is coming.
    expect(item).not.toMatch(/not implemented|not supported yet|in this version|coming soon/i);
  });

  it("uses HTTP only as the name of a row under Technical details", () => {
    expect(ALL.filter(item => /HTTP|\b[1-5]\d\d\b/.test(item))).toEqual([]);
    const details = text.localFailureMessage({ code: "unknown", message: "", httpStatus: 503 }).details;
    expect(details[0]).toEqual({ label: "HTTP status", value: "503" });
  });

  it("names its own parts one way", () => {
    const joined = ALL.join("\n");
    expect(joined).toContain("savemedia helper");
    expect(joined).toContain("Local downloader");
    expect(joined).not.toMatch(/local downloader(?! )|native host|Host missing|the host\b|browser engine/);
    expect(joined).not.toMatch(/Downloads directory|download folder\b/i);
    expect(joined).toContain("Downloads folder");
  });

  it("labels a toast with its state and gives every outcome a colour and a time", () => {
    for (const outcome of toast.TOAST_OUTCOMES) {
      expect(toast.TOAST_LABELS[outcome].split(" ").length).toBeLessThanOrEqual(3);
      expect(toast.TOAST_TONE[outcome]).toMatch(/^#[0-9a-f]{6}$/);
      expect(toast.toastDuration(outcome)).toBeGreaterThanOrEqual(4_000);
    }
    // The detail is the object, so it never starts with the label again.
    for (const detail of Object.values(text.HOTKEY)) {
      for (const label of Object.values(toast.TOAST_LABELS)) expect(detail.startsWith(`${label} `)).toBe(false);
    }
  });

  it("a Local downloader toast never points at a control only the popup has without saying to open savemedia", () => {
    const failures = [...LOCAL_FAILURE_CODES.map(code => text.localFailureMessage({ code, message: "" })),
      ...[401, 403, 407, 429].map(httpStatus => text.localFailureMessage({ code: "unknown", message: "", httpStatus }))];
    for (const message of failures) {
      const line = toastDetail(message);
      expect(line).not.toMatch(/this popup/);
      if (/Under Cookies|under Local downloader|No cookies/.test(line)) expect(line).toMatch(/Open savemedia/);
    }
    expect(toastDetail(text.localFailureMessage({ code: "host_unavailable", message: "" })))
      .toBe("Helper not reachable. Open savemedia for the install command under Local downloader.");
    expect(toastDetail(text.localFailureMessage({ code: "login_required", message: "" })))
      .toBe("Sign-in needed. Open savemedia and, under Cookies, choose the browser you are signed in with.");
    expect(toastDetail(text.localFailureMessage({ code: "invalid_request", message: "" })))
      .toBe("Request rejected. Open savemedia for the setup command under Local downloader, then try again.");
    // The popup shows the setup command with exactly the failures whose hint names a command.
    for (const code of LOCAL_FAILURE_CODES) {
      expect(text.NAMES_SETUP_COMMAND.has(code), code).toBe(/\bcommand\b/.test(text.localFailureMessage({ code, message: "" }).hint ?? ""));
    }
    // A hint that reads the same on the page has no second wording.
    expect(text.localFailureMessage({ code: "ytdlp_missing", message: "" }).toastHint).toBeUndefined();
  });

  it("builds its small composed strings as written", () => {
    expect(text.POPUP.qualityNumber(2)).toBe("Quality 2");
    expect(text.savedText("clip.mp4", "12.0 MB")).toBe("Saved to Downloads: clip.mp4 · 12.0 MB");
    expect(text.savedText(undefined, null)).toBe("Saved to Downloads");
    expect(text.retainedText("2.0 MB", "8.0 MB", 1)).toBe("savemedia kept 2.0 MB of 8.0 MB for 1 more minute. Retry save in this tab to continue from there.");
    expect(text.withSize("Best quality", "245.3 MB")).toBe("Best quality · 245.3 MB");
    expect(text.withSize("Best quality", null)).toBe("Best quality");
    expect(text.POPUP.ads(1)).toBe("Ads (1)");
    expect(text.POPUP.otherMedia(3)).toBe("Other media (3)");
    expect(text.ANNOUNCE.found(1)).toBe("Found 1 item.");
    expect(text.TOOLBAR.one("Downloading", "42% of 1.20 GB")).toBe("savemedia · Downloading · 42% of 1.20 GB");
    expect(text.TOOLBAR.feedback("Saved", "clip.mp4")).toBe("savemedia · Saved: clip.mp4");
    expect(text.REPEAT.question).toBe("savemedia already saved this file in this browser session. Save another copy?");
  });
});
