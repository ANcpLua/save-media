import type { BestDownloadOutcome } from "./router";
import {
  MAIN_BRIDGE_TAG,
  type BackgroundToContentMessage,
  type BackgroundToPopupMessage,
  type BridgeToBackgroundMessage,
  type ContentDiscoveryResponse,
  type HotkeyFeedbackOutcome,
  type LocalJobView,
} from "../types/messages";
import { userMessage } from "@savemedia/core";
import { isDelegableError } from "../native/local-downloader";

type CaptureMessage = Extract<BridgeToBackgroundMessage, { type: "capture" }>;

interface ActiveTab {
  readonly id?: number | undefined;
  readonly url?: string | undefined;
}

export interface DownloadBestDeps {
  readonly tabs: {
    readonly query: (queryInfo: { readonly active: true; readonly currentWindow: true }) => Promise<readonly ActiveTab[]>;
    readonly sendMessage: (
      tabId: number,
      msg: BackgroundToContentMessage,
      cb: (response: ContentDiscoveryResponse | undefined) => void,
    ) => void;
  };
  readonly runtime: {
    readonly lastError: () => unknown;
    readonly sendMessage: (msg: BackgroundToPopupMessage, cb?: () => void) => void;
  };
  readonly router: {
    readonly startBestDownload: (tabId: number) => Promise<BestDownloadOutcome>;
  };
  readonly handleCapture: (tabId: number, msg: CaptureMessage) => Promise<void>;
  /**
   * Visible per-tab feedback for the hotkey path. The popup is usually
   * closed when Alt+S fires, so job-failed messages alone leave the user
   * staring at a page where "nothing happened".
   */
  readonly showHotkeyFeedback: (tabId: number, outcome: HotkeyFeedbackOutcome, detail: string) => void;
  /**
   * Optional local downloader (user-installed yt-dlp host). Consulted only
   * when the in-browser engine has nothing to save or refused for a
   * non-DRM reason; see DELEGABLE_ERROR_CODES.
   */
  readonly localFallback?: (pageUrl: string, tabId: number) => Promise<LocalJobView | null>;
}

export interface CommandsLike {
  readonly onCommand: {
    readonly addListener: (listener: (command: string) => void) => void;
  };
}

export async function discoverPageMediaForTab(
  deps: Pick<DownloadBestDeps, "tabs" | "runtime" | "handleCapture">,
  tabId: number,
  fallbackPageUrl: string,
): Promise<void> {
  const request: BackgroundToContentMessage = { type: "discover-page-media" };
  const response = await new Promise<ContentDiscoveryResponse | null>(resolve => {
    deps.tabs.sendMessage(tabId, request, resp => {
      if (deps.runtime.lastError()) {
        resolve(null);
        return;
      }
      resolve(resp ?? null);
    });
  });

  if (!response) return;
  const pageUrl = response.pageUrl || fallbackPageUrl;
  for (const url of response.urls) {
    await deps.handleCapture(tabId, {
      type: "capture",
      payload: {
        [MAIN_BRIDGE_TAG]: true,
        kind: "media-source",
        url,
        pageUrl,
      },
    });
  }
}

export async function downloadBestForActiveTab(deps: DownloadBestDeps): Promise<void> {
  const [tab] = await deps.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  await downloadBestForTab(deps, tab.id, tab.url ?? "");
}

export async function downloadBestForTab(
  deps: DownloadBestDeps,
  tabId: number,
  fallbackPageUrl: string,
): Promise<void> {
  await discoverPageMediaForTab(deps, tabId, fallbackPageUrl);
  const outcome = await deps.router.startBestDownload(tabId);

  if (outcome.kind === "started") {
    deps.showHotkeyFeedback(tabId, "started", "Saving best quality");
    return;
  }

  const delegable = outcome.kind === "no-media" || isDelegableError(outcome.error);
  if (delegable && deps.localFallback && fallbackPageUrl) {
    const job = await deps.localFallback(fallbackPageUrl, tabId);
    if (job) {
      deps.showHotkeyFeedback(tabId, "delegated", "Handed to local downloader");
      return;
    }
  }

  if (outcome.kind === "no-media") {
    deps.showHotkeyFeedback(tabId, "no-media", "No supported media on this page");
    return;
  }

  deps.showHotkeyFeedback(tabId, "failed", userMessage(outcome.error).title);
  const msg: BackgroundToPopupMessage = {
    type: "job-failed",
    streamId: outcome.streamId,
    error: outcome.error,
  };
  deps.runtime.sendMessage(msg, () => undefined);
}

export function registerDownloadBestCommand(commands: CommandsLike | undefined, deps: DownloadBestDeps): void {
  commands?.onCommand.addListener(command => {
    if (command === "download-best") void downloadBestForActiveTab(deps);
  });
}
