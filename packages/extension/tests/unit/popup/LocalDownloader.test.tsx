import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocalDownloader } from "../../../src/popup/components/LocalDownloader";

const ready = {
  settings: { enabled: true, quality: "best" as const, cookies: "auto" as const, fallbackOnHotkey: true },
  host: {
    type: "pong" as const, hostVersion: "1.0.0", protocolVersion: 1,
    ytdlp: { found: true, version: "2026.08.01", path: "/x" }, ffmpeg: { found: true, version: "7.1", path: "/y" }, outputDir: "/Users/me/Downloads",
  },
  permissionGranted: true,
  jobs: [],
};

describe("LocalDownloader popup section", () => {
  it("shows Off and a collapsed section by default", () => {
    render(<LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch initialStatus={{ ...ready, settings: { ...ready.settings, enabled: false }, host: null }} />);
    expect(screen.getByTestId("local-status-pill").textContent).toBe("Off");
    expect(screen.queryByTestId("local-download-page")).toBeNull();
  });

  it("shows Ready with tool versions and enables the page button", () => {
    render(<LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch initialStatus={ready} />);
    expect(screen.getByTestId("local-status-pill").textContent).toBe("Ready");
    expect(screen.getByTestId("local-host-ready").textContent).toContain("2026.08.01");
    expect((screen.getByTestId("local-download-page") as HTMLButtonElement).disabled).toBe(false);
  });

  it("explains a missing host when enabled but unreachable", () => {
    render(<LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch initialStatus={{ ...ready, host: null }} />);
    expect(screen.getByTestId("local-status-pill").textContent).toBe("Host missing");
    expect(screen.getByTestId("local-host-missing")).toBeTruthy();
    expect(screen.getByTestId("local-setup-command").textContent).toContain("curl -fsSL");
    expect(screen.getByTestId("local-setup-command").textContent).toContain("--extension-id");
    expect((screen.getByTestId("local-download-page") as HTMLButtonElement).disabled).toBe(true);
  });

  it("sends local-download for the current page", () => {
    render(<LocalDownloader tabId={3} pageUrl="https://example.com/watch" skipFetch initialStatus={ready} />);
    fireEvent.click(screen.getByTestId("local-download-page"));
    expect(vi.mocked(globalThis.chrome.runtime.sendMessage).mock.calls.map(c => c[0]))
      .toContainEqual({ type: "local-download", tabId: 3, pageUrl: "https://example.com/watch" });
  });

  it("renders active, complete and failed jobs", () => {
    const base = { pageUrl: "https://example.com/v", tabId: 1, downloadedBytes: null, totalBytes: null, speedBytesPerSec: null, etaSeconds: null, filename: null, failure: null };
    render(<LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch initialStatus={{ ...ready, jobs: [
      { ...base, id: "a", phase: "downloading", percent: 42 },
      { ...base, id: "b", phase: "complete", percent: 100, filename: "clip.mp4" },
      { ...base, id: "c", phase: "failed", percent: null, failure: { code: "drm_protected", message: "" } },
    ] }} />);
    expect(screen.getByTestId("local-job-active").textContent).toContain("42%");
    expect(screen.getByTestId("local-job-complete").textContent).toContain("clip.mp4");
    expect(screen.getByTestId("local-job-failed").textContent).toContain("Protected media");
  });
});

describe("enabling requests the optional permission from the popup gesture", () => {
  it("asks for nativeMessaging before turning on, and stays off when denied", async () => {
    const perms = { contains: vi.fn(async () => false), request: vi.fn(async () => false) };
    (globalThis.chrome as unknown as { permissions: typeof perms }).permissions = perms;
    render(<LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch initialStatus={{ ...ready, settings: { ...ready.settings, enabled: false }, host: null }} />);
    fireEvent.click(screen.getByTestId("local-enable"));
    await waitFor(() => expect(perms.request).toHaveBeenCalledWith({ permissions: ["nativeMessaging"] }));
    await waitFor(() => expect((screen.getByTestId("local-enable") as HTMLInputElement).disabled).toBe(false));
    const sent = vi.mocked(globalThis.chrome.runtime.sendMessage).mock.calls.map(c => c[0]);
    expect(sent).not.toContainEqual(expect.objectContaining({ type: "local-settings", patch: { enabled: true } }));

    perms.request.mockResolvedValue(true);
    fireEvent.click(screen.getByTestId("local-enable"));
    await waitFor(() => expect(perms.request).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(vi.mocked(globalThis.chrome.runtime.sendMessage).mock.calls.some(c => (c[0] as { type?: string })?.type === "local-settings")).toBe(true));
    const sent2 = vi.mocked(globalThis.chrome.runtime.sendMessage).mock.calls.map(c => c[0]);
    expect(sent2).toContainEqual({ type: "local-settings", patch: { enabled: true } });
  });

  it("offers the brew command when tools are missing", () => {
    render(<LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch initialStatus={{ ...ready, host: { ...ready.host, ffmpeg: { found: false, version: null, path: null } } }} />);
    expect(screen.getByTestId("local-status-pill").textContent).toBe("Tools missing");
    expect(screen.getByTestId("local-brew-command").textContent).toBe("brew install ffmpeg");
  });
});
