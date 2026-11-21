import { describeTransfer, type TransferState } from "../util/transfer-progress";

type IconStyle = "transfer" | "busy" | "retry";
type Active = {jobs: Map<string, TransferState>; icon: string; title: string};

const tabs = new Map<number, Active>();
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
    percent !== undefined || (jobs.length === 1 && jobs[0]!.stage === "downloading") ? "transfer" : "busy";
  const title = "SaveMedia · " + (jobs.length === 1 ? label : jobs.length + " downloads in progress")
    + (percent !== undefined ? " · " + percent + "%" : "");
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

export function toolbarBusy(tabId: number): boolean { return tabs.has(tabId); }

// Active entries contain only counters and stages, and disappear on completion.
export function updateToolbarProgress(tabId: number, id: string, state: TransferState | null): void {
  let active = tabs.get(tabId);
  if (state) {
    if (!active) {
      active = {jobs: new Map(), icon: "", title: ""};
      tabs.set(tabId, active);
      void chrome.action.setBadgeText({tabId, text: ""}).catch(() => undefined);
    }
    active.jobs.set(id, state);
  } else if (!active?.jobs.delete(id)) return;
  if (active.jobs.size) { display(tabId, active); return; }

  tabs.delete(tabId);
  const action = chrome.runtime.getManifest().action!;
  void chrome.action.setIcon({tabId, path: action.default_icon!}).catch(() => undefined);
  void chrome.action.setTitle({tabId, title: action.default_title ?? "savemedia"}).catch(() => undefined);
}

export function forgetToolbarTab(tabId: number): void { tabs.delete(tabId); }
