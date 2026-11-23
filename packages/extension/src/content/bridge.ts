// ISOLATED-world content script, in every frame. MV3 injects content scripts
// as classic scripts, so the build makes this entry one self-contained IIFE
// (vite.config.ts) and fails if a module statement survives.
//
// Runtime imports come only from src/content/** and the pure, import-free
// modules in src/util (media-url) and src/ui (toast-text). Imports from
// src/types are type-only. No zod and no @savemedia/core: the message guards
// here are written by hand.
//
// The bridge reports facts and never decides. It answers the background's
// request for this frame's facts, relays what the browser itself did
// (requests in the resource timeline, key use on media elements), and keeps
// the Alt+S gesture and the feedback toast.
import { collectFrameFacts, pageFileState, type PointerRecord } from "./frame-facts";
import { altSAction } from "./hotkey";
import { isAddress, isRecord, mainPayload, MAX_URL } from "./capture-guard";
import { elementKeys, shadowRootOf } from "./media-tree";
import { playlistIdentity, requestTypeOfTiming, withoutHash, worthProbing } from "../util/media-url";
import { RECONNECT_HINT, TOAST_LABELS, TOAST_TONE, toastDuration, toastUrgency, type ToastOutcome } from "../ui/toast-text";
import type { FileSaveProblem } from "../types/messages";

export {};

interface HotkeyFeedbackMessage {
  type: "hotkey-feedback";
  outcome: ToastOutcome;
  detail: string;
}

// The page keeps the last attempt across popup closure and service worker sleep.
let lastFileSave: { pageUrl: string; problem: FileSaveProblem } | null = null;
const keyOf = elementKeys();

// An open tab can keep this isolated-world listener after the extension was reloaded.
function sendRuntimeEvent(message: unknown, reply?: (answer: unknown) => void): boolean {
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.sendMessage) return false;
  try {
    runtime.sendMessage(message, (answer: unknown) => {
      if (!runtime.lastError) reply?.(answer);
    });
    return true;
  } catch { return false; }
}

// ---------- what the MAIN world may say ----------
// A page can post anything here. Only two things are passed on: addresses the
// page's ad responses named (which can only keep media out of the list) and a
// site resolver's file addresses (which the background accepts only from the
// hosts that have a resolver, and requests without the user's cookies).
window.addEventListener("message", event => {
  if (event.source !== window) return;
  const payload = mainPayload(event.data, location.href);
  if (payload) sendRuntimeEvent({ type: "capture", payload });
});

// ---------- requests the browser made ----------
// The resource timeline lists requests this document's browser really made.
// The page cannot add entries without making the request, so the bridge reads
// it here instead of trusting a message from the page. It covers requests
// that left before the service worker listened and pages restored from the
// back-forward cache.
const observed = new Map<string, { readonly requestType: string; readonly mime: string }>();

function reportTiming(entry: PerformanceEntry): void {
  const timing = entry as PerformanceResourceTiming & { contentType?: string; responseStatus?: number };
  const requestType = requestTypeOfTiming(timing.initiatorType);
  if (!requestType || !isAddress(timing.name)) return;
  const status = timing.responseStatus ?? 0;
  if (status !== 0 && status !== 200 && status !== 206) return;
  const mime = (timing.contentType ?? "").slice(0, 200);
  // Without a type, an audio element's file cannot be told from a video's.
  if (!mime && timing.initiatorType === "audio") return;
  if (!worthProbing(timing.name, { via: "request", type: requestType, mime })) return;
  // One entry per playlist, however often a live player reloads it.
  const url = playlistIdentity(withoutHash(timing.name));
  if (observed.has(url)) return;
  if (observed.size >= 100) observed.delete(observed.keys().next().value!);
  observed.set(url, { requestType, mime });
  sendRuntimeEvent({ type: "observed", url, requestType, mime });
}

try {
  new PerformanceObserver(list => {
    if ((document as Document & { prerendering?: boolean }).prerendering) return;
    list.getEntries().forEach(reportTiming);
  }).observe({ type: "resource", buffered: true });
} catch { /* The timeline is a fallback; never disturb the page. */ }

/** After a restore from the back-forward cache or a prerender, the background starts from nothing. */
function reportAgain(): void {
  for (const [url, { requestType, mime }] of observed) sendRuntimeEvent({ type: "observed", url, requestType, mime });
}

// ---------- key use on media elements ----------
// Only an encrypted event or a licence request marks an element as protected.
const keyed = new WeakMap<Element, string | null>();
const keyedReported = new WeakSet<Element>();
let documentKeyReported = false;

function keyedVideo(event: Event): Element | null {
  const target = (event.composedPath?.()[0] ?? event.target) as Element | Document | null;
  if (!target || !("localName" in target)) return null;
  if (target.localName === "video" || target.localName === "audio") return target;
  // A closed shadow root retargets the event to its host: the video is inside.
  const shadow = shadowRootOf(target);
  const inside = shadow ? [...shadow.querySelectorAll("video")] : [];
  return inside.length === 1 ? inside[0]! : null;
}

function reportKeyUse(event: Event, via: "license-request" | "encrypted", keySystem: string | null): void {
  const element = keyedVideo(event);
  if (element) {
    if (keySystem || !keyed.has(element)) keyed.set(element, keySystem ?? keyed.get(element) ?? null);
    if (keyedReported.has(element) && !keySystem) return;
    keyedReported.add(element);
  } else {
    if (documentKeyReported) return;
    documentKeyReported = true;
  }
  const source = element ? (element as HTMLMediaElement).currentSrc || (element as HTMLMediaElement).src || "" : "";
  sendRuntimeEvent({ type: "eme", via, keySystem, elementKey: element ? keyOf(element) : null,
    elementSrc: /^https?:\/\//i.test(source) && source.length <= MAX_URL ? source : null });
}

window.addEventListener("savemedia:eme", event => {
  let keySystem: string | null = null;
  try {
    const detail = JSON.parse(String((event as CustomEvent<unknown>).detail)) as { keySystem?: unknown };
    if (typeof detail.keySystem === "string" && detail.keySystem.length <= 200) keySystem = detail.keySystem;
  } catch { /* A detail without a key system still proves key use. */ }
  reportKeyUse(event, "license-request", keySystem);
}, true);
window.addEventListener("encrypted", event => reportKeyUse(event, "encrypted", null), true);

// ---------- Alt+S ----------
// Chrome handles the registered shortcut before a page sees the key. This
// listener serves key events the browser did not consume, and the "reload
// this page" answer when the extension was reloaded under an open tab. It is
// active only while the command is bound to Alt+S, so a shortcut the user
// changed or cleared never triggers here, and Ctrl+S or Cmd+S never do.
let altS: boolean | null = null;

window.addEventListener("keydown", event => {
  const target = event.target;
  const action = altSAction({ isTrusted: event.isTrusted, repeat: event.repeat, altKey: event.altKey, ctrlKey: event.ctrlKey,
    metaKey: event.metaKey, shiftKey: event.shiftKey, code: event.code,
    editable: target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select")) }, altS);
  if (action === "ignore") return;
  if (action === "take") {
    event.preventDefault();
    event.stopPropagation();
  }
  if (!sendRuntimeEvent({ type: "download-best-hotkey", pageUrl: location.href })) {
    showToast("failed", RECONNECT_HINT);
  }
}, true);

// Alt+S saves what the pointer is over. A frame keeps its record while the
// pointer is inside it or inside one of its child frames.
let pointer: PointerRecord | null = null;

function frameIndexOfElement(element: Element | null): number | null {
  if (!element || (element.localName !== "iframe" && element.localName !== "frame")) return null;
  const child = (element as HTMLIFrameElement).contentWindow;
  for (let index = 0; child && index < window.length; index++) {
    try { if (window[index] === child) return index; } catch { /* A frame that went away. */ }
  }
  return null;
}

// Only the user's own pointer counts. A page script, in any frame, can dispatch pointer events, and the
// newest record decides which frame Alt+S looks in; it cannot make a trusted one.
for (const type of ["pointermove", "pointerover"] as const) {
  window.addEventListener(type, event => {
    if (!event.isTrusted) return;
    pointer = { x: event.clientX, y: event.clientY, at: performance.timeOrigin + performance.now(),
      overFrame: frameIndexOfElement(event.target instanceof Element ? event.target : null) };
  }, { capture: true, passive: true });
}
// No related target: the pointer left this document, or entered a child frame.
window.addEventListener("pointerout", event => {
  if (!event.isTrusted || event.relatedTarget) return;
  const under = document.elementFromPoint(event.clientX, event.clientY);
  const overFrame = frameIndexOfElement(under);
  pointer = overFrame === null ? null
    : { x: event.clientX, y: event.clientY, at: performance.timeOrigin + performance.now(), overFrame };
}, { capture: true, passive: true });

// ---------- lifecycle ----------
function announce(reason: "load" | "restore"): void {
  sendRuntimeEvent({ type: "frame-active", reason, url: location.href }, answer => {
    if (isRecord(answer) && typeof answer.altS === "boolean") altS = answer.altS;
  });
}
if ((document as Document & { prerendering?: boolean }).prerendering) {
  document.addEventListener("prerenderingchange", () => { announce("load"); reportAgain(); }, { once: true });
} else announce("load");
window.addEventListener("pageshow", event => {
  if (!event.persisted) return;
  announce("restore");
  reportAgain();
});

// ---------- requests from the background ----------
chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (!isRecord(msg)) return false;
  if (msg.type === "collect-facts") {
    try {
      sendResponse(collectFrameFacts(document, { pointer: msg.pointer === true, thumbnails: msg.thumbnails === true,
        pointerRecord: pointer, keyOf, keyed, fileSaveProblem: currentProblem() }));
    } catch { sendResponse(null); }
    return false;
  }
  if (isHotkeyFeedbackMessage(msg)) {
    if (window.top === window) showToast(msg.outcome, msg.detail);
    return false;
  }
  if (msg.type === "file-save-state") {
    sendResponse(window.top === window && msg.pageUrl === location.href ? pageFileState(document, location.href, currentProblem()) : null);
    return false;
  }
  if (msg.type === "file-save-problem" && msg.pageUrl === location.href && window.top === window) {
    lastFileSave = isFileSaveProblem(msg.problem) ? { pageUrl: location.href, problem: msg.problem } : null;
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

function currentProblem(): FileSaveProblem | null {
  return lastFileSave?.pageUrl === location.href ? lastFileSave.problem : null;
}

// In-page feedback for Alt+S. The popup is closed when the hotkey fires and
// the action badge is easy to miss, so the page itself confirms what
// happened. Rendered inside a shadow root so page CSS cannot restyle it.
// The host element is kept as a module-level reference (never looked up by
// id) so the page cannot substitute its own element.
//
// The host is built once and stays in the page, empty and invisible between
// toasts: a live region that exists before its text changes is announced
// reliably, one that is inserted together with its text is not. The visible
// card is hidden from assistive technology; two regions inside the shadow
// root carry the announcement, a polite one and one for failures.
interface Toast {
  readonly host: HTMLElement;
  readonly card: HTMLElement;
  readonly dot: HTMLElement;
  readonly label: HTMLElement;
  readonly detail: HTMLElement;
  readonly status: HTMLElement;
  readonly alert: HTMLElement;
}

const TOAST_HOST_STYLE = ["all: initial", "display: block", "position: fixed", "inset: auto 16px 16px auto", "width: auto", "height: auto",
  "margin: 0", "padding: 0", "border: 0", "background: transparent", "overflow: visible", "pointer-events: none", "z-index: 2147483647"]
  .map(rule => `${rule} !important`).join("; ");
const TOAST_STYLE = `
  .t { display: flex; align-items: center; gap: 10px; max-width: 360px;
    padding: 10px 14px; border-radius: 8px; background: #0e1b26; color: #eef3f6;
    font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
    box-shadow: 0 6px 20px rgba(0,0,0,.35); opacity: 0; transform: translateY(6px);
    transition: opacity .18s ease, transform .18s ease; pointer-events: none; }
  .t.show { opacity: 1; transform: none; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .k { font-weight: 600; margin-right: 6px; }
  .d { color: #9fb2be; overflow-wrap: anywhere; }
  .sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @media (prefers-reduced-motion: reduce) { .t { transition: none; } }
`;

let toast: Toast | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toastShown = false;

type PopoverHost = HTMLElement & { showPopover?: () => void; hidePopover?: () => void };

/** A fullscreen element that can hold the toast: one that renders its children. */
function fullscreenContainer(): Element | null {
  const element = document.fullscreenElement;
  return element && !["video", "canvas", "img", "iframe", "audio", "object", "embed"].includes(element.localName) ? element : null;
}

/**
 * Put the toast above everything the page shows, a fullscreen player
 * included. A popover is in the browser's top layer, and opening it again
 * moves it above an element that went fullscreen after it. Without popovers
 * the host is moved into the fullscreen element, when that element can hold it.
 */
function raise(host: PopoverHost): void {
  if (typeof host.showPopover === "function") {
    let open = false;
    try { open = host.matches(":popover-open"); } catch { /* A browser without the selector has no open popover to close. */ }
    try {
      if (open) host.hidePopover?.();
      host.showPopover();
      return;
    } catch { /* The host is not connected, or popovers are not allowed here. */ }
  }
  const parent = fullscreenContainer() ?? document.body;
  if (host.parentNode !== parent) parent.appendChild(host);
}

function buildToast(): Toast | null {
  const host = document.createElement("div") as PopoverHost;
  host.setAttribute("data-savemedia", "feedback");
  let root: ShadowRoot;
  try { root = host.attachShadow({ mode: "open" }); } catch { return null; }
  if (typeof host.showPopover === "function") host.setAttribute("popover", "manual");
  host.setAttribute("style", TOAST_HOST_STYLE);
  const make = (tag: string, className: string): HTMLElement => {
    const element = document.createElement(tag);
    element.className = className;
    return element;
  };
  const style = document.createElement("style");
  style.textContent = TOAST_STYLE;
  const status = make("div", "sr");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  const alert = make("div", "sr");
  alert.setAttribute("role", "alert");
  alert.setAttribute("aria-atomic", "true");
  const card = make("div", "t");
  card.setAttribute("aria-hidden", "true");
  const dot = make("span", "dot");
  const label = make("span", "k");
  const detail = make("span", "d");
  card.append(dot, label, detail);
  root.append(style, status, alert, card);
  document.body.appendChild(host);
  return { host, card, dot, label, detail, status, alert };
}

function showToast(outcome: ToastOutcome, detail: string): void {
  if (!document.body) return;
  if (!toast || !toast.host.isConnected) toast = buildToast();
  if (!toast) return;
  const { host, card, dot, label, status, alert } = toast;
  raise(host);
  dot.style.background = TOAST_TONE[outcome];
  label.textContent = TOAST_LABELS[outcome];
  toast.detail.textContent = detail;
  toastShown = true;
  // Emptied now and filled in the next frame, so the same words are announced again when they are shown again.
  status.textContent = "";
  alert.textContent = "";
  const region = toastUrgency(outcome) === "assertive" ? alert : status;
  requestAnimationFrame(() => {
    if (!toastShown || label.textContent !== TOAST_LABELS[outcome] || toast?.detail.textContent !== detail) return;
    card.classList.add("show");
    region.textContent = `${TOAST_LABELS[outcome]}: ${detail}`;
  });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastShown = false;
    card.classList.remove("show");
    status.textContent = "";
    alert.textContent = "";
  }, toastDuration(outcome));
}

// A player that goes fullscreen while a toast shows would cover it.
document.addEventListener("fullscreenchange", () => {
  if (toastShown && toast?.host.isConnected) raise(toast.host);
});

function isHotkeyFeedbackMessage(value: unknown): value is HotkeyFeedbackMessage {
  return isRecord(value)
    && value.type === "hotkey-feedback"
    && typeof value.outcome === "string" && Object.hasOwn(TOAST_LABELS, value.outcome)
    && typeof value.detail === "string";
}

const FILE_SAVE_STAGES = ["checking", "starting", "transferring"];

/** A file-save problem as the background sends it: a name, a stage, and an error that is null or has a code. */
function isFileSaveProblem(value: unknown): value is FileSaveProblem {
  if (!isRecord(value) || typeof value.filename !== "string" || value.filename.length > 240) return false;
  if (typeof value.stage !== "string" || !FILE_SAVE_STAGES.includes(value.stage)) return false;
  return value.error === null || (isRecord(value.error) && typeof value.error.code === "string" && value.error.code.length <= 80
    && typeof value.error.severity === "string");
}
