// Every string the popup, the toolbar button and the Alt+S toast show that is
// not the text of a JobError (packages/core/src/errors/messages.ts and
// network-block.ts), a transfer stage (util/transfer-progress.ts) or a toast
// label (ui/toast-text.ts). Local downloader failures and image refusals are here.
//
// Wording rules (the same in every text catalogue):
// - Title: what happened, at most about 8 words, sentence case, no period. No codes, no HTTP numbers and
//   no protocol words.
// - Body: one or two plain sentences on what happened.
// - Hint: what the user can do, starting with a verb, or null when nothing helps. A hint that points at one of
//   the popup's controls has a second wording for the toast, which says to open savemedia first.
// - Technical details: labelled rows. Codes, statuses and the tools' own output go there and nowhere else.
// - Names: "savemedia" in lowercase, also at the start of a sentence. "savemedia helper" for the native
//   program, "Local downloader" for the feature, "yt-dlp" and "ffmpeg" for the tools. "your browser",
//   never a browser's name (a browser's name is fine as a choice of cookie source). "Downloads folder". "Alt+S".
// - Typography: plain apostrophes, "…" for a button that shows work in progress, "·" as a separator.
//   No long dashes, no pictographs, no exclamation marks, no "please".
// - A cancel by the user is neutral, never a failure.
// - Never tell the user to use a site's button or control. Browser menus and savemedia's own buttons are fine.
// - Never suggest a VPN, another DNS server, switching a filter off or any other way around a block.
// - British spelling: licence, cancelled, organisation.
import { technicalText, type TechnicalDetail, type UserMessage } from "@savemedia/core";
import type { LocalFailureCode } from "../types/native";
import type { SelectionState } from "../types/page-facts";
import type { PageReachKind } from "../util/page-reach";

/** The one line that appeals to the user's conscience. Shown once, in the popup footer. */
export const CONSCIENCE_LINE = "Save only what you have the right to keep.";

export const POPUP = {
  name: "savemedia",
  shortcutHint: "saves the video or image under the pointer, or this page's main video.",
  /** The browser holds no key for the save command: another extension has Alt+S, or the user cleared it. */
  shortcutMissing: "No keyboard shortcut is set, so Alt+S does nothing.",
  setShortcut: "Set shortcut",
  window: "Window",
  windowTitle: "Open in a resizable window",
  listHeading: "Detected",
  rescan: "Check page again",
  rescanning: "Checking…",
  loading: "Checking this page…",
  noTab: "No page to check.",
  empty: "No media detected on this page.",
  emptyHint: "If the page plays a video, start it, then press Check page again.",
  /** Nothing of the page's own is listed, and the Ads group below holds what the browser loaded. Never next to "No media detected". */
  onlyAds: "savemedia found only ads on this page. They are listed under Ads.",
  reloadPage: "Reload page",
  otherMedia: (count: number): string => `Other media (${count})`,
  /** What the page's ad responses named and your browser loaded. Listed last, never as the main video. */
  ads: (count: number): string => `Ads (${count})`,
  adBadge: "Ad",
  unavailableSources: (count: number): string => `Unavailable sources (${count})`,
  unavailableSourcesLabel: "Sources that could not be checked",
  savedEarlier: "Saved earlier in this browser session",
  closeHint: "You can close this popup. The save continues.",
  cancelled: "Cancelled",
  mainBadge: "Main",
  liveBadge: "Live",
  quality: "Quality",
  original: "Original",
  /** A quality the page states no picture height for: its place in the list, best first. */
  qualityNumber: (place: number): string => `Quality ${place}`,
  protectedTitle: "Protected video",
  /** The disclosure under a failure: its codes, statuses and servers. */
  technicalDetails: "Technical details",
  /** The disclosure with a listed item's own facts. A card can show both, so each has its own name. */
  aboutItem: "About this video",
  progressName: "Download progress",
  exportLog: "Export diagnostic log",
  exporting: "Exporting…",
  exported: "Saved to Downloads",
  exportFailed: "Couldn't export the log",
} as const;

export const BUTTON = {
  save: "Save",
  retry: "Retry save",
  again: "Save another copy",
  preparing: "Preparing…",
  saving: "Saving…",
  cancel: "Cancel",
} as const;

/** "Saved to Downloads: clip.mp4 · 12.0 MB". */
export function savedText(name: string | undefined, size: string | null): string {
  const base = name ? `Saved to Downloads: ${name}` : "Saved to Downloads";
  return size ? `${base} · ${size}` : base;
}

/** What a live region says. Announcements come from events, never from what a popup shows when it opens. */
export const ANNOUNCE = {
  found: (count: number): string => count === 0 ? POPUP.empty : count === 1 ? "Found 1 item." : `Found ${count} items.`,
  unavailable: (count: number): string => count === 1 ? "1 source could not be checked." : `${count} sources could not be checked.`,
  saving: (title: string): string => `Saving ${title}`,
  saved: (name: string | undefined): string => savedText(name, null),
  cancelled: "Save cancelled",
  exported: "Diagnostic log saved to Downloads",
  exportFailed: POPUP.exportFailed,
  copied: "Copied",
  failure: (message: Pick<UserMessage, "title" | "body" | "hint">): string =>
    [`${message.title}.`, message.body, message.hint ?? ""].filter(Boolean).join(" "),
} as const;

const plain = (title: string, body: string, hint: string | null, tone: UserMessage["tone"] = "unavailable",
  details: readonly TechnicalDetail[] = [], toastHint?: string): UserMessage =>
  ({ title, body, hint, tone, details, action: null, ...(toastHint ? { toastHint } : {}) });

/** A save that never got as far as a request: there is no error to explain. */
export const COULD_NOT_START: UserMessage = plain("Couldn't start the save", "savemedia couldn't start saving this file.",
  "Reload the page and try again.");

/** Save was pressed for a page the tab no longer shows. The list has been brought up to date. */
export const PAGE_CHANGED: UserMessage = plain("The page changed", "This tab moved on to another page before the save started, so nothing was saved.",
  "The list now shows the new page. Save from it.");

export const REPEAT = {
  question: "savemedia already saved this file in this browser session. Save another copy?",
  cancel: BUTTON.cancel,
  confirm: BUTTON.again,
  /** The toast when the popup cannot be opened to ask. Shown again on each press while the question is open. */
  toast: "Click the savemedia icon to save another copy.",
  /** An allowed second copy of an image whose address was not kept while the question waited. */
  pressAgain: "Press Alt+S on the image again to save another copy.",
} as const;

/** Kept bytes of an interrupted file, and how long Retry save can still use them. */
export function retainedText(bytes: string, total: string, minutes: number): string {
  return `savemedia kept ${bytes} of ${total} for ${minutes} more ${minutes === 1 ? "minute" : "minutes"}. Retry save in this tab to continue from there.`;
}

// ---- states in which nothing failed but nothing can be saved yet -----------

export type WaitingState = Extract<SelectionState, "not-loaded-yet" | "file-not-received" | "ad-playing" | "ambiguous">;

export const WAITING_HINTS: Readonly<Record<WaitingState, string>> = {
  "not-loaded-yet": "The page has not loaded the video yet. Start playback, then try again.",
  "file-not-received": "This file has not reached your browser yet. savemedia saves it once your browser receives it.",
  "ad-playing": "An ad is playing. Try again when the video starts.",
  "ambiguous": "savemedia can't tell which stream this player shows. Start playback of this video, then try again.",
};

/**
 * The page names a file, and what the browser received is something else (a preview of it, in another format):
 * said under what the popup offers, so that nobody takes the preview for the named file.
 */
export function namedFilePending(name: string): string {
  return `The file this page names (${name}) has not reached your browser yet. What is listed here is what your browser did receive. savemedia saves the named file once your browser receives it.`;
}

/** The player is already playing, so starting it cannot help: the popup lists the streams to choose from. */
export const AMBIGUOUS_PLAYING_HINT = "savemedia can't tell which stream this player shows. Open savemedia and choose the video from its list.";

export function waitingHint(state: SelectionState): string | null {
  return state in WAITING_HINTS ? WAITING_HINTS[state as WaitingState] : null;
}

// ---- sites that are read by a site reader alone ------------------------------
// What the browser loads on such a site is not observed, so starting playback or checking again changes
// nothing there: the text says why nothing is offered, names no site and promises no way around it.

export type SiteState = Extract<SelectionState, "site-not-saved" | "reader-found-nothing">;

export const SITE_TEXTS: Readonly<Record<SiteState, string>> = {
  "site-not-saved": "savemedia does not save videos from this site.",
  "reader-found-nothing": "savemedia found no file it can save in this page's player data.",
};

export function siteText(state: SelectionState): string | null {
  return state in SITE_TEXTS ? SITE_TEXTS[state as SiteState] : null;
}

/** The one line the popup shows in place of its list when the selection has a reason for showing none. */
export function emptyReason(state: SelectionState): string | null {
  return waitingHint(state) ?? siteText(state);
}

// ---- the Alt+S toast's detail line (the label is in ui/toast-text.ts) ------

export type NotAnImage = "page" | "program" | "data" | "unknown";

export const HOTKEY = {
  bestQuality: "Best quality",
  thisVideo: "This video",
  image: "Image",
  /** Under the label "Checking": a source of the page is checked before the save can start. */
  checking: "This page's video",
  alreadyRunning: "Already in progress",
  /** After what is being saved, when it is not the file the page names. */
  notTheNamedFile: "The file this page names has not reached your browser yet.",
  delegated: "With yt-dlp on this computer",
  savedFallback: "To your Downloads folder",
  nothingSaved: "Nothing was saved.",
  noMedia: POPUP.empty,
  /** A camera or screen stream: there is no file behind it. */
  streamSource: "This video is made inside the page and has no file to save.",
  couldNotStart: "Couldn't start the save. Try again.",
  imagePageOnly: "This image exists only inside the page. Right-click it and choose Save Image As.",
  imageNotSent: "The image didn't arrive. Try again, or right-click it and choose Save Image As.",
  imageLocalNetwork: "This image is on your local network and this page is on the internet, so savemedia did not request it. Right-click it and choose Save Image As.",
} as const;

export const IMAGE_REFUSALS: Readonly<Record<NotAnImage, string>> = {
  page: "Not an image. The address sent a web page, so savemedia did not save it.",
  program: "Not an image. The address sent a program or an archive, so savemedia did not save it.",
  data: "Not an image. The address sent text or a script, so savemedia did not save it.",
  unknown: "Not an image. The address sent another kind of file, so savemedia did not save it.",
};

/** "Best quality · 245.3 MB" */
export function withSize(text: string, size: string | null): string {
  return size ? `${text} · ${size}` : text;
}

// ---- why a page cannot be read ----------------------------------------------

export interface PageReachText { readonly title: string; readonly body?: string }

/** One plain text per state, shared by the popup and the toolbar button. */
export const PAGE_REACH_TEXT: Readonly<Record<Exclude<PageReachKind, "reachable">, PageReachText>> = {
  "load-failed": { title: "This page did not load. Reload it, then try again.", body: "Your browser shows its own error page in this tab." },
  "needs-reload": { title: "Reload this page so savemedia can see it.", body: "This tab was open before savemedia was installed or updated." },
  "blocked": { title: "Your browser does not let extensions read this page." },
  "site-access-off": { title: "savemedia is not allowed on this site.",
    body: "Allow it in your browser's extension site access settings, then reload the page." },
  "file-access-off": { title: "savemedia can't read files on this computer.",
    body: "Allow savemedia to access file URLs in your browser's extension settings, then reload the page." },
  "not-web": { title: "savemedia checks web pages. This page belongs to the browser." },
  "loading": { title: "The page is still loading. Try again when it has loaded." },
};

/** The text for a state, or null when the page can be read. */
export function pageReachText(kind: PageReachKind | null | undefined): PageReachText | null {
  return kind && kind !== "reachable" ? PAGE_REACH_TEXT[kind] : null;
}

/** Alt+S where the page script cannot be reached and the popup cannot be opened. */
export const UNREACHABLE_PAGE_HINT = PAGE_REACH_TEXT["needs-reload"].title;

// ---- the toolbar button -----------------------------------------------------

export const TOOLBAR = {
  /** One running save: "savemedia · Downloading · 42% of 1.20 GB". */
  one: (label: string, progress: string | null): string => progress ? `savemedia · ${label} · ${progress}` : `savemedia · ${label}`,
  several: (count: number, percent: number | undefined): string =>
    `savemedia · ${count} saves in progress${percent === undefined ? "" : ` · ${percent}%`}`,
  /** The Alt+S result, for as long as its toast shows. */
  feedback: (label: string, detail: string): string => `savemedia · ${label}: ${detail}`,
  notice: (text: string): string => `savemedia · ${text}`,
} as const;

// ---- details of a listed item ----------------------------------------------

export const ITEM = {
  format: "Format",
  streamType: "Stream type",
  video: "Video",
  audio: "Audio",
  bitrate: "Bitrate",
  size: "Size",
  frameRate: "Frame rate",
  server: "Server",
  sizeExact: (size: string): string => `${size} (from the server)`,
  sizeEstimate: (size: string): string => `${size} (estimate)`,
  exactTitle: "File size",
  estimateTitle: "Estimated size",
} as const;

export const CONTAINER_NAMES: Readonly<Record<string, string>> = {
  mp4: "MP4", mov: "QuickTime", webm: "WebM", mkv: "MKV", mpegts: "MPEG-TS", fmp4: "MP4", cmaf: "MP4",
};

export const STREAM_TYPES = {
  direct: "Direct file",
  hls: "HLS stream",
  dash: "DASH stream",
  element: "Media element",
} as const;

// ---- Local downloader -------------------------------------------------------

export const LOCAL = {
  title: "Local downloader",
  enable: "Use yt-dlp",
  pillNoHelper: "Helper not installed",
  pillOutdated: "Helper needs an update",
  pillToolsMissing: "Tools missing",
  pillReady: "Ready",
  lostContact: "savemedia lost contact with the Local downloader. Close and reopen this popup.",
  about: "Saves pages with yt-dlp and ffmpeg installed on this computer. Off until you turn it on.",
  installHelper: "Install the savemedia helper: paste this into Terminal, then reopen this popup.",
  updateHelper: "The installed savemedia helper is older than this version of savemedia needs. Paste this into Terminal to update it, then reopen this popup.",
  toolsNeeded: (tools: readonly string[]): string => `Still needed on this computer: ${tools.join(" and ")}. Paste this into Terminal:`,
  ready: (ytdlp: string | null, ffmpeg: string | null): string =>
    `yt-dlp ${ytdlp ?? "version unknown"} · ffmpeg ${ffmpeg ?? "version unknown"} · saves to `,
  quality: "Quality",
  qualityBest: "Best available",
  qualityUpTo: (height: string): string => `Up to ${height}p`,
  cookies: "Cookies",
  cookiesAuto: "This browser, if available",
  cookiesNone: "No cookies",
  fallback: "Use for Alt+S when savemedia can't save the page in the browser",
  savePage: "Save this page with yt-dlp",
  copy: "Copy",
  copied: "Copied",
  saved: (name: string): string => `Saved ${name}`,
  cancel: BUTTON.cancel,
  /** Offered on a failure the Local downloader may handle, while it is off. */
  offerWhenOff: "The Local downloader below can try this page with yt-dlp.",
  offerButton: "Save with yt-dlp",
} as const;

export interface LocalFailureInput {
  readonly code: LocalFailureCode;
  /** The helper's report: yt-dlp's own last line, or the helper's or the browser's words. Shown under Technical details only. */
  readonly message: string;
  /** The HTTP status yt-dlp reported for the site's answer, when it reported one. */
  readonly httpStatus?: number | null | undefined;
}

type LocalFailureText = readonly [title: string, body: string, hint: string | null, toastHint?: string];

// The popup's hints point at the Local downloader's own controls. On the page, where the popup is closed, the toast says to open savemedia first.
const CHOOSE_COOKIES = "Under Cookies, choose the browser you are signed in with, then try again.";
const CHOOSE_COOKIES_TOAST = "Open savemedia and, under Cookies, choose the browser you are signed in with.";

/** What an HTTP status from the site means, when yt-dlp reported nothing more specific. The number goes under Technical details. */
function statusFailure(status: number): LocalFailureText {
  if (status === 401 || status === 403) return ["The site refused yt-dlp", "The site did not accept the request for this video.",
    CHOOSE_COOKIES, CHOOSE_COOKIES_TOAST];
  // The user's own proxy wants a sign-in: no cookie choice changes that.
  if (status === 407) return ["Proxy sign-in needed", "Your proxy asked yt-dlp to sign in.", "Check your proxy settings."];
  if (status === 404 || status === 410) return ["The video is no longer available", "The site no longer has this video at this address.", "Reload the page and try again."];
  if (status === 429) return ["The site asked yt-dlp to slow down", "The site is limiting requests right now.", "Wait a few minutes, then try again."];
  if (status === 451) return ["Blocked for legal reasons", "The site or your network says this video is unavailable for legal reasons.", null];
  if (status >= 500) return ["The server is busy", "The video server is not responding properly right now.", "Try again in a few minutes."];
  return ["The site refused the request", "The site would not send this video to yt-dlp.", "Reload the page and try again."];
}

const LOCAL_FAILURES: Readonly<Record<LocalFailureCode, LocalFailureText>> = {
  host_unavailable: ["Helper not reachable", "savemedia could not start the savemedia helper.",
    "Install it with the command under Local downloader, then reopen this popup.",
    "Open savemedia for the install command under Local downloader."],
  already_saved: ["Saved before", "The Local downloader already saved this video once.", null],
  ytdlp_missing: ["yt-dlp not found", "The savemedia helper could not find yt-dlp on this computer.", "Install yt-dlp, then try again."],
  ffmpeg_missing: ["ffmpeg not found", "The savemedia helper could not find ffmpeg on this computer.", "Install ffmpeg, then try again."],
  drm_protected: ["Protected video", "This video is protected with DRM. savemedia does not save DRM-protected media.", null],
  unsupported_url: ["Page not supported", "yt-dlp can't read videos from this page.", null],
  login_required: ["Sign-in needed", "The site wants a signed-in session for this video.", CHOOSE_COOKIES, CHOOSE_COOKIES_TOAST],
  geo_restricted: ["Not available in your region", "The site does not offer this video in your region.", null],
  network: ["Connection failed", "yt-dlp could not download the video.", "Check your connection, then try again."],
  timeout: ["The download stopped", "yt-dlp stopped making progress, so the savemedia helper ended the save.", "Check your connection, then try again."],
  cancelled: ["Cancelled", "Nothing was saved.", null],
  invalid_request: ["Request rejected", "The savemedia helper rejected the request.", "Update the helper with the setup command, then try again.",
    "Open savemedia for the setup command under Local downloader, then try again."],
  unknown: ["yt-dlp could not save this page", "yt-dlp stopped with an error.", null],
};

/**
 * The failures whose hint points at the setup command. The popup shows the command with such a failure,
 * unless the Local downloader's own section already shows it.
 */
export const NAMES_SETUP_COMMAND: ReadonlySet<LocalFailureCode> = new Set<LocalFailureCode>(["host_unavailable", "invalid_request"]);

/**
 * Plain text for a Local downloader failure, for the popup and the toast.
 * yt-dlp's own line and an HTTP status never appear in the main text.
 */
export function localFailureMessage(failure: LocalFailureInput): UserMessage {
  const status = failure.httpStatus ?? null;
  const [title, body, hint, toastHint] = failure.code === "unknown" && status !== null ? statusFailure(status) : LOCAL_FAILURES[failure.code];
  const tone = failure.code === "drm_protected" ? "protected" : failure.code === "cancelled" ? "neutral" : "unavailable";
  const said = technicalText(failure.message);
  const details: TechnicalDetail[] = [
    ...(status !== null ? [{ label: "HTTP status", value: String(status) }] : []),
    // The helper passes on yt-dlp's last line when there is one, and otherwise says in its own words what stopped it.
    // When the helper never ran, the line is the browser's.
    ...(said ? [{ label: failure.code === "host_unavailable" ? "Browser said" : "Helper said", value: said }] : []),
    { label: "Error code", value: failure.code },
  ];
  return plain(title, body, hint, tone, details, toastHint);
}
