import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LocalDownloader } from "../../../src/popup/components/LocalDownloader";
import { AnnouncerProvider } from "../../../src/popup/components/Announcer";
import { LOCAL_FAILURE_CODES, NATIVE_PROTOCOL_VERSION } from "../../../src/types/native";
import { LOCAL, localFailureMessage } from "../../../src/ui/text";
import { describeTransfer, localTransfer } from "../../../src/util/transfer-progress";

const ready = {
  settings: { enabled: true, quality: "best" as const, cookies: "auto" as const, fallbackOnHotkey: true },
  host: {
    type: "pong" as const, hostVersion: "1.3.0", protocolVersion: NATIVE_PROTOCOL_VERSION,
    ytdlp: { found: true, version: "2026.08.01", path: "/x" }, ffmpeg: { found: true, version: "7.1", path: "/y" }, outputDir: "/Users/me/Downloads",
  },
  permissionGranted: true,
  jobs: [],
};

describe("LocalDownloader popup section", () => {
  it("is collapsed and says nothing about tools while it is off: the switch itself says off", () => {
    const onAvailability = vi.fn();
    render(<LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch onAvailability={onAvailability}
      initialStatus={{ ...ready, settings: { ...ready.settings, enabled: false }, host: null }} />);
    expect(screen.queryByTestId("local-status-pill")).toBeNull();
    expect(screen.queryByTestId("local-download-page")).toBeNull();
    expect((screen.getByRole("checkbox", { name: "Use yt-dlp" }) as HTMLInputElement).checked).toBe(false);
    const toggle = screen.getByRole("button", { name: "Local downloader" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(onAvailability).toHaveBeenLastCalledWith("off");
    fireEvent.click(toggle);
    expect(screen.getByText("Saves pages with yt-dlp and ffmpeg installed on this computer. Off until you turn it on.")).toBeTruthy();
  });

  it("shows Ready with tool versions and enables the page button", () => {
    render(<LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch initialStatus={ready} />);
    expect(screen.getByTestId("local-status-pill").textContent).toBe("Ready");
    expect(screen.getByTestId("local-host-ready").textContent).toBe("yt-dlp 2026.08.01 · ffmpeg 7.1 · saves to /Users/me/Downloads");
    const button = screen.getByTestId("local-download-page") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent?.trim()).toBe("Save this page with yt-dlp");
    expect(screen.getByText("Use for Alt+S when savemedia can't save the page in the browser")).toBeTruthy();
    expect(Array.from((screen.getByTestId("local-quality") as HTMLSelectElement).options, option => option.text)).toEqual(
      ["Best available", "Up to 1080p", "Up to 720p", "Up to 480p"]);
    expect(Array.from((screen.getByTestId("local-cookies") as HTMLSelectElement).options, option => option.text).slice(0, 2)).toEqual(
      ["This browser, if available", "No cookies"]);
  });

  it("says a version is unknown in words, and reports whether it can take a page", () => {
    const onAvailability = vi.fn();
    render(<LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch onAvailability={onAvailability}
      initialStatus={{ ...ready, host: { ...ready.host, ffmpeg: { found: true, version: null, path: "/y" } } }} />);
    expect(screen.getByTestId("local-host-ready").textContent).toBe("yt-dlp 2026.08.01 · ffmpeg version unknown · saves to /Users/me/Downloads");
    expect(onAvailability).toHaveBeenLastCalledWith("ready");
  });

  it("explains a missing host when enabled but unreachable", () => {
    render(<LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch initialStatus={{ ...ready, host: null }} />);
    expect(screen.getByTestId("local-status-pill").textContent).toBe("Helper not installed");
    expect(screen.getByTestId("local-host-missing").textContent).toContain("Install the savemedia helper: paste this into Terminal, then reopen this popup.");
    expect(screen.getByTestId("local-setup-command").textContent).toContain("curl -fsSL");
    expect(screen.getByTestId("local-setup-command").textContent).toContain("--extension-id");
    expect((screen.getByTestId("local-download-page") as HTMLButtonElement).disabled).toBe(true);
  });

  // The helper published before this protocol reports version 1.1.0 and protocol 1. So does a development copy
  // that calls itself 1.3.0: the protocol number decides, never the version text.
  it.each(["1.1.0", "1.3.0"])("asks for an update of a helper that speaks an earlier protocol (%s): never Ready, and nothing is saved with it", hostVersion => {
    const onAvailability = vi.fn();
    const base = { pageUrl: "https://example.com/", tabId: 1, downloadedBytes: null, totalBytes: null, speedBytesPerSec: null, etaSeconds: null, filename: null, percent: null };
    render(<LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch onAvailability={onAvailability} initialStatus={{ ...ready,
      host: { ...ready.host, hostVersion, protocolVersion: NATIVE_PROTOCOL_VERSION - 1 },
      jobs: [{ ...base, id: "r", phase: "failed" as const, failure: { code: "invalid_request" as const, message: "unknown field" } }] }} />);
    expect(screen.getByTestId("local-status-pill").textContent).toBe("Helper needs an update");
    expect(screen.getByTestId("local-host-outdated").textContent).toContain(
      "The installed savemedia helper is older than this version of savemedia needs. Paste this into Terminal to update it, then reopen this popup.");
    expect(screen.getByTestId("local-setup-command").textContent).toMatch(/^curl -fsSL \S+setup\.sh \| bash -s -- --extension-id \S+$/);
    expect(screen.queryByTestId("local-host-ready")).toBeNull();
    expect(screen.queryByTestId("local-host-missing")).toBeNull();
    expect((screen.getByTestId("local-download-page") as HTMLButtonElement).disabled).toBe(true);
    expect(onAvailability).toHaveBeenLastCalledWith("unavailable");
    // The section shows the command once: a failure whose hint names it does not repeat it.
    expect(screen.getAllByTestId("local-setup-command")).toHaveLength(1);
    expect(screen.queryByTestId("local-job-setup-command")).toBeNull();
  });

  it("asks for the update before it says which tools are missing, and takes a helper of a later protocol as it is", () => {
    const { unmount } = render(<LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch initialStatus={{ ...ready,
      host: { ...ready.host, protocolVersion: NATIVE_PROTOCOL_VERSION - 1, ytdlp: { found: false, version: null, path: null } } }} />);
    expect(screen.getByTestId("local-status-pill").textContent).toBe("Helper needs an update");
    expect(screen.queryByTestId("local-tools-missing")).toBeNull();
    unmount();
    render(<LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch initialStatus={{ ...ready, host: { ...ready.host, protocolVersion: NATIVE_PROTOCOL_VERSION + 1 } }} />);
    expect(screen.getByTestId("local-status-pill").textContent).toBe("Ready");
  });

  // The popup's row and the toolbar button show one job: both draw it from localTransfer and describeTransfer.
  it.each([
    ["probing", { percent: null, downloadedBytes: null, totalBytes: null }, "Starting", null, null],
    ["downloading", { percent: 12.4, downloadedBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024 }, "Downloading", "12", "1.0 MB of 8.0 MB"],
    ["merging", { percent: null, downloadedBytes: null, totalBytes: null }, "Joining video and audio", null, null],
  ] as const)("shows a %s job with the words and the bar the toolbar button uses", (phase, progress, label, value, bytes) => {
    const job = { id: "a", pageUrl: "https://example.com/", tabId: 1, speedBytesPerSec: null, etaSeconds: null, filename: null, failure: null, phase, ...progress };
    render(<LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch initialStatus={{ ...ready, jobs: [job] }} />);
    const active = screen.getByTestId("local-job-active");
    const toolbar = describeTransfer(localTransfer(job));
    expect(toolbar.label).toBe(label);
    expect(within(active).getByTestId("progress-label").textContent).toBe(toolbar.label);
    // No percent: the bar shows work without a known end, and never a made-up length.
    expect(within(active).getByRole("progressbar").getAttribute("value")).toBe(value);
    expect(toolbar.percent).toBe(value === null ? undefined : Number(value));
    expect(within(active).queryByTestId("progress-bytes")?.textContent ?? null).toBe(bytes);
  });

  it("shows the downloader's own speed and expected time beside the percent", () => {
    const job = { id: "a", pageUrl: "https://example.com/", tabId: 1, filename: "clip.mp4", failure: null, phase: "downloading" as const,
      percent: 50, downloadedBytes: null, totalBytes: null, speedBytesPerSec: 2 * 1024 * 1024, etaSeconds: 65 };
    render(<LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch initialStatus={{ ...ready, jobs: [job] }} />);
    expect(screen.getByTestId("local-job-name").textContent).toBe("clip.mp4");
    expect(screen.getByTestId("local-job-pace").textContent).toBe("50% · 2.0 MB/s · 1m 5s");
    // No size is known, so none is shown: never "0 B received".
    expect(screen.queryByTestId("progress-bytes")).toBeNull();
  });

  it("sends local-download for the current page", () => {
    render(<LocalDownloader tabId={3} pageUrl="https://example.com/watch" skipFetch initialStatus={ready} />);
    fireEvent.click(screen.getByTestId("local-download-page"));
    expect(vi.mocked(globalThis.chrome.runtime.sendMessage).mock.calls.map(c => c[0]))
      .toContainEqual({ type: "local-download", tabId: 3, pageUrl: "https://example.com/watch" });
  });

  it("renders active, complete and failed jobs", () => {
    const base = { pageUrl: "https://example.com/", tabId: 1, downloadedBytes: null, totalBytes: null, speedBytesPerSec: null, etaSeconds: null, filename: null, failure: null };
    render(<LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch initialStatus={{ ...ready, jobs: [
      { ...base, id: "a", phase: "downloading", percent: 42 },
      { ...base, id: "b", phase: "complete", percent: 100, filename: "clip.mp4" },
      { ...base, id: "c", phase: "failed", percent: null, failure: { code: "drm_protected", message: "" } },
      { ...base, id: "d", tabId: 2, phase: "failed", percent: null, failure: { code: "network", message: "" } },
      { ...base, id: "e", phase: "failed", percent: null,
        failure: { code: "unknown", message: "ERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden", httpStatus: 403 } },
    ] }} />);
    const active = screen.getByTestId("local-job-active");
    expect(within(active).getByTestId("local-job-name").textContent).toBe("example.com");
    expect(within(active).getByTestId("local-job-pace").textContent).toBe("42%");
    expect(within(active).getByTestId("progress-label").textContent).toBe("Downloading");
    // The bar every save has, with what a screen reader is told about it.
    const bar = within(active).getByRole("progressbar");
    expect(bar.getAttribute("value")).toBe("42");
    expect(bar.getAttribute("aria-valuetext")).toBe("42%");
    expect(screen.getByTestId("local-job-complete").textContent).toBe("Saved clip.mp4");
    expect(screen.getByTestId("local-job-complete").querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    // A failure is shown the one way every failure is shown.
    const failed = screen.getAllByTestId("local-job-failed");
    const protectedJob = failed.find(item => item.getAttribute("data-tone") === "protected")!;
    expect(within(protectedJob).getByTestId("failure-title").textContent).toBe("Protected video");
    expect(within(protectedJob).getByTestId("failure-body").textContent).toBe("This video is protected with DRM. savemedia does not save DRM-protected media.");
    // The status and yt-dlp's own line are technical details, never the main text.
    const refused = failed.find(item => item !== protectedJob)!;
    expect(within(refused).getByTestId("failure-title").textContent).toBe("The site refused yt-dlp");
    const visible = refused.cloneNode(true) as HTMLElement;
    visible.querySelector("details")!.remove();
    expect(visible.textContent).not.toMatch(/403|ERROR|HTTP/);
    const rows = [...refused.querySelectorAll("dt")].map((label, index) => [label.textContent, refused.querySelectorAll("dd")[index]!.textContent]);
    expect(rows).toEqual([["HTTP status", "403"], ["Helper said", "ERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden"],
      ["Error code", "unknown"]]);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the setup command with a failure whose hint names it, also while the helper answers", () => {
    const base = { pageUrl: "https://example.com/", tabId: 1, downloadedBytes: null, totalBytes: null, speedBytesPerSec: null, etaSeconds: null, filename: null, percent: null };
    const rejected = { ...base, id: "r", phase: "failed" as const, failure: { code: "invalid_request" as const, message: "unknown field" } };
    const { unmount } = render(<LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch initialStatus={{ ...ready, jobs: [
      rejected, { ...base, id: "n", phase: "failed" as const, failure: { code: "network" as const, message: "" } }] }} />);
    // The helper is installed, so the section itself shows no setup command: the failure brings it.
    expect(screen.queryByTestId("local-setup-command")).toBeNull();
    const failed = screen.getAllByTestId("local-job-failed");
    const request = failed.find(item => within(item).getByTestId("failure-title").textContent === "Request rejected")!;
    expect(within(request).getByTestId("failure-hint").textContent).toBe("Update the helper with the setup command, then try again.");
    expect(within(request).getByTestId("local-job-setup-command").textContent).toMatch(/^curl -fsSL \S+setup\.sh \| bash -s -- --extension-id \S+$/);
    expect(within(request).getByTestId("local-job-setup-command-copy").textContent).toBe("Copy");
    // A failure whose hint names no command shows none.
    expect(screen.getAllByTestId("local-job-setup-command")).toHaveLength(1);
    unmount();
    // While the helper is missing, the section shows the command once: the failure does not repeat it.
    render(<LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch initialStatus={{ ...ready, host: null, jobs: [
      rejected, { ...base, id: "h", phase: "failed" as const, failure: { code: "host_unavailable" as const, message: "" } }] }} />);
    expect(screen.getAllByTestId("local-setup-command")).toHaveLength(1);
    expect(screen.queryByTestId("local-job-setup-command")).toBeNull();
  });

  it("shows a cancelled job as a neutral line, not as a failure", () => {
    const base = { pageUrl: "https://example.com/", tabId: 1, downloadedBytes: null, totalBytes: null, speedBytesPerSec: null, etaSeconds: null, filename: null };
    render(<LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch initialStatus={{ ...ready, jobs: [
      { ...base, id: "x", phase: "failed", percent: null, failure: { code: "cancelled", message: "cancelled" } }] }} />);
    expect(screen.getByTestId("local-job-cancelled").textContent).toBe("Cancelled");
    expect(screen.queryByTestId("local-job-failed")).toBeNull();
  });

  it("announces a job that ends while the popup is open, once, and stays silent about one that had ended before", async () => {
    let listener!: (msg: unknown, sender?: unknown) => void;
    vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation(((fn: typeof listener) => { listener = fn; }) as never);
    const base = { pageUrl: "https://example.com/", tabId: 1, downloadedBytes: null, totalBytes: null, speedBytesPerSec: null, etaSeconds: null, percent: null };
    const earlier = { ...base, id: "old", phase: "failed" as const, filename: null, failure: { code: "network" as const, message: "" } };
    render(<AnnouncerProvider><LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch initialStatus={{ ...ready, jobs: [earlier] }} /></AnnouncerProvider>);
    expect(screen.getByTestId("announce-alert").textContent).toBe("");
    expect(screen.getByTestId("announce-polite").textContent).toBe("");
    act(() => listener({ type: "local-job", job: { ...base, id: "new", phase: "failed", filename: null, failure: { code: "login_required", message: "" } } }));
    await waitFor(() => expect(screen.getByTestId("announce-alert").textContent).toBe(
      "Sign-in needed. The site wants a signed-in session for this video. Under Cookies, choose the browser you are signed in with, then try again."));
    act(() => listener({ type: "local-job", job: { ...base, id: "done", phase: "complete", filename: "clip.mp4", failure: null } }));
    await waitFor(() => expect(screen.getByTestId("announce-polite").textContent).toBe("Saved to Downloads: clip.mp4"));
  });

  it("says nothing about a job of another tab or page: job updates reach every open view, and the list shows only this page's jobs", async () => {
    let listener!: (msg: unknown, sender?: unknown) => void;
    vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation(((fn: typeof listener) => { listener = fn; }) as never);
    const base = { pageUrl: "https://example.com/", tabId: 1, downloadedBytes: null, totalBytes: null, speedBytesPerSec: null, etaSeconds: null, percent: null };
    render(<AnnouncerProvider><LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch initialStatus={ready} /></AnnouncerProvider>);
    act(() => listener({ type: "local-job", job: { ...base, tabId: 2, id: "other-tab", phase: "failed", filename: null, failure: { code: "network", message: "" } } }));
    act(() => listener({ type: "local-job", job: { ...base, pageUrl: "https://example.com/earlier", id: "other-page", phase: "complete", filename: "old.mp4", failure: null } }));
    // Something of this page is said afterwards: the two before it never reached a live region.
    act(() => listener({ type: "local-job", job: { ...base, id: "mine", phase: "complete", filename: "clip.mp4", failure: null } }));
    await waitFor(() => expect(screen.getByTestId("announce-polite").textContent).toBe("Saved to Downloads: clip.mp4"));
    expect(screen.getByTestId("announce-alert").textContent).toBe("");
    expect(screen.queryByTestId("local-job-failed")).toBeNull();
    expect(screen.getAllByTestId("local-job-complete")).toHaveLength(1);
  });
});

describe("the words for a Local downloader failure", () => {
  it.each(LOCAL_FAILURE_CODES)("%s is plain, names the right tool and keeps the code under Technical details", code => {
    const message = localFailureMessage({ code, message: "" });
    const text = `${message.title}\n${message.body}\n${message.hint ?? ""}`;
    expect(message.title.length).toBeGreaterThan(0);
    expect(message.title.length).toBeLessThanOrEqual(60);
    expect(message.body.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/HTTP|\b[1-5]\d\d\b|SaveMedia|Chrome|local downloader|\bhost\b|packages\/|[\u2013\u2014]|!|[a-z]+_[a-z]+/);
    expect(text).not.toMatch(/\b(?:VPN|proxy|another DNS)\b/i);
    expect(message.details).toEqual([{ label: "Error code", value: code }]);
    expect(message.action).toBeNull();
    expect(message.tone).toBe(code === "drm_protected" ? "protected" : code === "cancelled" ? "neutral" : "unavailable");
  });

  it("explains an HTTP status in plain words and keeps the number and yt-dlp's line as technical details", () => {
    const line = "ERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden (caused by https://cdn.example/v/clip.mp4?token=secret)";
    const titles: Record<number, string> = { 401: "The site refused yt-dlp", 403: "The site refused yt-dlp", 407: "Proxy sign-in needed", 404: "The video is no longer available",
      410: "The video is no longer available", 429: "The site asked yt-dlp to slow down", 451: "Blocked for legal reasons", 503: "The server is busy",
      522: "The server is busy", 418: "The site refused the request" };
    for (const [status, title] of Object.entries(titles)) {
      const message = localFailureMessage({ code: "unknown", message: line, httpStatus: Number(status) });
      expect(message.title).toBe(title);
      expect(`${message.title}${message.body}${message.hint ?? ""}`).not.toMatch(/\d{3}|ERROR|HTTP/);
      expect(message.details[0]).toEqual({ label: "HTTP status", value: status });
      // An address in yt-dlp's line is reduced to its host: a path or a token is never shown.
      expect(message.details[1]).toEqual({ label: "Helper said",
        value: "ERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden (caused by cdn.example" });
    }
    // A proxy that wants a sign-in is the user's own: the site is not blamed, and no cookie choice is suggested.
    expect(localFailureMessage({ code: "unknown", message: line, httpStatus: 407 })).toMatchObject({ body: "Your proxy asked yt-dlp to sign in.",
      hint: "Check your proxy settings." });
    expect(localFailureMessage({ code: "unknown", message: line, httpStatus: 403 }).hint).toMatch(/^Under Cookies/);
    const plain = localFailureMessage({ code: "unknown", message: "ERROR: Sign in to confirm your age" });
    expect(plain.title).toBe("yt-dlp could not save this page");
    expect(plain.title + plain.body).not.toContain("Sign in");
    expect(plain.details).toEqual([{ label: "Helper said", value: "ERROR: Sign in to confirm your age" }, { label: "Error code", value: "unknown" }]);
  });

  it("uses one name for the helper, the feature and the tools", () => {
    expect(localFailureMessage({ code: "host_unavailable", message: "" })).toMatchObject({ title: "Helper not reachable",
      body: "savemedia could not start the savemedia helper.", hint: "Install it with the command under Local downloader, then reopen this popup." });
    expect(localFailureMessage({ code: "geo_restricted", message: "" }).hint).toBeNull();
    // A line the browser gave when the helper could not be started is named as the browser's.
    expect(localFailureMessage({ code: "host_unavailable", message: "Specified native messaging host not found." }).details[0])
      .toEqual({ label: "Browser said", value: "Specified native messaging host not found." });
    expect(LOCAL.title).toBe("Local downloader");
    expect(LOCAL.enable).toBe("Use yt-dlp");
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

  it("clears the busy state when a downloader request loses its runtime", () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementationOnce(() => { throw new Error("Extension context invalidated"); });
    render(<LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch initialStatus={ready} />);
    const button = screen.getByTestId("local-download-page") as HTMLButtonElement;
    fireEvent.click(button);
    expect(screen.getByTestId("local-lost-contact").textContent).toBe("savemedia lost contact with the Local downloader. Close and reopen this popup.");
    expect(screen.queryByRole("status")).toBeNull();
    expect(button.disabled).toBe(false);
  });

  it("offers the brew command when tools are missing", () => {
    render(<LocalDownloader tabId={1} pageUrl="https://example.com/" skipFetch initialStatus={{ ...ready, host: { ...ready.host, ffmpeg: { found: false, version: null, path: null } } }} />);
    expect(screen.getByTestId("local-status-pill").textContent).toBe("Tools missing");
    expect(screen.getByTestId("local-brew-command").textContent).toBe("brew install ffmpeg");
  });
});
