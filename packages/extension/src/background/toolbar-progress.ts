import { formatBytes } from "@savemedia/core";
import { describeTransfer, type TransferState } from "../util/transfer-progress";
import { TOOLBAR } from "../ui/text";

type IconStyle = "transfer" | "busy" | "retry";
type Active = {jobs: Map<string, TransferState>; icon: string; title: string};

export interface ToolbarNotice { readonly tabId: number; readonly title: string }

const tabs = new Map<number, Active>();
/** Tabs whose icon or title is not the default: stored, so a restarted worker can put the default back. */
const painted = new Set<number>();
/** A tab's notice, by its title. It stays until the tab shows another page: stored, so a restarted worker keeps it. */
const notices = new Map<number, string>();
let onPainted: ((tabs: readonly number[]) => void) | undefined;
let onNotices: ((notices: readonly ToolbarNotice[]) => void) | undefined;

const noticeList = (): ToolbarNotice[] => [...notices].map(([tabId, title]) => ({ tabId, title }));

function setPainted(tabId: number, value: boolean): void {
  if (painted.has(tabId) === value) return;
  if (value) painted.add(tabId); else painted.delete(tabId);
  onPainted?.([...painted]);
}

/** The default icon again, and the default title, or the tab's notice when it has one. */
function reset(tabId: number): void {
  const action = chrome.runtime.getManifest().action!;
  void chrome.action.setIcon({tabId, path: action.default_icon!}).catch(() => undefined);
  if (paintToolbarNotice(tabId)) return;
  void chrome.action.setTitle({tabId, title: action.default_title ?? "savemedia"}).catch(() => undefined);
  setPainted(tabId, false);
}

/** Called with the painted tabs whenever that set changes. */
export function onToolbarPainted(listener: ((tabs: readonly number[]) => void) | undefined): void { onPainted = listener; }

/** Called with the tabs' notices whenever one is set or goes. */
export function onToolbarNotices(listener: ((notices: readonly ToolbarNotice[]) => void) | undefined): void { onNotices = listener; }

/** The painted tabs and the notices of an earlier worker instance. */
export function importToolbar(tabIds: readonly number[], stored: readonly ToolbarNotice[] = []): void {
  for (const tabId of tabIds) painted.add(tabId);
  for (const notice of stored) notices.set(notice.tabId, notice.title);
}

/** After a worker restart: a painted tab without a running transfer gets the default icon back, and its title or its notice. */
export function resetStaleToolbar(): void {
  for (const tabId of [...painted]) if (!tabs.has(tabId)) reset(tabId);
}

/**
 * Paint the tab's notice, when it has one and no transfer shows on the
 * button: a "!" badge and the reason as the button's title. Whoever sets the
 * tab's badge asks here first, so the notice is not painted over.
 */
export function paintToolbarNotice(tabId: number): boolean {
  const title = notices.get(tabId);
  if (title === undefined || tabs.has(tabId)) return false;
  void chrome.action.setBadgeBackgroundColor({tabId, color: "#d97706"}).catch(() => undefined);
  void chrome.action.setBadgeText({tabId, text: "!"}).catch(() => undefined);
  void chrome.action.setTitle({tabId, title}).catch(() => undefined);
  setPainted(tabId, true);
  return true;
}

/** A notice on a tab's toolbar button until the tab shows another page. While a transfer runs, it shows once the transfer ended. */
export function showToolbarNotice(tabId: number, title: string): void {
  if (notices.get(tabId) !== title) {
    notices.set(tabId, title);
    onNotices?.(noticeList());
  }
  paintToolbarNotice(tabId);
}

/** The tab shows another page: a notice of the old one goes. A running transfer keeps the button. */
export function clearToolbarNotice(tabId: number): void {
  if (notices.delete(tabId)) onNotices?.(noticeList());
  if (painted.has(tabId) && !tabs.has(tabId)) reset(tabId);
}

/** For tests. */
export function resetToolbarState(): void { tabs.clear(); painted.clear(); notices.clear(); flashes.clear(); onPainted = undefined; onNotices = undefined; artwork = undefined; }
let artwork: Promise<ImageBitmap> | undefined;

function draw(base: ImageBitmap, size: number, style: IconStyle, fraction: number | undefined): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(size / 16, size / 16);
  ctx.drawImage(base, 1, 0, 14, 13);
  ctx.fillStyle = "#0e1b26";
  ctx.fillRect(0, 12, 16, 4);
  ctx.fillStyle = "#536574";
  ctx.fillRect(1, 13, 14, 2);
  ctx.fillStyle = style === "retry" ? "#ffb54d" : style === "busy" ? "#c4b5fd" : "#49d8ff";
  if (fraction !== undefined) ctx.fillRect(1, 13, Math.round(14 * fraction), 2);
  else for (const x of [1, 6, 11]) ctx.fillRect(x, 13, 3, 2);
  return ctx.getImageData(0, 0, size, size);
}

function display(tabId: number, active: Active): void {
  const jobs = [...active.jobs.values()];
  const {label, percent: singlePercent, retrying} = describeTransfer(jobs[0]!);
  const allMeasured = jobs.every(job => job.bytesTotal && describeTransfer(job).percent !== undefined);
  const percent = jobs.length === 1 ? singlePercent : allMeasured
    ? Math.round(100 * jobs.reduce((n, job) => n + (job.bytesWritten ?? 0), 0) / jobs.reduce((n, job) => n + job.bytesTotal!, 0))
    : undefined;
  const style: IconStyle = jobs.length === 1 && retrying ? "retry" :
    percent !== undefined || (jobs.length === 1 && jobs[0]!.stage?.kind === "downloading") ? "transfer" : "busy";
  const title = jobs.length === 1 ? TOOLBAR.one(label, progressText(jobs[0]!, percent)) : TOOLBAR.several(jobs.length, percent);
  if (active.title !== title) {
    active.title = title;
    void chrome.action.setTitle({tabId, title}).catch(() => undefined);
  }
  // At toolbar size only fourteen different lengths are legible. Update on
  // changes reported by the transfer, without repainting on a timer.
  const steps = percent === undefined ? undefined : Math.min(14, Math.max(0, Math.round(14 * percent / 100)));
  const icon = style + "/" + steps;
  if (icon === active.icon) return;
  active.icon = icon;
  artwork ??= fetch(chrome.runtime.getURL("icons/icon-48.png")).then(r => r.blob()).then(blob => createImageBitmap(blob))
    .catch(err => { artwork = undefined; throw err; });
  void artwork.then(base => {
    if (tabs.get(tabId) !== active || active.icon !== icon) return;
    const fraction = steps === undefined ? undefined : steps / 14;
    return chrome.action.setIcon({tabId, imageData: {16: draw(base, 16, style, fraction), 32: draw(base, 32, style, fraction)}});
  }).catch(() => { if (active.icon === icon) active.icon = ""; });
}

/** "42% of 1.20 GB" when the size is known, "12.0 MB received" when only bytes are, a bare percent for a share without bytes. */
function progressText(job: TransferState, percent: number | undefined): string | null {
  if (percent !== undefined && job.bytesTotal) return `${percent}% of ${formatBytes(job.bytesTotal)}`;
  if (percent !== undefined) return `${percent}%`;
  return job.bytesWritten ? describeTransfer(job).bytesText : null;
}

export function toolbarBusy(tabId: number): boolean { return tabs.has(tabId); }

/** Tabs whose button shows an Alt+S result for a moment. */
const flashes = new Map<number, object>();

/**
 * The result of an Alt+S press on the tab's button: a badge and a title, for
 * as long as the toast shows. A running transfer and a notice keep the
 * button. Returns what ends the flash, or null when nothing was painted.
 */
export function flashToolbar(tabId: number, badge: { readonly text: string; readonly color: string }, title: string): (() => boolean) | null {
  if (tabs.has(tabId) || notices.has(tabId)) return null;
  const token = {};
  flashes.set(tabId, token);
  void chrome.action.setBadgeBackgroundColor({tabId, color: badge.color}).catch(() => undefined);
  void chrome.action.setBadgeText({tabId, text: badge.text}).catch(() => undefined);
  void chrome.action.setTitle({tabId, title}).catch(() => undefined);
  setPainted(tabId, true);
  // True when this flash was still the button's last word: the caller then puts the count back.
  return () => {
    if (flashes.get(tabId) !== token) return false;
    flashes.delete(tabId);
    if (tabs.has(tabId)) return false;
    reset(tabId);
    return true;
  };
}

// Active entries contain only counters and stages, and disappear on completion.
export function updateToolbarProgress(tabId: number, id: string, state: TransferState | null): void {
  let active = tabs.get(tabId);
  if (state) {
    if (!active) {
      active = {jobs: new Map(), icon: "", title: ""};
      tabs.set(tabId, active);
      setPainted(tabId, true);
      void chrome.action.setBadgeText({tabId, text: ""}).catch(() => undefined);
    }
    active.jobs.set(id, state);
  } else if (!active?.jobs.delete(id)) return;
  if (active.jobs.size) { display(tabId, active); return; }

  tabs.delete(tabId);
  reset(tabId);
}

export function forgetToolbarTab(tabId: number): void {
  tabs.delete(tabId);
  flashes.delete(tabId);
  if (notices.delete(tabId)) onNotices?.(noticeList());
  setPainted(tabId, false);
}
