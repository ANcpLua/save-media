import { describe, expect, it } from "vitest";
import { classifyByHeaders } from "../../src/classifier/layer-headers";

describe("layer-headers", () => {
  it("Content-Type: application/vnd.apple.mpegurl → hls (probable)", () => {
    const r = classifyByHeaders({ "content-type": "application/vnd.apple.mpegurl" });
    expect(r.protocol).toBe("hls");
    expect(r.confidence.protocol).toBe("probable");
  });

  it("Content-Type: application/dash+xml → dash (probable)", () => {
    expect(classifyByHeaders({ "content-type": "application/dash+xml" }).protocol).toBe("dash");
  });

  it("Content-Type: video/webm → container=webm (probable)", () => {
    const r = classifyByHeaders({ "content-type": "video/webm" });
    expect(r.container).toBe("webm");
    expect(r.confidence.container).toBe("probable");
  });

  it("Content-Disposition filename → title hint", () => {
    const r = classifyByHeaders({ "content-disposition": 'attachment; filename="my video.mp4"' });
    expect(r.titleHint).toBe("my video.mp4");
  });

  it("missing headers → all unknown", () => {
    const r = classifyByHeaders({});
    expect(r.protocol).toBe("unknown");
    expect(r.container).toBe("unknown");
    expect(r.titleHint).toBeNull();
  });
});
