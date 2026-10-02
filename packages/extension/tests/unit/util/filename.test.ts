import { describe, it, expect } from "vitest";
import { sanitizeFilename, suggestFilename, timestampedPath } from "../../../src/util/filename";

describe("sanitizeFilename", () => {
  it("preserves alphanumerics, dots, underscores, hyphens, spaces", () => {
    expect(sanitizeFilename("Hello World - 2024.mp4")).toBe("Hello World - 2024.mp4");
  });

  it("strips path separators", () => {
    expect(sanitizeFilename("foo/bar\\baz")).toBe("foobarbaz");
  });

  it("replaces illegal characters with a single underscore", () => {
    expect(sanitizeFilename("a???b")).toBe("a_b");
  });

  it("collapses consecutive replacement underscores", () => {
    expect(sanitizeFilename("a<<>>b")).toBe("a_b");
  });

  it("keeps letters and digits of every script, and emoji", () => {
    expect(sanitizeFilename("Café Überblick 東京 😀")).toBe("Café Überblick 東京 😀");
  });

  it("truncates at the default maxLength of 80", () => {
    expect(sanitizeFilename("x".repeat(200))).toHaveLength(80);
  });

  it("uses a custom maxLength when provided", () => {
    expect(sanitizeFilename("x".repeat(40), 10)).toHaveLength(10);
  });

  it("strips trailing dots (Windows-portability)", () => {
    expect(sanitizeFilename("filename...")).toBe("filename");
  });

  it("returns null when nothing with a letter or digit is left", () => {
    expect(sanitizeFilename("///")).toBeNull();
    expect(sanitizeFilename("???")).toBeNull();
    expect(sanitizeFilename("_")).toBeNull();
    expect(sanitizeFilename("- . -")).toBeNull();
  });

  it("strips trailing spaces together with trailing dots", () => {
    expect(sanitizeFilename("name . . ")).toBe("name");
  });
});

describe("suggestFilename", () => {
  it("uses descriptor title when present", () => {
    expect(suggestFilename({ title: "My Cool Video", pageUrl: "https://x.com/" })).toBe("My Cool Video.mp4");
  });

  it("uses the last URL path segment when title is null", () => {
    expect(suggestFilename({ title: null, pageUrl: "https://x.com/path/to/clip.html" })).toBe("clip.mp4");
  });

  it("falls back to hostname when path is empty", () => {
    expect(suggestFilename({ title: null, pageUrl: "https://video.example.com/" })).toBe("video.example.com.mp4");
  });

  it("respects requested container", () => {
    expect(suggestFilename({ title: "stream", pageUrl: "https://x.com/" }, "webm")).toBe("stream.webm");
  });

  it("returns 'video.<ext>' when both title and pageUrl are unusable", () => {
    expect(suggestFilename({ title: null, pageUrl: "not-a-url" })).toBe("video.mp4");
  });

  it("strips path separators from titles before suffixing the container", () => {
    expect(suggestFilename({ title: "My/Clip", pageUrl: "https://x.com/" })).toBe("MyClip.mp4");
  });

  it("never produces an underscore-only name: a symbol-only title falls back to the page URL", () => {
    expect(suggestFilename({ title: "???", pageUrl: "https://x.com/watch/lecture-3.html" })).toBe("lecture-3.mp4");
    expect(suggestFilename({ title: "_", pageUrl: "https://video.example.com/" })).toBe("video.example.com.mp4");
    expect(suggestFilename({ title: " ", pageUrl: "not-a-url" })).toBe("video.mp4");
  });

  it("reads plus signs as spaces when a title has no spaces at all", () => {
    expect(suggestFilename({ title: "Erin+Everheart+-+Talk", pageUrl: "https://x.com/" })).toBe("Erin Everheart - Talk.mp4");
    expect(suggestFilename({ title: "C++ intro", pageUrl: "https://x.com/" })).toBe("C++ intro.mp4");
    expect(suggestFilename({ title: null, pageUrl: "https://cdn.example/v/My+Clip+2026.mp4" })).toBe("My Clip 2026.mp4");
  });

  it("keeps non-ASCII titles instead of replacing them with underscores", () => {
    expect(suggestFilename({ title: "Vorlesung Übersicht", pageUrl: "https://x.com/" })).toBe("Vorlesung Übersicht.mp4");
  });
});

describe("timestampedPath", () => {
  const at = (h: number, m = 0, sec = 0) => new Date(2026, 0, 5, h, m, sec);

  it("puts each six-hour block in its own folder, boundaries included", () => {
    const folder = (d: Date) => timestampedPath("a.mp4", d).split("/")[0];
    expect(folder(at(0))).toBe("2026-01-05 1 Night");
    expect(folder(at(5, 59, 59))).toBe("2026-01-05 1 Night");
    expect(folder(at(6))).toBe("2026-01-05 2 Morning");
    expect(folder(at(11, 59, 59))).toBe("2026-01-05 2 Morning");
    expect(folder(at(12))).toBe("2026-01-05 3 Afternoon");
    expect(folder(at(17, 59, 59))).toBe("2026-01-05 3 Afternoon");
    expect(folder(at(18))).toBe("2026-01-05 4 Evening");
    expect(folder(at(23, 59, 59))).toBe("2026-01-05 4 Evening");
  });

  it("names the file date_HHMMSS, zero padded and without dashes in the time", () => {
    expect(timestampedPath("a.mp4", at(3, 4, 5))).toBe("2026-01-05 1 Night/2026-01-05_030405.mp4");
  });

  it("keeps only the last extension, lowercased", () => {
    expect(timestampedPath("my.clip.MOV", at(9))).toBe("2026-01-05 2 Morning/2026-01-05_090000.mov");
  });

  it("adds no extension when the name has none", () => {
    expect(timestampedPath("clip", at(9))).toBe("2026-01-05 2 Morning/2026-01-05_090000");
    expect(timestampedPath(".hidden", at(9))).toBe("2026-01-05 2 Morning/2026-01-05_090000");
  });
});
