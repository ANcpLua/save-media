import { describe, it, expect, vi } from "vitest";
import { render, screen, act, fireEvent, waitFor, within } from "@testing-library/react";
import { App } from "../../../src/popup/App";
import { CONSCIENCE_LINE, SITE_TEXTS, WAITING_HINTS } from "../../../src/ui/text";
import { directDescriptor, drmDescriptor, hlsDescriptor } from "./helpers/descriptors";
import type { BackgroundToPopupMessage, DescriptorsMessage, DiscoveryFailure } from "../../../src/types/messages";
import type { PageFileState, SelectionView } from "../../../src/types/page-facts";
import type { StreamDescriptor, StreamId } from "@savemedia/core";

/** A popup for a tab on `page`: the background answers with the tab's view, the page's own state included. */
function popupFor(pageState: PageFileState | null, descriptors: readonly StreamDescriptor[], failures: readonly DiscoveryFailure[] = [],
  extra: Partial<DescriptorsMessage> = {}): void {
  const page = "https://example.com/page";
  vi.mocked(chrome.tabs.query).mockImplementation(((_query: unknown, cb: (tabs: { id: number; url: string }[]) => void) =>
    cb([{ id: 1, url: page }])) as never);
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(((msg: { type: string }, cb?: (response: unknown) => void) => {
    if (msg.type === "list" || msg.type === "rescan") cb?.({ type: "descriptors", tabId: 1, descriptors, failures, page: pageState, ...extra });
    else if (msg.type === "current-save-state") cb?.({ saved: false, recovery: null });
    else cb?.(undefined);
  }) as never);
}

const view = (state: SelectionView["state"], cards: SelectionView["cards"] = [], over: Partial<SelectionView> = {}): SelectionView =>
  ({ state, mainId: cards[0]?.ids[0] ?? null, elementMain: false, mainName: null, cards, ...over });

describe("popup App", () => {
  it("shows the named file as the file row and keeps everything else the page loaded listed below it", () => {
    const url = "https://cdn.example/other.mov";
    const offered = directDescriptor({ id: "offered" as StreamId, title: "Clip 31.mov", source: { kind: "direct-url", url: "https://example.com/get/31", headers: {} } });
    popupFor({ title: "Clip", fileDownload: { filename: "Clip 31.mov", url: "https://example.com/get/31" }, fileSaveProblem: null },
      [offered, directDescriptor({ title: "Preview clip" }), { ...drmDescriptor(), title: "Protected trailer" }],
      [{ url, error: { code: "server_busy", severity: "terminal", phase: "direct", url, httpStatus: 503 } }]);
    render(<App />);
    // The declared file is the file row, once: its own card is not listed a second time.
    expect(screen.getAllByText("Clip 31.mov")).toHaveLength(1);
    expect(within(screen.getByTestId("file-card")).getByRole("button", { name: "Save" })).toBeTruthy();
    // A declared file never hides what the page loaded: it is listed, collapsed, under the file row.
    const other = screen.getByTestId("other-media");
    expect(within(other).getByText("Other media (2)")).toBeTruthy();
    expect((other as HTMLDetailsElement).open).toBe(false);
    expect(within(other).getByText("Preview clip")).toBeTruthy();
    expect(within(other).getByTestId("drm-card").textContent).toContain("Protected trailer");
    // Neither does it hide what else failed on the page.
    const unavailable = screen.getByTestId("unavailable-sources");
    expect(within(unavailable).getByText("Unavailable sources (1)")).toBeTruthy();
    expect((unavailable as HTMLDetailsElement).open).toBe(false);
    expect(within(unavailable).getByTestId("failure-title").textContent).toBe("The server is busy");
    // The toolbar badge is the one count: the footer states none.
    expect(document.body.textContent).not.toMatch(/\d+ detected/);
  });

  it("lists what the page's ad responses named last and apart, as ads that are not counted and can still be saved", async () => {
    const content = hlsDescriptor({ id: "content" as StreamId, title: "Feature" });
    const creative = directDescriptor({ id: "creative" as StreamId, title: null, unchecked: true,
      source: { kind: "direct-url", url: "https://ads.example/spot.mp4", headers: { "content-type": "video/mp4" } } });
    // An ad playlist that was never read: it has no qualities yet, and is no refusal.
    const asset = hlsDescriptor({ id: "asset" as StreamId, title: null, unchecked: true, variants: [],
      source: { kind: "hls-manifest", manifestUrl: "https://ads.example/asset/media.m3u8", type: "master" } });
    popupFor({ title: "Page" }, [content, creative, asset], [], { selection: view("ready", [{ ids: ["content"], live: false }],
      { elementMain: true, ads: [{ ids: ["creative"], live: false }, { ids: ["asset"], live: false }] }) });
    render(<App />);
    const ads = screen.getByTestId("ads") as HTMLDetailsElement;
    expect(within(ads).getByText("Ads (2)")).toBeTruthy();
    expect(ads.open).toBe(false);
    // The main card is the page's video, and the ads come after everything else in the list.
    expect(screen.getAllByTestId("main-badge")).toHaveLength(1);
    expect(within(ads).queryByTestId("main-badge")).toBeNull();
    expect(within(ads).getAllByTestId("ad-badge").map(badge => badge.textContent)).toEqual(["Ad", "Ad"]);
    const list = screen.getByTestId("media-list");
    expect(list.querySelector("[data-main]")!.compareDocumentPosition(ads) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Each ad has its own Save, and none is said to be unsupported before it was ever looked at.
    expect(within(ads).getAllByRole("button", { name: "Save" })).toHaveLength(2);
    expect(within(ads).queryByTestId("unsupported-card")).toBeNull();
    // The count that is announced is the page's media: the ads are left out.
    await waitFor(() => expect(screen.getByTestId("announce-polite").textContent).toBe("Found 1 item."));

    // Saving an ad is the user's own request: the card asks for exactly that row.
    const sent = vi.mocked(chrome.runtime.sendMessage);
    sent.mockClear();
    fireEvent.click(within(ads).getAllByRole("button", { name: "Save" })[1]!);
    expect(sent.mock.calls.map(call => call[0])).toContainEqual({ type: "download", streamId: "asset",
      choice: { outputMode: "Original", filename: expect.any(String), variantId: null, audioRenditionId: null } });
    fireEvent.click(within(ads).getAllByRole("button", { name: "Save" })[0]!);
    expect(sent.mock.calls.map(call => (call[0] as { streamId?: string }).streamId)).toContain("creative");
  });

  it("shows an ad that is all the page has loaded under the hint that an ad is playing, never as the page's video", () => {
    const creative = directDescriptor({ id: "creative" as StreamId, title: null, unchecked: true });
    popupFor({ title: "Page" }, [creative], [], { selection: view("ad-playing", [], { ads: [{ ids: ["creative"], live: false }] }) });
    render(<App />);
    expect(screen.getByTestId("page-hint").textContent).toBe("An ad is playing. Try again when the video starts.");
    expect(within(screen.getByTestId("ads")).getByText("Ads (1)")).toBeTruthy();
    expect(screen.queryByTestId("main-badge")).toBeNull();
    expect(screen.queryByTestId("other-media")).toBeNull();
    // Every Save on the page is inside the ads group.
    expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(1);
    expect(within(screen.getByTestId("ads")).getAllByRole("button", { name: "Save" })).toHaveLength(1);
  });

  it("never says that no media was detected above a list of ads the browser loaded", async () => {
    // A player fed through MediaSource whose only loaded stream an ad response named: nothing is the page's own video,
    // nothing is waiting, and the stream is listed under Ads with its own Save.
    const creative = directDescriptor({ id: "creative" as StreamId, title: null, unchecked: true });
    popupFor({ title: "Page" }, [creative], [], { selection: view("no-media", [], { ads: [{ ids: ["creative"], live: false }] }) });
    render(<App />);
    expect(screen.getByTestId("page-only-ads").textContent).toBe("savemedia found only ads on this page. They are listed under Ads.");
    expect(screen.queryByTestId("page-empty")).toBeNull();
    expect(screen.queryByTestId("page-empty-hint")).toBeNull();
    expect(screen.queryByText("No media detected on this page.")).toBeNull();
    expect(within(screen.getByTestId("ads")).getByText("Ads (1)")).toBeTruthy();
    expect(within(screen.getByTestId("ads")).getAllByRole("button", { name: "Save" })).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId("announce-polite").textContent).toBe("savemedia found only ads on this page. They are listed under Ads."));
  });

  it("still says that no media was detected on a page with nothing listed at all", async () => {
    popupFor({ title: "Page" }, [], [], { selection: view("no-media", []) });
    render(<App />);
    expect(screen.getByTestId("page-empty").textContent).toBe("No media detected on this page.");
    expect(screen.queryByTestId("page-only-ads")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("announce-polite").textContent).toBe("No media detected on this page."));
  });

  it("leaves the failure of the named file itself to the file row", () => {
    const url = "https://example.com/get/31";
    popupFor({ title: "Clip", fileDownload: { filename: "Clip 31.mov", url },
      fileSaveProblem: { filename: "Clip 31.mov", stage: "checking", error: { code: "tls_certificate_rejected", severity: "terminal", phase: "direct",
        browserDiagnostic: { host: "example.com", code: "net::ERR_CERT_AUTHORITY_INVALID", ip: null, finalHost: null, redirect: null } } } },
      [], [{ url, error: { code: "tls_certificate_rejected", severity: "terminal", phase: "direct",
        browserDiagnostic: { host: "example.com", code: "net::ERR_CERT_AUTHORITY_INVALID", ip: null, finalHost: null, redirect: null } } }]);
    render(<App />);
    expect(screen.queryByTestId("unavailable-sources")).toBeNull();
    const problem = screen.getByTestId("file-save-problem");
    // The same explanation as on any other page: a possible network filter, never "wait and try again".
    expect(within(problem).getByTestId("failure-title").textContent).toBe("Secure connection not trusted");
    expect(within(problem).getByTestId("failure-hint").textContent).toBe("Check your network filter or security software, or the secure DNS setting in your browser's settings.");
    expect(problem.textContent).not.toMatch(/File server unavailable|when the connection is available/);
    const values = [...problem.querySelectorAll("dd")].map(node => node.textContent);
    expect(values).toEqual(["example.com", "net::ERR_CERT_AUTHORITY_INVALID", "File", "tls_certificate_rejected"]);
    expect(within(screen.getByTestId("file-card")).getByRole("button", { name: "Retry save" })).toBeTruthy();
  });

  it("says a named file was saved earlier, and that another copy is the user's choice already", () => {
    const offer = { filename: "Clip 31.mov", url: "https://example.com/get/31" };
    const page = "https://example.com/page";
    vi.mocked(chrome.tabs.query).mockImplementation(((_query: unknown, cb: (tabs: { id: number; url: string }[]) => void) => cb([{ id: 1, url: page }])) as never);
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((msg: { type: string }, cb?: (response: unknown) => void) => {
      if (msg.type === "list" || msg.type === "rescan") cb?.({ type: "descriptors", tabId: 1, descriptors: [], page: { title: "Clip", fileDownload: offer, fileSaveProblem: null } });
      else if (msg.type === "current-save-state") cb?.({ prompt: null, saved: true, recovery: null });
      else cb?.(undefined);
    }) as never);
    render(<App />);
    expect(screen.getByTestId("saved-earlier").textContent).toBe("Saved earlier in this browser session");
    fireEvent.click(within(screen.getByTestId("file-card")).getByRole("button", { name: "Save another copy" }));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "download-page", tabId: 1, pageUrl: page, allowRepeat: true }, expect.any(Function));
  });

  it("shows the size of a named file next to its name when it is known", () => {
    const offered = directDescriptor({ id: "offered" as StreamId, title: "Clip 31.mov",
      source: { kind: "direct-url", url: "https://example.com/get/31", headers: { "content-length": String(12 * 1024 ** 2) } } });
    popupFor({ title: "Clip", fileDownload: { filename: "Clip 31.mov", url: "https://example.com/get/31" }, fileSaveProblem: null }, [offered], [],
      { selection: view("ready", [{ ids: ["offered"], live: false }]) });
    render(<App />);
    expect(within(screen.getByTestId("file-card")).getByTestId("expected-size").textContent).toBe(" · 12.0 MB");
  });

  it("says in plain words what the page has not handed over yet, never pointing at a site's button", () => {
    for (const state of ["file-not-received", "not-loaded-yet", "ad-playing", "ambiguous"] as const) {
      popupFor({ title: "Clip", ...(state === "file-not-received" ? { namedFile: "Clip 31.mov" } : {}), fileSaveProblem: null }, [], [], { selection: view(state) });
      const { unmount } = render(<App />);
      expect(screen.getByTestId("page-hint").textContent).toBe(WAITING_HINTS[state]);
      expect(screen.queryByText("No media detected on this page.")).toBeNull();
      expect(document.body.textContent).not.toMatch(/button|site's own|download link/i);
      unmount();
    }
    // The sentences themselves, so a change of wording is a change someone decided.
    expect(WAITING_HINTS["file-not-received"]).toBe("This file has not reached your browser yet. savemedia saves it once your browser receives it.");
    expect(WAITING_HINTS["not-loaded-yet"]).toBe("The page has not loaded the video yet. Start playback, then try again.");
  });

  it("takes the main card, the Main badge and the order of the cards from the background's selection", () => {
    const first = directDescriptor({ id: "a" as StreamId, title: "Sidebar teaser" });
    const second = directDescriptor({ id: "b" as StreamId, title: "Main feature", source: { kind: "direct-url", url: "https://example.com/b.mp4", headers: {} } });
    popupFor({ title: "Page" }, [first, second], [], { selection: view("ready", [{ ids: ["b"], live: false }, { ids: ["a"], live: false }], { elementMain: true }) });
    const { unmount } = render(<App />);
    const titles = screen.getAllByTitle(/Sidebar teaser|Main feature/).map(node => node.textContent);
    expect(titles).toEqual(["Main feature", "Sidebar teaser"]);
    expect(screen.getAllByTestId("main-badge")).toHaveLength(1);
    expect(screen.getByTestId("main-badge").closest("li")?.textContent).toContain("Main feature");
    expect(screen.getByText("Other media (1)")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\d+ detected/);
    unmount();
    // The main video was not chosen through an element: no badge claims it was.
    popupFor({ title: "Page" }, [first, second], [], { selection: view("ready", [{ ids: ["b"], live: false }, { ids: ["a"], live: false }]) });
    render(<App />);
    expect(screen.queryByTestId("main-badge")).toBeNull();
  });

  it("labels a live stream and offers no Save for it", () => {
    const live = hlsDescriptor({ id: "live" as StreamId, title: "Live channel" });
    popupFor({ title: "Page" }, [live], [], { selection: view("live", [{ ids: ["live"], live: true }]) });
    render(<App />);
    expect(screen.getByTestId("live-badge").textContent).toBe("Live");
    expect(screen.getByTestId("live-card")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("shows the page's name for the main file when the server gave it none", () => {
    const file = directDescriptor({ id: "file" as StreamId, title: "signed-movie.mov" });
    popupFor({ title: "Test pattern", namedFile: "Test pattern 31.mov" }, [file], [],
      { selection: view("ready", [{ ids: ["file"], live: false }], { mainName: "Test pattern 31.mov" }) });
    render(<App />);
    expect(screen.getByText("Test pattern 31.mov")).toBeTruthy();
    expect(screen.queryByText("signed-movie.mov")).toBeNull();
  });

  it("never calls a preview by the name of the file the page names, and says that the named file has not arrived", () => {
    // The page's title and heading name a Matroska file. What the browser received is a short MP4 preview.
    const preview = directDescriptor({ id: "preview" as StreamId, title: null });
    popupFor({ title: "Holiday.Trip.2024.1080p.mkv", namedFile: "Holiday.Trip.2024.1080p.mkv" }, [preview], [],
      { selection: view("ready", [{ ids: ["preview"], live: false }], { elementMain: true, namedPending: "Holiday.Trip.2024.1080p.mkv" }) });
    render(<App />);
    expect(screen.getByTestId("named-file-pending").textContent).toBe("The file this page names (Holiday.Trip.2024.1080p.mkv) has not reached your browser yet. "
      + "What is listed here is what your browser did receive. savemedia saves the named file once your browser receives it.");
    // The card is still there with its Save, and its title is not the named file.
    const card = screen.getByTestId("media-list").querySelector("[data-main]")!;
    expect(within(card as HTMLElement).getByRole("button", { name: "Save" })).toBeTruthy();
    expect(card.textContent).not.toContain("Holiday.Trip.2024.1080p.mkv");
  });

  it("says nothing about a named file on a page whose file is the one it names", () => {
    const file = directDescriptor({ id: "file" as StreamId, title: null });
    popupFor({ title: "Test pattern", namedFile: "Test pattern 31.mov" }, [file], [],
      { selection: view("ready", [{ ids: ["file"], live: false }], { mainName: "Test pattern 31.mov" }) });
    render(<App />);
    expect(screen.queryByTestId("named-file-pending")).toBeNull();
  });

  it("never talks to the page itself: everything it shows comes from the background", () => {
    popupFor({ title: "Page" }, [directDescriptor()]);
    render(<App />);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("automatically scans on open and ignores a stale list response after discovery", () => {
    let listReply: ((response: unknown) => void) | undefined;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((msg: { type: string }, cb?: (response: unknown) => void) => {
      if (msg.type === "list") listReply = cb;
      if (msg.type === "rescan") cb?.({ type: "descriptors", tabId: 1, descriptors: [directDescriptor({ title: "Discovered quality" })] });
    }) as never);
    render(<App />);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "rescan", tabId: 1 }, expect.any(Function));
    expect(screen.getByText("Discovered quality")).toBeTruthy();
    act(() => listReply?.({ type: "descriptors", tabId: 1, descriptors: [] }));
    expect(screen.getByText("Discovered quality")).toBeTruthy();
  });
  it("shows a discovery failure and lets the user check the page again", () => {
    const url = "https://cdn.example/stream?secret=private-token";
    let scans = 0;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      ((msg: { type?: string }, cb?: (resp: BackgroundToPopupMessage | undefined) => void) => {
        if (msg.type === "list") cb?.({ type: "descriptors", tabId: 1, descriptors: [], failures: [{ url,
          error: { code: "server_busy", severity: "terminal", phase: "direct", url, httpStatus: 503 },
        }] });
        else if (msg.type === "rescan") {
          scans += 1;
          cb?.(scans === 1
            ? { type: "descriptors", tabId: 1, descriptors: [], failures: [{ url, error: { code: "server_busy", severity: "terminal", phase: "direct", url, httpStatus: 503 } }] }
            : { type: "descriptors", tabId: 1, descriptors: [directDescriptor()], failures: [] });
        }
        else cb?.(undefined);
      }) as never,
    );
    render(<App />);
    const failure = screen.getByTestId("discovery-failure");
    expect(within(failure).getByTestId("failure-title").textContent).toBe("The server is busy");
    expect(within(failure).getByTestId("failure-body").textContent).toBe("The video server is not responding properly right now.");
    expect(within(failure).getByTestId("failure-hint").textContent).toBe("Try again in a few minutes.");
    expect(screen.queryByText(/no media detected/i)).toBeNull();
    // The server, the status and the code sit in rows behind the disclosure, each in an element of its own.
    const rows = [...failure.querySelectorAll("dt")].map((label, index) => [label.textContent, failure.querySelectorAll("dd")[index]!.textContent]);
    expect(rows).toEqual([["HTTP status", "503"], ["Server", "cdn.example"], ["Request", "File"], ["Error code", "server_busy"]]);
    expect(failure.querySelector("details")!.open).toBe(false);
    const visible = failure.cloneNode(true) as HTMLElement;
    visible.querySelector("details")!.remove();
    expect(visible.textContent).not.toMatch(/503|server_busy|cdn\.example/);
    expect(document.body.textContent).not.toContain("private-token");
    fireEvent.click(screen.getByRole("button", { name: "Check page again" }));
    // The user asked again: what failed is checked again too.
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "rescan", tabId: 1, retryFailed: true }, expect.any(Function));
    expect(screen.queryByText(/server is busy/i)).toBeNull();
    expect(screen.getByText(/clip name/i)).toBeTruthy();
  });

  it("restores an engine failure when the popup is reopened", () => {
    const descriptor = directDescriptor();
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      ((msg: { type?: string }, cb?: (resp: BackgroundToPopupMessage | undefined) => void) => {
        if (msg.type === "list") cb?.({ type: "descriptors", tabId: 1, descriptors: [descriptor], statuses: {
          [descriptor.id]: { phase: "failed", error: { code: "server_busy", severity: "terminal", phase: "direct", url: "https://cdn.example/clip.mp4", httpStatus: 503 } },
        } });
        else cb?.(undefined);
      }) as never,
    );
    const first = render(<App />);
    expect(screen.getByTestId("job-error").textContent).toMatch(/server is busy/i);
    first.unmount();
    render(<App />);
    expect(screen.getByTestId("job-error").textContent).toMatch(/server is busy/i);
  });

  it("keeps other source failures collapsed when a file is saved", () => {
    const descriptor = directDescriptor();
    const url = "https://cdn.example/other.mov";
    render(<App
      skipFetch
      initialDescriptors={[descriptor]}
      initialStatuses={{ [descriptor.id]: { phase: "complete" } }}
      initialFailures={[{
        url,
        error: { code: "network_unreachable", severity: "terminal", phase: "direct", url, during: "request",
          browserDiagnostic: { code: "net::ERR_CERT_AUTHORITY_INVALID", host: "cdn.example", ip: null, finalHost: null, redirect: null } },
      }]}
    />);
    expect(screen.getByTestId("job-complete").textContent).toContain("Saved to Downloads");
    expect(screen.getByText("Unavailable sources (1)").closest("details")?.open).toBe(false);
    for (const details of screen.getAllByTestId("technical-details")) expect((details as HTMLDetailsElement).open).toBe(false);
  });

  it("lists no failure for an address that a running or finished save already stands for, however the address is written", () => {
    // An earlier check of the link failed; the file is saved now. The link's parameters are in another order and it
    // was answered from another server: both are the same file as the failure's address.
    const descriptor = directDescriptor({ source: { kind: "direct-url", url: "https://example.com/get/31?b=2&a=1",
      finalUrl: "https://cdn.example/files/31.mov", headers: {} } });
    const failure = (url: string) => ({ url, error: { code: "server_busy", severity: "terminal", phase: "direct", url, httpStatus: 503 } as const });
    const { unmount } = render(<App skipFetch initialDescriptors={[descriptor]} initialStatuses={{ [descriptor.id]: { phase: "complete" } }}
      initialFailures={[failure("https://example.com/get/31?a=1&b=2"), failure("https://cdn.example/files/31.mov#t=1")]} />);
    expect(screen.queryByTestId("unavailable-sources")).toBeNull();
    unmount();
    // Another file's failure stays listed, and so does this one's while nothing is saved.
    render(<App skipFetch initialDescriptors={[descriptor]} initialStatuses={{ [descriptor.id]: { phase: "complete" } }}
      initialFailures={[failure("https://example.com/get/32?a=1&b=2")]} />);
    expect(screen.getByText("Unavailable sources (1)")).toBeTruthy();
  });

  // A player that has not started, whose page data names a playlist the server no longer answers.
  it("leads with 'start playback' when a source the page only names failed, and lists that failure closed below it", () => {
    const url = "https://proxy.example/stale/master.m3u8";
    popupFor({ title: "Clip" }, [], [{ url, error: { code: "server_busy", severity: "terminal", phase: "manifest", url, httpStatus: 522 } }],
      { selection: view("not-loaded-yet") });
    render(<App />);
    expect(screen.getByTestId("page-hint").textContent).toBe(WAITING_HINTS["not-loaded-yet"]);
    const unavailable = screen.getByTestId("unavailable-sources");
    expect(within(unavailable).getByText("Unavailable sources (1)")).toBeTruthy();
    expect((unavailable as HTMLDetailsElement).open).toBe(false);
    expect(within(unavailable).getByTestId("failure-title").textContent).toBe("The server is busy");
    expect(screen.queryByTestId("page-empty")).toBeNull();
  });

  it("shows a failure that is the page's answer open, as before", () => {
    const url = "https://cdn.example/clip.mp4";
    popupFor({ title: "Clip" }, [], [{ url, error: { code: "server_busy", severity: "terminal", phase: "direct", url, httpStatus: 503 } }],
      { selection: view("failed") });
    render(<App />);
    expect(screen.queryByTestId("unavailable-sources")).toBeNull();
    expect(screen.queryByTestId("page-hint")).toBeNull();
    expect(screen.getByTestId("failure-title").textContent).toBe("The server is busy");
  });

  it("says why nothing is offered on a site that is read by a site reader alone, without advice to start playback", () => {
    for (const state of ["site-not-saved", "reader-found-nothing"] as const) {
      popupFor({ title: "Watch" }, [], [], { selection: view(state) });
      const { unmount } = render(<App />);
      expect(screen.getByTestId("page-hint").textContent).toBe(SITE_TEXTS[state]);
      expect(screen.queryByTestId("page-empty")).toBeNull();
      expect(screen.queryByTestId("page-empty-hint")).toBeNull();
      expect(document.body.textContent).not.toMatch(/start (it|playback)|No media detected/i);
      unmount();
    }
    expect(SITE_TEXTS["site-not-saved"]).toBe("savemedia does not save videos from this site.");
    expect(SITE_TEXTS["reader-found-nothing"]).toBe("savemedia found no file it can save in this page's player data.");
  });

  describe("the header's shortcut line", () => {
    const withShortcut = (shortcut: string | undefined, name = "download-best"): void => {
      Object.assign(chrome, { commands: { getAll: vi.fn((cb: (commands: { name: string; shortcut?: string }[]) => void) =>
        cb([{ name: "_execute_action", shortcut: "" }, { name, ...(shortcut === undefined ? {} : { shortcut }) }])) },
        tabs: { ...chrome.tabs, create: vi.fn(async () => ({})) } });
    };

    it("names Alt+S while the command is bound to it, as the browser writes it on any system", () => {
      for (const shortcut of ["Alt+S", "⌥S"]) {
        withShortcut(shortcut);
        const { unmount } = render(<App skipFetch />);
        expect(screen.getByTestId("shortcut-hint").textContent).toBe("Alt+S saves the video or image under the pointer, or this page's main video.");
        expect(screen.queryByTestId("shortcut-missing")).toBeNull();
        unmount();
      }
    });

    it("names the shortcut the user chose instead", () => {
      withShortcut("Ctrl+Shift+Y");
      render(<App skipFetch />);
      expect(screen.getByTestId("shortcut-hint").textContent).toBe("Ctrl+Shift+Y saves the video or image under the pointer, or this page's main video.");
    });

    // Another copy of the extension, or another extension, holds Alt+S: the browser leaves this command without a key.
    it("says that no shortcut is set instead of promising Alt+S, and opens the browser's shortcut page", () => {
      for (const shortcut of ["", undefined]) {
        withShortcut(shortcut);
        const { unmount } = render(<App skipFetch />);
        expect(screen.getByTestId("shortcut-missing").textContent).toBe("No keyboard shortcut is set, so Alt+S does nothing. Set shortcut");
        expect(screen.queryByTestId("shortcut-hint")).toBeNull();
        expect(document.body.textContent).not.toContain("Alt+S saves");
        fireEvent.click(screen.getByTestId("set-shortcut"));
        expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "chrome://extensions/shortcuts" });
        unmount();
      }
    });

    it("reads the shortcut again when the window gets the focus back, and keeps the manifest's shortcut where the browser reports none", () => {
      withShortcut("");
      render(<App skipFetch />);
      expect(screen.getByTestId("shortcut-missing")).toBeTruthy();
      withShortcut("Alt+S");
      act(() => { window.dispatchEvent(new Event("focus")); });
      expect(screen.getByTestId("shortcut-hint").textContent).toContain("Alt+S saves");
    });

    it("keeps the manifest's shortcut in a browser that does not report commands", () => {
      render(<App skipFetch />);
      expect(screen.getByTestId("shortcut-hint").textContent).toContain("Alt+S saves");
      withShortcut("Alt+S", "another-command");
      render(<App skipFetch />);
      expect(screen.getAllByTestId("shortcut-hint")).toHaveLength(2);
    });
  });

  it("renders the empty state with what the user can do", () => {
    render(<App skipFetch />);
    expect(screen.getByTestId("page-empty").textContent).toBe("No media detected on this page.");
    expect(screen.getByTestId("page-empty-hint").textContent).toBe("If the page plays a video, start it, then press Check page again.");
    expect(screen.queryByTestId("page-hint")).toBeNull();
  });

  it("says that it is checking the page while the first look runs, instead of showing nothing", () => {
    let finish: ((reply: unknown) => void) | undefined;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((msg: { type: string }, cb?: (response: unknown) => void) => {
      if (msg.type === "list") cb?.({ type: "descriptors", tabId: 1, descriptors: [] });
      else if (msg.type === "rescan") finish = cb;
      else cb?.(undefined);
    }) as never);
    render(<App />);
    expect(screen.getByTestId("page-loading").textContent).toBe("Checking this page…");
    expect(screen.queryByTestId("page-empty")).toBeNull();
    expect(screen.getByTestId("media-list").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("button", { name: "Checking…" })).toBeTruthy();
    // The loading line is not a live region: the result is what gets announced.
    expect(screen.getByTestId("page-loading").closest("[role]")).toBeNull();
    act(() => finish?.({ type: "descriptors", tabId: 1, descriptors: [] }));
    expect(screen.queryByTestId("page-loading")).toBeNull();
    expect(screen.getByTestId("page-empty")).toBeTruthy();
    expect(screen.getByTestId("media-list").getAttribute("aria-busy")).toBe("false");
    expect(screen.getByRole("button", { name: "Check page again" })).toBeTruthy();
  });

  it("appeals to the user's conscience in one static line, once", () => {
    const descriptor = directDescriptor();
    const { container } = render(<App skipFetch initialDescriptors={[descriptor, { ...drmDescriptor(), title: "Protected trailer" }]}
      initialStatuses={{ [descriptor.id]: { phase: "failed", error: { code: "access_denied", severity: "terminal", phase: "direct",
        url: "https://cdn.example/a.mp4", httpStatus: 402, explanation: "payment-or-entitlement" } } }} />);
    expect(CONSCIENCE_LINE).toBe("Save only what you have the right to keep.");
    expect(container.textContent!.split(CONSCIENCE_LINE)).toHaveLength(2);
    const line = screen.getByTestId("conscience-line");
    expect(line.closest("footer")).not.toBeNull();
    expect(line.closest("[role], [aria-live]")).toBeNull();
    // It is not repeated on a refusal or a failure, and nothing lectures the user.
    for (const card of [screen.getByTestId("drm-card"), screen.getByTestId("job-error")]) expect(card.textContent).not.toContain("right to keep");
    expect(container.textContent).not.toMatch(/piracy|illegal|copyright/i);
  });

  it("states the product in lowercase, its version in the footer and no count of items", () => {
    Object.assign(chrome.runtime, { getManifest: () => ({ version: "1.0.5" }) });
    const { container } = render(<App skipFetch initialDescriptors={[directDescriptor()]} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("savemedia");
    expect(screen.getByTestId("version").textContent).toBe("v1.0.5");
    expect(container.textContent).not.toMatch(/SaveMedia|\d+ detected/);
    expect(container.querySelector("header p")!.textContent).toBe("Alt+S saves the video or image under the pointer, or this page's main video.");
    expect(screen.getByRole("button", { name: "Export diagnostic log" })).toBeTruthy();
  });

  it("queries the active tab and asks background for the descriptor list", () => {
    render(<App />);
    expect(globalThis.chrome.tabs.query).toHaveBeenCalled();
    const sent = vi.mocked(globalThis.chrome.runtime.sendMessage).mock.calls.map(c => c[0]);
    expect(sent).toContainEqual({ type: "list", tabId: 1 });
  });

  it("renders the descriptors returned by background", () => {
    vi.mocked(globalThis.chrome.runtime.sendMessage).mockImplementation(
      ((msg: { type?: string }, cb?: (resp: BackgroundToPopupMessage | undefined) => void) => {
        if (msg?.type === "list") cb?.({ type: "descriptors", tabId: 1, descriptors: [directDescriptor()] });
        else cb?.(undefined);
      }) as never,
    );
    render(<App />);
    expect(screen.getByText(/clip name/i)).toBeTruthy();
  });

  it("refreshes descriptors when background broadcasts the active tab list", () => {
    let listener: ((msg: BackgroundToPopupMessage) => void) | null = null;
    vi.mocked(globalThis.chrome.runtime.onMessage.addListener).mockImplementation((fn: unknown) => {
      listener = fn as (msg: BackgroundToPopupMessage) => void;
    });
    render(<App />);
    expect(listener).not.toBeNull();

    act(() => {
      listener!({
        type: "descriptors",
        tabId: 1,
        descriptors: [directDescriptor({ title: "fresh list" })],
      });
    });

    expect(screen.getByText(/fresh list/i)).toBeTruthy();
  });

  it("updates job state when background broadcasts progress/failed/complete messages", () => {
    let listener: ((msg: BackgroundToPopupMessage) => void) | null = null;
    vi.mocked(globalThis.chrome.runtime.onMessage.addListener).mockImplementation((fn: unknown) => {
      listener = fn as (msg: BackgroundToPopupMessage) => void;
    });
    render(<App initialDescriptors={[directDescriptor()]} skipFetch />);
    expect(listener).not.toBeNull();

    act(() => {
      listener!({
        type: "job-progress",
        streamId: directDescriptor().id,
        bytesWritten: 10,
        bytesTotal: 100,
        stage: { kind: "downloading" },
      });
    });
    expect(screen.getByTestId("progress")).toBeTruthy();

    act(() => {
      listener!({
        type: "job-failed",
        streamId: directDescriptor().id,
        error: { code: "http_error", severity: "terminal", phase: "manifest", url: "https://x", httpStatus: 404 },
      });
    });
    expect(screen.getByTestId("job-error")).toBeTruthy();
  });

  describe("what a screen reader is told", () => {
    type Send = (msg: BackgroundToPopupMessage, sender?: { id?: string; tab?: unknown }) => void;
    /** A popup over the given state, with a way to deliver the background's messages to it. */
    function listening(props: Parameters<typeof App>[0]): Send {
      const listeners: ((msg: BackgroundToPopupMessage, sender: unknown, respond: (reply: unknown) => void) => void)[] = [];
      vi.mocked(globalThis.chrome.runtime.onMessage.addListener).mockImplementation((fn: unknown) => { listeners.push(fn as typeof listeners[number]); });
      render(<App {...props} />);
      return (msg, sender = {}) => act(() => { for (const listener of listeners) listener(msg, sender, () => undefined); });
    }
    const polite = () => screen.getByTestId("announce-polite");
    const alert = () => screen.getByTestId("announce-alert");

    it("has exactly one polite region and one alert, both empty when the popup opens over failures that already exist", () => {
      const descriptor = directDescriptor();
      const url = "https://cdn.example/other.mov";
      render(<App skipFetch initialDescriptors={[descriptor, drmDescriptor()]}
        initialStatuses={{ [descriptor.id]: { phase: "failed", error: { code: "server_busy", severity: "terminal", phase: "direct", url, httpStatus: 503 } } }}
        initialFailures={[{ url, error: { code: "unexpected_media_response", severity: "terminal", response: "page" } }]} />);
      expect(screen.getAllByRole("status")).toEqual([polite()]);
      expect(screen.getAllByRole("alert")).toEqual([alert()]);
      expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
      expect(polite().getAttribute("aria-live")).toBe("polite");
      // What is on the page when it opens is rendered, not announced.
      expect(screen.getByTestId("job-error")).toBeTruthy();
      expect(polite().textContent).toBe("");
      expect(alert().textContent).toBe("");
      // Static text is never inside a live region.
      for (const region of [polite(), alert()]) expect(region.children).toHaveLength(0);
    });

    it("announces a failure that happens while the popup is open as an alert: what happened, and what to do", async () => {
      const send = listening({ skipFetch: true, initialDescriptors: [directDescriptor()] });
      send({ type: "job-failed", streamId: directDescriptor().id,
        error: { code: "server_busy", severity: "terminal", phase: "direct", url: "https://cdn.example/a.mp4", httpStatus: 503 } });
      await waitFor(() => expect(alert().textContent).toBe("The server is busy. The video server is not responding properly right now. Try again in a few minutes."));
      expect(polite().textContent).toBe("");
      expect(alert().textContent).not.toMatch(/503|server_busy|cdn\.example/);
    });

    it("announces the stages worth hearing once each, and a finished save politely", async () => {
      const send = listening({ skipFetch: true, initialDescriptors: [directDescriptor()] });
      const id = directDescriptor().id;
      send({ type: "job-progress", streamId: id, bytesWritten: 1, bytesTotal: 100, stage: { kind: "downloading" } });
      send({ type: "job-progress", streamId: id, bytesWritten: 50, bytesTotal: 100, stage: { kind: "downloading" } });
      await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
      // Byte progress moves the bar and says nothing.
      expect(polite().textContent).toBe("");
      send({ type: "job-progress", streamId: id, bytesWritten: 100, bytesTotal: 100, stage: { kind: "verifying" } });
      await waitFor(() => expect(polite().textContent).toBe("Checking the finished file"));
      send({ type: "job-complete", streamId: id, path: "/Users/me/Downloads/clip name.mp4" });
      await waitFor(() => expect(polite().textContent).toBe("Saved to Downloads: clip name.mp4"));
      expect(alert().textContent).toBe("");
    });

    it("says nothing about a save that belongs to another tab", async () => {
      const send = listening({ skipFetch: true, initialDescriptors: [directDescriptor()] });
      send({ type: "job-failed", streamId: "stream-of-another-tab" as StreamId,
        error: { code: "server_busy", severity: "terminal", phase: "direct", url: "https://cdn.example/a.mp4", httpStatus: 503 } });
      send({ type: "job-complete", streamId: "stream-of-another-tab" as StreamId, path: "other.mp4" });
      send({ type: "job-cancelled", streamId: "stream-of-another-tab" as StreamId });
      await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
      expect(alert().textContent).toBe("");
      expect(polite().textContent).toBe("");
    });

    it("treats the user's own cancel as a neutral end: said politely, shown as Cancelled, never as an error", async () => {
      const send = listening({ skipFetch: true, initialDescriptors: [directDescriptor()] });
      const id = directDescriptor().id;
      send({ type: "job-progress", streamId: id, bytesWritten: 1, bytesTotal: 100, stage: { kind: "downloading" } });
      expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
      send({ type: "job-cancelled", streamId: id });
      await waitFor(() => expect(polite().textContent).toBe("Save cancelled"));
      expect(alert().textContent).toBe("");
      expect(screen.queryByTestId("job-error")).toBeNull();
      expect(screen.queryByTestId("progress")).toBeNull();
      expect(screen.getByTestId("job-cancelled").textContent).toBe("Cancelled");
      expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull();
    });

    it("says what a look at the page found, once per look", async () => {
      popupFor({ title: "Page" }, [directDescriptor({ id: "a" as StreamId }), hlsDescriptor({ id: "b" as StreamId })], [],
        { selection: view("ready", [{ ids: ["a"], live: false }, { ids: ["b"], live: false }]) });
      const first = render(<App />);
      await waitFor(() => expect(polite().textContent).toBe("Found 2 items."));
      first.unmount();
      popupFor({ title: "Page" }, [], [], { selection: view("no-media") });
      const second = render(<App />);
      await waitFor(() => expect(polite().textContent).toBe("No media detected on this page."));
      second.unmount();
      popupFor(null, [], [], { reachable: false, reach: "needs-reload" });
      const third = render(<App />);
      await waitFor(() => expect(polite().textContent).toBe("Reload this page so savemedia can see it."));
      third.unmount();
      // Nothing listed because nothing could be checked is not "no media".
      const url = "https://cdn.example/a.mp4";
      popupFor({ title: "Page" }, [], [{ url, error: { code: "server_busy", severity: "terminal", phase: "direct", url, httpStatus: 503 } }],
        { selection: view("failed") });
      render(<App />);
      await waitFor(() => expect(polite().textContent).toBe("1 source could not be checked."));
      // The failure itself was there when the look ended: it is shown, and the alert stays silent.
      expect(alert().textContent).toBe("");
    });

    it("announces a save that starts from the popup and a named file that could not be saved", async () => {
      const offer = { filename: "Clip 31.mov", url: "https://example.com/get/31" };
      const listeners: ((msg: BackgroundToPopupMessage, sender: unknown, respond: (reply: unknown) => void) => void)[] = [];
      vi.mocked(globalThis.chrome.runtime.onMessage.addListener).mockImplementation((fn: unknown) => { listeners.push(fn as typeof listeners[number]); });
      popupFor({ title: "Clip", fileDownload: offer, fileSaveProblem: null }, []);
      render(<App />);
      act(() => { for (const listener of listeners) listener({ type: "file-save-problem", tabId: 1, pageUrl: "https://example.com/page",
        problem: { filename: "Clip 31.mov", stage: "starting", error: null } }, {}, () => undefined); });
      await waitFor(() => expect(alert().textContent).toBe("Couldn't start the save. savemedia couldn't start saving this file. Reload the page and try again."));
      expect(within(screen.getByTestId("file-save-problem")).getByTestId("failure-title").textContent).toBe("Couldn't start the save");
    });
  });

  describe("a page savemedia cannot read", () => {
    it("says to reload a tab that was open before the install, with a button that reloads it and looks again when the load ends", () => {
      popupFor(null, [], [], { reachable: false, reach: "needs-reload" });
      const reload = vi.fn(async () => undefined);
      let onUpdated: ((tabId: number, info: { status?: string }, tab: { url?: string }) => void) | undefined;
      Object.assign(chrome.tabs, { reload, onUpdated: { addListener: vi.fn((fn: typeof onUpdated) => { onUpdated = fn; }), removeListener: vi.fn() } });
      render(<App />);
      expect(screen.getByTestId("page-reach").textContent).toContain("Reload this page so savemedia can see it.");
      expect(screen.getByTestId("page-reach").textContent).toContain("This tab was open before savemedia was installed or updated.");
      expect(screen.queryByText("No media detected on this page.")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Reload page" }));
      expect(reload).toHaveBeenCalledExactlyOnceWith(1);

      // The page loaded again, now with its content script: the list is asked for again and the notice goes.
      popupFor({ title: "Page" }, [directDescriptor({ title: "Found after reload" })], [], { reachable: true, reach: "reachable" });
      const before = vi.mocked(chrome.runtime.sendMessage).mock.calls.length;
      act(() => { onUpdated!(2, { status: "complete" }, { url: "https://other.example/" }); });
      expect(vi.mocked(chrome.runtime.sendMessage).mock.calls.length).toBe(before);
      act(() => { onUpdated!(1, { status: "complete" }, { url: "https://example.com/page" }); });
      expect(screen.queryByTestId("page-reach")).toBeNull();
      expect(screen.getByText("Found after reload")).toBeTruthy();
    });

    it("says a page that did not load did not load, with the same Reload page button, and looks again when the load ends", () => {
      popupFor(null, [], [], { reachable: false, reach: "load-failed" });
      const reload = vi.fn(async () => undefined);
      let onUpdated: ((tabId: number, info: { status?: string }, tab: { url?: string }) => void) | undefined;
      Object.assign(chrome.tabs, { reload, onUpdated: { addListener: vi.fn((fn: typeof onUpdated) => { onUpdated = fn; }), removeListener: vi.fn() } });
      render(<App />);
      expect(screen.getByTestId("page-reach").textContent).toBe(
        "This page did not load. Reload it, then try again.Your browser shows its own error page in this tab.Reload page");
      expect(screen.queryByText("No media detected on this page.")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Reload page" }));
      expect(reload).toHaveBeenCalledExactlyOnceWith(1);
      popupFor({ title: "Page" }, [directDescriptor({ title: "Found after reload" })], [], { reachable: true, reach: "reachable" });
      act(() => { onUpdated!(1, { status: "complete" }, { url: "https://example.com/page" }); });
      expect(screen.queryByTestId("page-reach")).toBeNull();
      expect(screen.getByText("Found after reload")).toBeTruthy();
    });

    it.each([
      ["blocked", "Your browser does not let extensions read this page."],
      ["not-web", "savemedia checks web pages. This page belongs to the browser."],
      ["site-access-off", "savemedia is not allowed on this site."],
      ["file-access-off", "savemedia can't read files on this computer."],
    ] as const)("explains %s in plain words, without a reload button", (reach, text) => {
      popupFor(null, [], [], { reachable: false, reach });
      render(<App />);
      expect(screen.getByTestId("page-reach").textContent).toContain(text);
      expect(screen.queryByRole("button", { name: "Reload page" })).toBeNull();
      expect(screen.queryByText("No media detected on this page.")).toBeNull();
    });

    it("shows what the network capture already found below the notice", () => {
      popupFor(null, [directDescriptor({ title: "Seen on the network" })], [], { reachable: false, reach: "needs-reload" });
      render(<App />);
      expect(screen.getByTestId("page-reach")).toBeTruthy();
      expect(screen.getByText("Seen on the network")).toBeTruthy();
    });

    it("a page that is still loading keeps its own line and no notice box", () => {
      popupFor(null, [], [], { reachable: false, reach: "loading" });
      Object.assign(chrome.tabs, { onUpdated: { addListener: vi.fn(), removeListener: vi.fn() } });
      render(<App />);
      expect(screen.queryByTestId("page-reach")).toBeNull();
      expect(screen.getByTestId("page-hint").textContent).toBe("The page is still loading. Try again when it has loaded.");
    });

    it("shows no notice for a page it can read", () => {
      popupFor({ title: "Page" }, [], [], { reachable: true, reach: "reachable" });
      render(<App />);
      expect(screen.queryByTestId("page-reach")).toBeNull();
      expect(screen.getByText("No media detected on this page.")).toBeTruthy();
    });
  });

  it("keeps the list it shows when a request fails or the background is gone", () => {
    popupFor({ title: "Page" }, [directDescriptor({ title: "Still here" })]);
    render(<App />);
    expect(screen.getByText("Still here")).toBeTruthy();
    // "Check page again" is answered with request-failed, then with nothing, then the extension is gone.
    for (const answer of [(cb?: (reply: unknown) => void) => cb?.({ type: "request-failed" }), (cb?: (reply: unknown) => void) => cb?.(undefined),
      () => { throw new Error("Extension context invalidated."); }]) {
      vi.mocked(chrome.runtime.sendMessage).mockImplementation(((_msg: unknown, cb?: (reply: unknown) => void) => answer(cb)) as never);
      fireEvent.click(screen.getByRole("button", { name: "Check page again" }));
      expect(screen.getByText("Still here")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Check page again" })).toBeTruthy();
    }
  });

  it("tells the background which tab it shows, over a port it keeps open", () => {
    const posted: unknown[] = [];
    const port = { postMessage: vi.fn((message: unknown) => { posted.push(message); }), disconnect: vi.fn(), onDisconnect: { addListener: vi.fn() } };
    vi.mocked(chrome.runtime.connect).mockReturnValue(port as never);
    popupFor({ title: "Page" }, []);
    const { unmount } = render(<App />);
    expect(chrome.runtime.connect).toHaveBeenCalledExactlyOnceWith({ name: "savemedia-view" });
    expect(posted.at(-1)).toEqual({ type: "view", tabId: 1 });
    unmount();
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  describe("Save on the main card", () => {
    const main = directDescriptor({ id: "main" as StreamId, title: "Main feature" });
    const shown = { selection: view("ready", [{ ids: ["main"], live: false }], { elementMain: true }) };
    const requests = (type: string) => vi.mocked(chrome.runtime.sendMessage).mock.calls.map(call => call[0] as unknown as { type: string; pageUrl?: string })
      .filter(message => message.type === type);
    /** The background's answers, with one for the save of the page's main video. */
    function answering(reply: Partial<DescriptorsMessage> | undefined, extra: Partial<DescriptorsMessage> = shown): void {
      popupFor({ title: "Page" }, [main], [], extra);
      const base = vi.mocked(chrome.runtime.sendMessage).getMockImplementation()!;
      vi.mocked(chrome.runtime.sendMessage).mockImplementation(((msg: { type: string }, cb?: (response: unknown) => void) => {
        if (msg.type === "download-page") cb?.(reply && { type: "descriptors", tabId: 1, descriptors: [main], page: { title: "Page" }, ...shown, ...reply });
        else (base as (msg: unknown, cb?: unknown) => void)(msg, cb);
      }) as never);
    }
    const save = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // A feed that advances with history.pushState while the popup is open: the list the background sends names the new address.
    it("names the page the list is about, also after the page changed its own address", () => {
      const listeners: ((msg: BackgroundToPopupMessage, sender: unknown, respond: (reply: unknown) => void) => void)[] = [];
      vi.mocked(globalThis.chrome.runtime.onMessage.addListener).mockImplementation((fn: unknown) => { listeners.push(fn as typeof listeners[number]); });
      answering({});
      render(<App />);
      const push = (pageUrl: string) => act(() => { for (const listener of listeners) listener({ type: "descriptors", tabId: 1, descriptors: [main],
        page: { title: "Page" }, ...shown, pageUrl }, {}, () => undefined); });
      // A fragment names a place inside the same page: the address the popup read from the tab stays.
      push("https://example.com/page#chapter-2");
      save();
      expect(requests("download-page")).toEqual([{ type: "download-page", tabId: 1, pageUrl: "https://example.com/page", ids: ["main"] }]);
      vi.mocked(chrome.runtime.sendMessage).mockClear();
      push("https://example.com/page/2");
      save();
      expect(requests("download-page")).toEqual([{ type: "download-page", tabId: 1, pageUrl: "https://example.com/page/2", ids: ["main"] }]);
      // The save started: nothing is said to have failed.
      expect(screen.queryByTestId("could-not-start")).toBeNull();
      expect(screen.getByTestId("announce-alert").textContent).toBe("");
    });

    it("says that the save could not start when the page's own script does not answer, and why when the tab moved on", async () => {
      answering({ notSaved: "could-not-start", reach: "needs-reload" });
      const first = render(<App />);
      save();
      expect(within(screen.getByTestId("could-not-start")).getByTestId("failure-title").textContent).toBe("Couldn't start the save");
      expect(screen.getByTestId("page-reach").textContent).toContain("Reload this page so savemedia can see it.");
      await waitFor(() => expect(screen.getByTestId("announce-alert").textContent)
        .toBe("Couldn't start the save. savemedia couldn't start saving this file. Reload the page and try again."));
      first.unmount();

      answering({ notSaved: "page-changed", pageUrl: "https://example.com/next" });
      render(<App />);
      save();
      const notice = screen.getByTestId("could-not-start");
      expect(within(notice).getByTestId("failure-title").textContent).toBe("The page changed");
      expect(notice.textContent).toContain("This tab moved on to another page before the save started, so nothing was saved.");
      expect(notice.textContent).toContain("The list now shows the new page. Save from it.");
      // The next Save is for the page the list now shows.
      fireEvent.click(screen.getByRole("button", { name: /Save/ }));
      expect(requests("download-page").at(-1)?.pageUrl).toBe("https://example.com/next");
    });

    it("says that the save could not start when the background gives no answer at all", () => {
      answering(undefined);
      render(<App />);
      save();
      expect(within(screen.getByTestId("could-not-start")).getByTestId("failure-title").textContent).toBe("Couldn't start the save");
    });

    it("starts the listed stream itself while the page's own script cannot be reached, as every other card does", () => {
      answering({}, { ...shown, reachable: false, reach: "needs-reload" });
      render(<App />);
      save();
      expect(requests("download-page")).toEqual([]);
      expect(requests("download")).toEqual([expect.objectContaining({ type: "download", streamId: "main" })]);
    });
  });

  it("acts only on the background's messages: what a page's content script sends is ignored", () => {
    // Every listener of the popup hears every runtime message, as in the browser.
    const listeners: ((msg: BackgroundToPopupMessage, sender: { id?: string; tab?: unknown }, respond: (reply: unknown) => void) => void)[] = [];
    vi.mocked(globalThis.chrome.runtime.onMessage.addListener).mockImplementation((fn: unknown) => { listeners.push(fn as typeof listeners[number]); });
    const deliver = (msg: BackgroundToPopupMessage, sender: { id?: string; tab?: unknown }) => act(() => { for (const listener of listeners) listener(msg, sender, () => undefined); });
    popupFor({ title: "Page" }, [directDescriptor({ title: "Real list" })]);
    render(<App />);
    const forged: BackgroundToPopupMessage = { type: "descriptors", tabId: 1, descriptors: [directDescriptor({ title: "Forged list" })] };
    deliver(forged, { tab: { id: 9 } });
    deliver({ type: "job-cancelled", streamId: directDescriptor().id }, { tab: { id: 9 } });
    deliver({ type: "job-failed", streamId: directDescriptor().id, error: { code: "engine_stopped", severity: "terminal", when: "running" } }, { tab: { id: 9 } });
    expect(screen.queryByText("Forged list")).toBeNull();
    expect(screen.getByText("Real list")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Cancelled|The save stopped/);
    expect(screen.getByTestId("announce-alert").textContent).toBe("");
    deliver(forged, {});
    expect(screen.getByText("Forged list")).toBeTruthy();
  });
});
