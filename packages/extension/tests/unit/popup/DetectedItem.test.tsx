import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { DetectedItem } from "../../../src/popup/components/DetectedItem";
import { LocalOfferContext } from "../../../src/popup/components/LocalOffer";
import { directDescriptor, hlsDescriptor, dashDescriptor, drmDescriptor, clearKeyDescriptor, unassemblableDash } from "./helpers/descriptors";
import type { StreamId, VariantId, AudioRenditionId } from "@savemedia/core";

/** The text a user reads without opening anything: everything outside a Technical details disclosure. */
function visibleText(container: HTMLElement): string {
  const copy = container.cloneNode(true) as HTMLElement;
  for (const details of copy.querySelectorAll("details")) details.remove();
  return copy.textContent ?? "";
}

/** The rows of a disclosure under an element: a failure's Technical details, or the item's own facts. */
function rows(scope: HTMLElement, disclosure: "technical-details" | "item-details" = "technical-details"): Record<string, string> {
  const list = scope.querySelector(`[data-testid="${disclosure}"] dl`)!;
  const labels = [...list.querySelectorAll("dt")].map(node => node.textContent ?? "");
  const values = [...list.querySelectorAll("dd")].map(node => node.textContent ?? "");
  return Object.fromEntries(labels.map((label, index) => [label, values[index] ?? ""]));
}

describe("DetectedItem — protected media", () => {
  it("states protection in plain words, with the system and the code only under Technical details", () => {
    const { container } = render(<ul>{<DetectedItem descriptor={drmDescriptor("cdm_required")} />}</ul>);
    const card = container.querySelector<HTMLElement>('[data-testid="drm-card"]')!;
    expect(card.getAttribute("data-deferred")).toBe("false");
    expect(within(card).getByTestId("failure-title").textContent).toBe("Protected video");
    expect(within(card).getByTestId("failure-body").textContent).toBe("This video is protected with DRM. savemedia does not save DRM-protected media.");
    expect(within(card).queryByTestId("failure-hint")).toBeNull();
    const visible = visibleText(card);
    expect(visible).not.toMatch(/cdm_required|Reason:|widevine|\p{Extended_Pictographic}/iu);
    expect(rows(card)).toMatchObject({ "Protection": "Widevine", "Detected in": "DASH manifest", "Error code": "cdm_required" });
  });

  it("describes Clear Key the same calm way, with no promise of a later feature", () => {
    const { container } = render(<ul>{<DetectedItem descriptor={clearKeyDescriptor()} />}</ul>);
    const card = container.querySelector<HTMLElement>('[data-testid="drm-card"]')!;
    expect(card.getAttribute("data-deferred")).toBe("true");
    expect(within(card).getByTestId("failure-title").textContent).toBe("Protected video");
    expect(visibleText(card)).not.toMatch(/not implemented|CENC|ClearKey|clearkey_deferred|yet/i);
    expect(rows(card)).toMatchObject({ "Protection": "Clear Key", "Error code": "clearkey_deferred" });
  });

  it("does not render a download button on DRM cards", () => {
    render(<ul>{<DetectedItem descriptor={drmDescriptor("cdm_required")} />}</ul>);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("DetectedItem — direct stream card", () => {
  it("keeps the technical facts of an item in readable rows behind the disclosure, and offers no toggle on the title", () => {
    const { container } = render(<ul>{<DetectedItem descriptor={directDescriptor()} />}</ul>);
    expect(screen.queryByRole("button", { name: /clip name/i })).toBeNull();
    expect(rows(container, "item-details")).toEqual({ "Format": "MP4", "Stream type": "Direct file", "Server": "example.com" });
    // Nothing failed, so the card has one disclosure, named for what it holds.
    expect([...container.querySelectorAll("summary")].map(node => node.textContent)).toEqual(["About this video"]);
    const visible = visibleText(container);
    expect(visible).not.toMatch(/direct|progressive|source type|output action|size unknown|Ready to save/i);
    // Without a codec the format is named, in words.
    expect(screen.getByTestId("item-meta").textContent).toBe("MP4");
  });

  it("names a stream's type, codecs, bit rate, size and frame rate in words", () => {
    const { container } = render(<ul>{<DetectedItem descriptor={hlsDescriptor()} />}</ul>);
    expect(rows(container, "item-details")).toEqual({ "Format": "MPEG-TS", "Stream type": "HLS stream", "Video": "H.264 High @ 4.0", "Audio": "AAC-LC", "Bitrate": "5.0 Mbps",
      "Size": "~95.4 MB (estimate)", "Frame rate": "30 fps", "Server": "example.com" });
    expect(screen.getByTestId("item-meta").textContent).toBe("1920×1080 · ~95.4 MB · H.264 High @ 4.0 + AAC-LC");
    expect(visibleText(container)).not.toMatch(/\bhls\b|mpegts|protocol|container/i);
  });

  it("sends a download message with sanitized filename when clicked", () => {
    const d = directDescriptor({ title: "My Clip / Bad!! Name" });
    render(<ul>{<DetectedItem descriptor={d} />}</ul>);
    const dl = screen.getByRole("button", { name: /^save$/i });
    fireEvent.click(dl);
    expect(globalThis.chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(globalThis.chrome.runtime.sendMessage).mock.calls[0]?.[0] as unknown as { choice: { filename: string }; allowRepeat?: boolean };
    expect(arg.choice.filename).toBe("My Clip Bad!! Name.mp4");
    expect(arg).not.toHaveProperty("allowRepeat");
  });

  it("names its button by the item it saves, for a screen reader", () => {
    render(<ul>{<DetectedItem descriptor={directDescriptor()} />}</ul>);
    const button = screen.getByRole("button", { name: "Save" });
    const described = document.getElementById(button.getAttribute("aria-describedby")!);
    expect(described?.textContent).toBe("clip name");
    expect(button.getAttribute("type")).toBe("button");
    // The mark on the button is decoration.
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("DetectedItem — default quality", () => {
  it("shows progressive alternatives and sends the selected source's own ID", () => {
    const low = directDescriptor({ id: "low" as StreamId, mediaGroup: "one", variants: [{
      ...hlsDescriptor().variants[0]!, id: "low-variant" as VariantId, width: null, height: 480,
      segmentRef: { kind: "direct", url: "https://cdn.example/low.mp4" },
    }] });
    const high = directDescriptor({ id: "high" as StreamId, mediaGroup: "one", variants: [{
      ...low.variants[0]!, id: "high-variant" as VariantId, height: 720,
      segmentRef: { kind: "direct", url: "https://cdn.example/high.mp4" },
    }] });
    render(<ul><DetectedItem descriptor={low} alternatives={[high]} /></ul>);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    // Each quality says what it costs in bytes, when that is known.
    expect(Array.from(select.options, o => o.text)).toEqual(["720p · 95.4 MB", "480p · 95.4 MB"]);
    expect(screen.queryByRole("status")).toBeNull();
    expect(select.value).toBe("high");
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: "download", streamId: "high" }), expect.any(Function));
    fireEvent.change(select, { target: { value: "low" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: "download", streamId: "low" }), expect.any(Function));
  });
  it("downloads the highest variant when none is chosen, whatever the playlist order", () => {
    const base = hlsDescriptor();
    const v1080 = base.variants[0]!;
    const v720 = { ...v1080, id: "v-720" as VariantId, width: 1280, height: 720, bitrate: 2_500_000 };
    render(<ul>{<DetectedItem descriptor={{ ...base, variants: [v720, v1080] }} />}</ul>);
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    const arg = vi.mocked(globalThis.chrome.runtime.sendMessage).mock.calls.at(-1)?.[0] as unknown as { choice: { variantId: string } };
    expect(arg.choice.variantId).toBe("v-1080");
  });
});

describe("DetectedItem — unsupported stream card", () => {
  it("offers Save for a clear DASH stream that declares no audio, with no refusal", () => {
    render(<ul>{<DetectedItem descriptor={dashDescriptor()} />}</ul>);
    expect(screen.queryByTestId("unsupported-card")).toBeNull();
    expect(screen.getByRole("button", { name: /^Save/ })).toBeTruthy();
  });

  it("renders DASH the browser cannot assemble as an explicit refusal with no download button", () => {
    const { container } = render(<ul>{<DetectedItem descriptor={unassemblableDash()} />}</ul>);
    const card = screen.getByTestId("unsupported-card");
    expect(within(card).getByTestId("failure-title").textContent).toBe("Can't save this stream in the browser");
    expect(within(card).getByTestId("failure-body").textContent).toBe("This video uses a streaming layout that savemedia can't assemble in the browser.");
    // The protocol and the code are technical details. No address is shown anywhere.
    expect(visibleText(container)).not.toMatch(/DASH|dash_unsupported|\/dash\//);
    expect(rows(card)).toEqual({ "Stream": "DASH", "Server": "example.com", "Error code": "dash_unsupported" });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers the Local downloader for what only the browser cannot finish: a pointer while it is off, a button once it is ready", () => {
    const save = vi.fn();
    const off = render(<LocalOfferContext.Provider value={{ state: "off", save }}><ul><DetectedItem descriptor={unassemblableDash()} /></ul></LocalOfferContext.Provider>);
    expect(screen.getByTestId("local-offer").textContent).toBe("The Local downloader below can try this page with yt-dlp.");
    off.unmount();
    const ready = render(<LocalOfferContext.Provider value={{ state: "ready", save }}><ul><DetectedItem descriptor={unassemblableDash()} /></ul></LocalOfferContext.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Save with yt-dlp" }));
    expect(save).toHaveBeenCalledOnce();
    ready.unmount();
    // On, but the helper or its tools are missing: nothing is offered that would not work.
    const missing = render(<LocalOfferContext.Provider value={{ state: "unavailable", save }}><ul><DetectedItem descriptor={unassemblableDash()} /></ul></LocalOfferContext.Provider>);
    expect(screen.queryByTestId("local-offer")).toBeNull();
    missing.unmount();
    // Never for protected media.
    render(<LocalOfferContext.Provider value={{ state: "ready", save }}><ul><DetectedItem descriptor={drmDescriptor()} /></ul></LocalOfferContext.Provider>);
    expect(screen.queryByTestId("local-offer")).toBeNull();
  });

  it("labels a live stream and says when it can be saved, without a Save button", () => {
    render(<ul>{<DetectedItem descriptor={hlsDescriptor()} live />}</ul>);
    expect(screen.getByTestId("live-badge").textContent).toBe("Live");
    const card = screen.getByTestId("live-card");
    expect(within(card).getByTestId("failure-title").textContent).toBe("Live stream");
    expect(within(card).getByTestId("failure-hint").textContent).toBe("Try again when the page plays the full recording.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a demuxed audio+video pair gets a Download button, not the DASH refusal", () => {
    // The av-merge shape: dash protocol, materialized video variant linked to
    // a materialized audio rendition (see background/capture.ts).
    const base = dashDescriptor();
    const pair = dashDescriptor({
      variants: [{ ...base.variants[0]!, audioRenditionId: "audio" as AudioRenditionId }],
      audioRenditions: [{
        ...base.variants[0]!,
        id: "pair-audio" as VariantId,
        videoCodec: null,
        audioRenditionId: "audio" as AudioRenditionId,
        segmentRef: { kind: "dash-segments", initUrl: "", mediaUrls: ["https://example.com/audio.m4a"] },
      }],
    });
    render(<ul>{<DetectedItem descriptor={pair} />}</ul>);
    expect(screen.queryByTestId("unsupported-card")).toBeNull();
    expect(screen.getByRole("button", { name: /^save$/i })).toBeTruthy();
  });
});

describe("DetectedItem — progress + error + complete states", () => {
  it("shows active progress bar with a plain label + bytes", () => {
    render(
      <ul>
        <DetectedItem
          descriptor={directDescriptor()}
          status={{ phase: "active", bytesWritten: 5_000, bytesTotal: 10_000, stage: { kind: "downloading" } }}
        />
      </ul>,
    );
    expect(screen.getByTestId("progress")).toBeTruthy();
    expect(screen.getByTestId("progress-label").textContent).toBe("Downloading");
    expect(screen.getByTestId("progress-bytes").textContent).toBe("4.9 KB of 9.8 KB");
    // The bar has one fixed name; what changes is its value.
    const bar = screen.getByRole("progressbar", { name: "Download progress" });
    expect(bar.getAttribute("value")).toBe("50");
    expect(bar.getAttribute("aria-valuetext")).toBe("50%, 4.9 KB of 9.8 KB");
    // The label is plain text: the card has no live region of its own.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("uses HLS segment progress as a percent, without the raw segment count, when the byte total is unknown", () => {
    render(
      <ul>
        <DetectedItem
          descriptor={hlsDescriptor()}
          status={{ phase: "active", bytesWritten: 123_000, bytesTotal: null, stage: { kind: "segment", index: 75, count: 100 } }}
        />
      </ul>,
    );
    const bar = screen.getByRole("progressbar", { name: "Download progress" });
    expect(bar.getAttribute("value")).toBe("75");
    expect(bar.getAttribute("aria-valuetext")).toBe("75%, 120.1 KB received");
    expect(screen.getByTestId("progress").textContent).not.toMatch(/75\/100|segment/i);
  });

  it("says once, under the save it is told to, that the popup can be closed", () => {
    const status = { phase: "active", bytesWritten: 1, bytesTotal: 2, stage: { kind: "downloading" } } as const;
    const first = render(<ul><DetectedItem descriptor={directDescriptor()} status={status} closeHint /></ul>);
    expect(screen.getByTestId("close-hint").textContent).toBe("You can close this popup. The save continues.");
    first.unmount();
    render(<ul><DetectedItem descriptor={directDescriptor()} status={status} /></ul>);
    expect(screen.queryByTestId("close-hint")).toBeNull();
  });

  it("states what a failed save kept and until when, from the failure's retained data", () => {
    const expiresAt = Date.now() + 4 * 60_000 + 1_000;
    render(
      <ul>
        <DetectedItem
          descriptor={directDescriptor()}
          status={{ phase: "failed", retained: { bytes: 2 * 1024 * 1024, total: 8 * 1024 * 1024, expiresAt },
            error: { code: "network_unreachable", severity: "terminal", phase: "direct", url: "https://example.com", during: "transfer" } }}
        />
      </ul>,
    );
    expect(screen.getByTestId("retained-bytes").textContent).toBe("savemedia kept 2.0 MB of 8.0 MB for 5 more minutes. Retry save in this tab to continue from there.");
    expect(screen.getByTestId("job-error").textContent).not.toContain("SaveMedia");
  });

  it("renders failure with userMessage when failed", () => {
    render(
      <ul>
        <DetectedItem
          descriptor={directDescriptor()}
          status={{ phase: "failed", error: { code: "transfer_failed", severity: "terminal", reason: "resume-refused", host: "cdn.example",
            receivedBytes: 5 * 1024 ** 2, totalBytes: 20 * 1024 ** 2, httpStatus: 416 } }}
        />
      </ul>,
    );
    const failure = screen.getByTestId("job-error");
    expect(within(failure).getByTestId("failure-title").textContent).toBe("The download can't continue");
    // The body and the hint are always visible, also when there are technical details.
    expect(within(failure).getByTestId("failure-body").textContent).toBe("The server stopped after 5.0 MB of 20.0 MB and won't send the rest.");
    expect(within(failure).getByTestId("failure-hint").textContent).toBe("Retry save starts the file again from the beginning.");
    expect(failure.querySelector("details")!.contains(within(failure).getByTestId("failure-body"))).toBe(false);
    expect(failure.querySelector("details")!.hasAttribute("open")).toBe(false);
    // Codes and statuses appear only inside the disclosure, each in an element of its own.
    expect(visibleText(failure)).not.toMatch(/transfer_failed|416|resume-refused|cdn\.example/);
    expect(rows(failure)).toEqual({ "Server": "cdn.example", "HTTP status": "416", "Received": `${5 * 1024 ** 2} of ${20 * 1024 ** 2} bytes`,
      "Reason": "resume-refused", "Error code": "transfer_failed" });
    expect(screen.getByRole("button", { name: "Retry save" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    // The card's two disclosures have different names: one holds the failure's codes, the other the item's facts.
    expect([...document.querySelectorAll("summary")].map(node => node.textContent)).toEqual(["Technical details", "About this video"]);
  });

  it.each([
    ["a web page in place of the video", { code: "unexpected_media_response", severity: "terminal", response: "page", host: "cdn.example" },
      "Reload the page, start playback, then try again. If your browser or network shows a warning page, read it there."],
    ["a refusal of access", { code: "access_denied", severity: "terminal", phase: "direct", url: "https://cdn.example/a.mp4", httpStatus: 403,
      explanation: "forbidden-or-expired-url" }, "Reload the page, start playback, then try again."],
  ] as const)("after %s the button is the plain Save: the hint comes first, and Retry save would repeat the failure", (_name, error, hint) => {
    render(<ul><DetectedItem descriptor={directDescriptor()} status={{ phase: "failed", error }} /></ul>);
    expect(screen.getByTestId("failure-hint").textContent).toBe(hint);
    expect(screen.getByTestId("item-action").textContent).toBe("Save");
    expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull();
  });

  it("offers Retry save where trying again can help, and wherever bytes were kept for it", () => {
    const busy = render(<ul><DetectedItem descriptor={directDescriptor()} status={{ phase: "failed",
      error: { code: "server_busy", severity: "terminal", phase: "direct", url: "https://cdn.example/a.mp4", httpStatus: 503 } }} /></ul>);
    expect(screen.getByTestId("item-action").textContent).toBe("Retry save");
    busy.unmount();
    // The kept bytes line names Retry save, so the button is there, whatever the failure.
    render(<ul><DetectedItem descriptor={directDescriptor()} status={{ phase: "failed",
      retained: { bytes: 1024 ** 2, total: 4 * 1024 ** 2, expiresAt: Date.now() + 60_000 },
      error: { code: "http_error", severity: "terminal", phase: "direct", url: "https://cdn.example/a.mp4", httpStatus: 500 } }} /></ul>);
    expect(screen.getByTestId("retained-bytes").textContent).toContain("Retry save in this tab");
    expect(screen.getByTestId("item-action").textContent).toBe("Retry save");
  });


  it("names a quality without a picture height by its bitrate or its place, never by its address", () => {
    const base = hlsDescriptor().variants[0]!;
    const playlist = "https://cdn.example/master.m3u8?token=secret";
    const withoutHeight = (index: number, bitrate: number | null) => ({ ...base, id: `${playlist}#var${index}` as VariantId, width: null, height: null,
      frameRate: null, bitrate, estimatedSize: null });
    const view = render(<ul><DetectedItem descriptor={hlsDescriptor({ title: "Talk", variants: [withoutHeight(0, 4_500_000), withoutHeight(1, 1_200_000)] })} /></ul>);
    const labels = () => [...screen.getByTestId("quality-select").querySelectorAll("option")].map(option => option.textContent);
    expect(labels()).toEqual(["4.5 Mbps", "1.2 Mbps"]);
    expect(visibleText(view.container)).not.toMatch(/https?:|m3u8|token|#var/);
    view.unmount();
    render(<ul><DetectedItem descriptor={hlsDescriptor({ variants: [withoutHeight(0, null), withoutHeight(1, null)] })} /></ul>);
    expect(labels()).toEqual(["Quality 1", "Quality 2"]);
    expect(screen.getByTestId("quality-select").textContent).not.toMatch(/https?:|m3u8|token|#var/);
  });

  it("colours a failure by what it is: an unusable file red, an unreachable server orange", () => {
    const tone = (error: Parameters<typeof DetectedItem>[0]["status"] & object) => {
      const view = render(<ul><DetectedItem descriptor={directDescriptor()} status={error} /></ul>);
      const result = [screen.getByTestId("job-error").getAttribute("data-tone"), screen.getByTestId("failure-title").className] as const;
      view.unmount();
      return result;
    };
    const unusable = tone({ phase: "failed", error: { code: "unexpected_media_response", severity: "terminal", response: "page" } });
    expect(unusable[0]).toBe("unusable");
    expect(unusable[1]).toContain("text-red-300");
    const unavailable = tone({ phase: "failed", error: { code: "server_busy", severity: "terminal", phase: "direct", url: "https://cdn.example/a", httpStatus: 503 } });
    expect(unavailable[0]).toBe("unavailable");
    expect(unavailable[1]).toContain("text-orange-300");
  });

  it("renders HLS runtime refusal messages after a failed attempt", () => {
    render(
      <ul>
        <DetectedItem
          descriptor={hlsDescriptor()}
          status={{ phase: "failed", error: { code: "hls_live_unsupported", severity: "terminal", manifestUrl: "https://x/live.m3u8" } }}
        />
      </ul>,
    );
    expect(within(screen.getByTestId("job-error")).getByTestId("failure-title").textContent).toBe("Live stream");
    expect(visibleText(screen.getByTestId("job-error"))).not.toMatch(/HLS|live\.m3u8/);
  });

  it("says where a finished file went, with its name and size when they are known", () => {
    const first = render(<ul><DetectedItem descriptor={directDescriptor()} status={{ phase: "complete" }} /></ul>);
    expect(screen.getByTestId("job-complete").textContent).toBe("Saved to Downloads");
    first.unmount();
    render(<ul><DetectedItem descriptor={directDescriptor()} status={{ phase: "complete", savedAs: "clip name.mp4", bytesTotal: 12 * 1024 ** 2 }} /></ul>);
    expect(screen.getByTestId("job-complete").textContent).toBe("Saved to Downloads: clip name.mp4 · 12.0 MB");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a second copy from the card is the user's answer to the repeat question", () => {
    render(<ul><DetectedItem descriptor={directDescriptor()} status={{ phase: "complete", savedAs: "clip name.mp4" }} /></ul>);
    fireEvent.click(screen.getByRole("button", { name: "Save another copy" }));
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: "download", allowRepeat: true }), expect.any(Function));
  });

  it("shows the user's own cancel as a neutral state: the card goes back to Save and nothing reads as a failure", () => {
    const { container } = render(<ul><DetectedItem descriptor={directDescriptor()} status={{ phase: "cancelled" }} /></ul>);
    expect(screen.getByTestId("job-cancelled").textContent).toBe("Cancelled");
    expect(screen.getByTestId("job-cancelled").className).toContain("text-muted");
    expect(screen.queryByTestId("job-error")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(container.textContent).not.toMatch(/failed|error|discarded/i);
  });

  it("keeps one button for the card's whole life: the label changes, the element and the focus stay", () => {
    const d = directDescriptor();
    const view = render(<ul><DetectedItem descriptor={d} /></ul>);
    const button = screen.getByTestId("item-action");
    button.focus();
    expect(button.textContent).toBe("Save");
    const phases = [
      [{ phase: "active", bytesWritten: 1, bytesTotal: 2, stage: { kind: "downloading" } }, "Cancel", false],
      [{ phase: "active", bytesWritten: 2, bytesTotal: 2, stage: { kind: "verifying" } }, "Cancel", false],
      [{ phase: "active", bytesWritten: 2, bytesTotal: 2, stage: { kind: "writing" } }, "Saving…", true],
      [{ phase: "complete", savedAs: "clip name.mp4" }, "Save another copy", false],
      [{ phase: "cancelled" }, "Save", false],
      [{ phase: "failed", error: { code: "engine_stopped", severity: "terminal", when: "running" } }, "Retry save", false],
    ] as const;
    for (const [status, label, disabled] of phases) {
      view.rerender(<ul><DetectedItem descriptor={d} status={status} /></ul>);
      expect(screen.getByTestId("item-action")).toBe(button);
      expect(button.textContent).toBe(label);
      expect((button as HTMLButtonElement).disabled).toBe(disabled);
      if (!disabled) expect(document.activeElement).toBe(button);
    }
  });

  it("calls onCancel when cancel button is clicked while active", () => {
    const onCancel = vi.fn();
    const d = directDescriptor();
    render(
      <ul>
        <DetectedItem
          descriptor={d}
          status={{ phase: "active", bytesWritten: 1, bytesTotal: 2 }}
          onCancel={onCancel}
        />
      </ul>,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledWith(d.id);
  });
});

describe("DetectedItem — low-resolution sources", () => {
  it("offers a sub-720p source like any other, without a quality warning", () => {
    const d = hlsDescriptor();
    const lowVariant = { ...d.variants[0]!, height: 360, width: 640 };
    const low = { ...d, variants: [lowVariant], id: "stream-low" as StreamId };
    const { container } = render(<ul>{<DetectedItem descriptor={low} />}</ul>);
    expect(container.textContent).toContain("640×360");
    expect(container.textContent).not.toMatch(/720p/i);
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });
});

describe("DetectedItem — expected size", () => {
  it("shows a direct file's size and an estimate for a stream with a known duration", () => {
    const file = directDescriptor({ source: { kind: "direct-url", url: "https://cdn.example/clip.mp4",
      headers: { "content-range": "bytes 0-1023/257425408" } } });
    const { unmount } = render(<ul><DetectedItem descriptor={file} /></ul>);
    expect(screen.getByTestId("expected-size").textContent).toBe("245.5 MB");
    unmount();

    const stream = hlsDescriptor({ variants: [{ ...hlsDescriptor().variants[0]!, estimatedSize: null, bitrate: 2_000_000 }] });
    render(<ul><DetectedItem descriptor={stream} preview={{ thumbnail: null, width: 1920, height: 1080, duration: 2869 }} /></ul>);
    expect(screen.getByTestId("expected-size").textContent).toBe("~684.0 MB");
  });
});

describe("DetectedItem — talking to the background", () => {
  it("Save and Cancel are requests that read their answer, and an expired row asks for a new look at the page", () => {
    const answers: Record<string, unknown> = { download: { type: "download-result", outcome: "listing-expired" }, cancel: { ok: true } };
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((msg: { type: string }, cb?: (reply: unknown) => void) => { cb?.(answers[msg.type]); }) as never);
    const onListingExpired = vi.fn();
    const d = directDescriptor();
    const { unmount } = render(<ul><DetectedItem descriptor={d} onListingExpired={onListingExpired} /></ul>);
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: "download", streamId: d.id }), expect.any(Function));
    expect(onListingExpired).toHaveBeenCalledOnce();
    unmount();

    // A started save, a failed request and a reply that is no reply ask for nothing.
    for (const reply of [{ type: "download-result", outcome: "started" }, { type: "request-failed" }, undefined, { ok: true }]) {
      answers["download"] = reply;
      const next = render(<ul><DetectedItem descriptor={d} onListingExpired={onListingExpired} /></ul>);
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
      next.unmount();
    }
    expect(onListingExpired).toHaveBeenCalledOnce();

    render(<ul><DetectedItem descriptor={d} status={{ phase: "active", bytesWritten: 1, bytesTotal: 2, stage: { kind: "downloading" } }} /></ul>);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({ type: "cancel", streamId: d.id }, expect.any(Function));
  });

  it("survives a background that is gone: the extension was reloaded while the popup is open", () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((() => { throw new Error("Extension context invalidated."); }) as never);
    const onListingExpired = vi.fn();
    render(<ul><DetectedItem descriptor={directDescriptor()} onListingExpired={onListingExpired} /></ul>);
    expect(() => fireEvent.click(screen.getByRole("button", { name: /^save$/i }))).not.toThrow();
    expect(onListingExpired).not.toHaveBeenCalled();
  });
});

