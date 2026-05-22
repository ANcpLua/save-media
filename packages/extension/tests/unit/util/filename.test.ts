import { describe, it, expect } from "vitest";
import { sanitizeFilename, suggestFilename } from "../../../src/util/filename";

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
    expect(sanitizeFilename("emoji 😀 here")).toBe("emoji _ here");
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

  it("returns a fallback when input cleans to empty", () => {
    expect(sanitizeFilename("///")).toBe("video");
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
});
