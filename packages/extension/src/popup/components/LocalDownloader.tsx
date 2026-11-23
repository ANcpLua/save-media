import { useEffect, useRef, useState } from "react";
import {
  parseBroadcast,
  type LocalJobView,
  type LocalSettingsValue,
  type PopupRequest,
  type PopupToBackgroundMessage,
} from "../../types/messages";
import { formatBytes } from "@savemedia/core";
import { LOCAL_QUALITIES, helperOutdated, type HostPong } from "../../types/native";
import { FailureMessage } from "./FailureMessage";
import { TransferProgress } from "./TransferProgress";
import { describeTransfer, localTransfer } from "../../util/transfer-progress";
import { CheckIcon, ChevronIcon, DownloadIcon } from "./Icons";
import { useAnnounce } from "./Announcer";
import { ask, fromBackground } from "../request";
import { ANNOUNCE, LOCAL, NAMES_SETUP_COMMAND, localFailureMessage } from "../../ui/text";

interface Status {
  readonly settings: LocalSettingsValue;
  readonly host: HostPong | null;
  readonly permissionGranted: boolean;
  readonly jobs: readonly LocalJobView[];
}

interface Props {
  readonly tabId: number | null;
  readonly pageUrl: string | null;
  readonly initialStatus?: Status | undefined;
  readonly skipFetch?: boolean;
  /** Told whether the Local downloader is off, ready, or on but not usable, so a failure it may handle can offer it. */
  readonly onAvailability?: ((state: "off" | "ready" | "unavailable") => void) | undefined;
}

const COOKIE_OPTIONS: readonly { readonly value: LocalSettingsValue["cookies"]; readonly label: string }[] = [
  { value: "auto", label: LOCAL.cookiesAuto },
  { value: "none", label: LOCAL.cookiesNone },
  // The browsers whose cookie store yt-dlp can read: a choice of cookie source, not a claim about any site.
  { value: "chrome", label: "Chrome" },
  { value: "chromium", label: "Chromium" },
  { value: "edge", label: "Edge" },
  { value: "brave", label: "Brave" },
  { value: "firefox", label: "Firefox" },
];

function requestNativePermission(): Promise<boolean> {
  // Must be the first call in the click handler: Firefox drops the user
  // gesture as soon as the handler awaits anything. request() resolves true
  // without a prompt when the permission is already granted.
  try {
    const perms = globalThis.chrome?.permissions;
    if (!perms) return Promise.resolve(true);
    return perms.request({ permissions: ["nativeMessaging"] }).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

/** The requests this section makes. Each is answered with the Local downloader's status. */
type LocalRequest = Extract<PopupRequest, { type: "local-status" | "local-settings" | "local-download" | "local-cancel" }>;

const SETUP_URL = "https://raw.githubusercontent.com/ANcpLua/save-media/main/packages/native-host/setup.sh";

function setupCommand(): string {
  const id = globalThis.chrome?.runtime?.id ?? "<extension-id>";
  return `curl -fsSL ${SETUP_URL} | bash -s -- --extension-id ${id}`;
}

function CopyLine({ command, testId }: { readonly command: string; readonly testId: string }) {
  const [copied, setCopied] = useState(false);
  const announce = useAnnounce();
  function copy(): void {
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(true);
      announce(ANNOUNCE.copied);
      setTimeout(() => setCopied(false), 1_500);
    }).catch(() => undefined);
  }
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1.5">
      <code className="flex-1 truncate text-[11px] text-neutral-200" title={command} data-testid={testId}>{command}</code>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded bg-accent text-ink font-medium px-2 py-0.5 text-[11px] hover:brightness-110"
        data-testid={`${testId}-copy`}
      >
        {copied ? LOCAL.copied : LOCAL.copy}
      </button>
    </div>
  );
}

export function LocalDownloader({ tabId, pageUrl, initialStatus, skipFetch = false, onAvailability }: Props) {
  const [status, setStatus] = useState<Status | null>(initialStatus ?? null);
  const [open, setOpen] = useState(initialStatus?.settings.enabled ?? false);
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState(false);
  const announce = useAnnounce();
  /** The tab and page this view shows now: what a job message must name to be said aloud. */
  const shownPage = useRef({ tabId, pageUrl });
  shownPage.current = { tabId, pageUrl };

  useEffect(() => {
    if (skipFetch) return;
    ask({ type: "local-status" }, s => {
      setRequestError(!s);
      if (!s) return;
      setStatus(s);
      setOpen(s.settings.enabled);
    });
  }, [skipFetch]);

  useEffect(() => {
    function listener(raw: unknown, sender?: chrome.runtime.MessageSender): void {
      const msg = fromBackground(sender) ? parseBroadcast(raw) : null;
      if (msg?.type !== "local-job") return;
      // A job that ends while the popup is open is said once. One that had ended before is only shown.
      // Job updates reach every open view: only a job of the tab and page shown here, which the list below shows, is said aloud.
      const shown = msg.job.tabId === shownPage.current.tabId && msg.job.pageUrl === shownPage.current.pageUrl;
      if (shown && msg.job.phase === "complete") announce(ANNOUNCE.saved(msg.job.filename ?? undefined));
      else if (shown && msg.job.phase === "failed" && msg.job.failure) {
        if (msg.job.failure.code === "cancelled") announce(ANNOUNCE.cancelled);
        else announce(ANNOUNCE.failure(localFailureMessage(msg.job.failure)), "assertive");
      }
      setStatus(prev => {
        if (!prev) return prev;
        const others = prev.jobs.filter(j => j.id !== msg.job.id);
        return { ...prev, jobs: [...others, msg.job] };
      });
    }
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [announce]);

  const availability = !(status?.settings.enabled ?? false) ? "off"
    : status?.host && !helperOutdated(status.host) && status.host.ytdlp.found && status.host.ffmpeg.found ? "ready" : "unavailable";
  useEffect(() => { onAvailability?.(availability); }, [availability, onAvailability]);

  function update(msg: LocalRequest): void {
    setBusy(true);
    ask<LocalRequest["type"]>(msg, s => {
      setRequestError(!s);
      if (s) setStatus(s);
      setBusy(false);
    });
  }

  function patch(p: Partial<LocalSettingsValue>): void {
    update({ type: "local-settings", patch: p });
  }

  function toggleEnabled(): void {
    const next = !(status?.settings.enabled ?? false);
    setOpen(true);
    if (!next) {
      patch({ enabled: false });
      return;
    }
    // The optional permission must be requested from the user gesture in
    // the popup itself; Firefox does not carry the gesture across
    // runtime.sendMessage. Background re-checks with permissions.contains.
    setBusy(true);
    void requestNativePermission().then(granted => {
      setBusy(false);
      if (granted) patch({ enabled: true });
    });
  }

  function downloadHere(): void {
    if (!pageUrl) return;
    update({ type: "local-download", tabId, pageUrl });
  }

  const enabled = status?.settings.enabled ?? false;
  const host = status?.host ?? null;
  /** The installed helper speaks an earlier protocol than this extension: it is not used until the user updated it. */
  const outdated = enabled && host !== null && helperOutdated(host);
  const ready = enabled && host !== null && !outdated && host.ytdlp.found && host.ffmpeg.found;
  const jobs = (status?.jobs ?? []).filter(job => job.tabId === tabId && job.pageUrl === pageUrl).reverse();
  const activeJob = jobs.find(j => j.phase !== "complete" && j.phase !== "failed");

  return (
    <section className="px-3 pt-3 pb-2" data-testid="local-downloader">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="text-[11px] font-medium text-muted flex items-center gap-1.5"
          aria-expanded={open}
        >
          <ChevronIcon open={open}/>
          {LOCAL.title}
        </button>
        <StatusPill enabled={enabled} host={host} />
        <label className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-muted cursor-pointer">
          <input
            type="checkbox"
            className="accent-accent"
            checked={enabled}
            disabled={busy || status === null}
            onChange={toggleEnabled}
            data-testid="local-enable"
          />
          {LOCAL.enable}
        </label>
      </div>

      {open && (
        <div className="mt-2 space-y-2 text-xs">
          {requestError && <p className="text-orange-300" data-testid="local-lost-contact">{LOCAL.lostContact}</p>}
          {!enabled && <p className="text-muted leading-relaxed">{LOCAL.about}</p>}

          {enabled && host === null && (
            <div className="space-y-1.5" data-testid="local-host-missing">
              <p className="text-amber-500">{LOCAL.installHelper}</p>
              <CopyLine command={setupCommand()} testId="local-setup-command" />
            </div>
          )}
          {outdated && (
            <div className="space-y-1.5" data-testid="local-host-outdated">
              <p className="text-amber-500">{LOCAL.updateHelper}</p>
              <CopyLine command={setupCommand()} testId="local-setup-command" />
            </div>
          )}
          {enabled && host && !outdated && (!host.ytdlp.found || !host.ffmpeg.found) && (
            <div className="space-y-1.5" data-testid="local-tools-missing">
              <p className="text-amber-500">
                {LOCAL.toolsNeeded([...(host.ytdlp.found ? [] : ["yt-dlp"]), ...(host.ffmpeg.found ? [] : ["ffmpeg"])])}
              </p>
              <CopyLine command={`brew install ${[!host.ytdlp.found && "yt-dlp", !host.ffmpeg.found && "ffmpeg"].filter(Boolean).join(" ")}`} testId="local-brew-command" />
            </div>
          )}
          {ready && (
            <p className="text-muted" data-testid="local-host-ready">
              {LOCAL.ready(host.ytdlp.version, host.ffmpeg.version)}<code>{host.outputDir}</code>
            </p>
          )}

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-0.5 text-muted">
              {LOCAL.quality}
              <select
                className="bg-surface-2 rounded-md px-1.5 py-1 text-[12px]"
                value={status?.settings.quality ?? "best"}
                disabled={!enabled || busy}
                onChange={e => patch({ quality: e.target.value as LocalSettingsValue["quality"] })}
                data-testid="local-quality"
              >
                {LOCAL_QUALITIES.map(q => (
                  <option key={q} value={q}>{q === "best" ? LOCAL.qualityBest : LOCAL.qualityUpTo(q)}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-0.5 text-muted">
              {LOCAL.cookies}
              <select
                className="bg-surface-2 rounded-md px-1.5 py-1 text-[12px]"
                value={status?.settings.cookies ?? "auto"}
                disabled={!enabled || busy}
                onChange={e => patch({ cookies: e.target.value as LocalSettingsValue["cookies"] })}
                data-testid="local-cookies"
              >
                {COOKIE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>

          <label className="flex items-center gap-1.5 text-muted cursor-pointer">
            <input
              type="checkbox"
              className="accent-accent"
              checked={status?.settings.fallbackOnHotkey ?? true}
              disabled={!enabled || busy}
              onChange={e => patch({ fallbackOnHotkey: e.target.checked })}
              data-testid="local-fallback"
            />
            {LOCAL.fallback}
          </label>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={downloadHere}
              disabled={!ready || busy || !pageUrl || activeJob !== undefined}
              className="ml-auto inline-flex items-center gap-1 bg-accent hover:brightness-110 disabled:opacity-40 disabled:hover:brightness-100 text-ink font-medium px-2.5 py-1 rounded-md text-xs"
              data-testid="local-download-page"
            >
              <DownloadIcon/> {LOCAL.savePage}
            </button>
          </div>

          {jobs.length > 0 && (
            <ul className="space-y-1.5" data-testid="local-jobs">
              {/* The section above shows the setup command while the helper is missing or outdated: a failure does not repeat it. */}
              {jobs.slice(0, 4).map(job => <JobRow key={job.id} job={job} setupShown={(enabled && host === null) || outdated} />)}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** What stands between the user and a local save, shown only while the Local downloader is on. The switch itself says off. */
function StatusPill({ enabled, host }: { readonly enabled: boolean; readonly host: HostPong | null }) {
  if (!enabled) return null;
  let label: string;
  let cls: string;
  if (host === null) {
    label = LOCAL.pillNoHelper;
    cls = "bg-amber-600/90 text-white";
  } else if (helperOutdated(host)) {
    label = LOCAL.pillOutdated;
    cls = "bg-amber-600/90 text-white";
  } else if (!host.ytdlp.found || !host.ffmpeg.found) {
    label = LOCAL.pillToolsMissing;
    cls = "bg-amber-600/90 text-white";
  } else {
    label = LOCAL.pillReady;
    cls = "bg-emerald-600/90 text-white";
  }
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium ${cls}`} data-testid="local-status-pill">
      {label}
    </span>
  );
}

function JobRow({ job, setupShown }: { readonly job: LocalJobView; readonly setupShown: boolean }) {
  const name = job.filename ?? hostOf(job.pageUrl);
  if (job.phase === "complete") {
    return <li className="text-emerald-400 truncate flex items-center gap-1" data-testid="local-job-complete"><CheckIcon/>{LOCAL.saved(name)}</li>;
  }
  if (job.phase === "failed" && job.failure) {
    // The user's own cancel is a neutral end, not a failure.
    if (job.failure.code === "cancelled") return <li className="text-muted" data-testid="local-job-cancelled">{localFailureMessage(job.failure).title}</li>;
    // A hint that names the setup command comes with the command.
    const setup = NAMES_SETUP_COMMAND.has(job.failure.code) && !setupShown
      ? <div className="mt-1"><CopyLine command={setupCommand()} testId="local-job-setup-command"/></div> : undefined;
    return <li><FailureMessage testId="local-job-failed" message={localFailureMessage(job.failure)} extra={setup}/></li>;
  }
  // The stage, the bar and the bytes are drawn as for every other save, from the same state the toolbar button shows.
  const transfer = localTransfer(job);
  const { percent } = describeTransfer(transfer);
  // What only the downloader reports: its speed and the time it expects to need.
  const pace = [percent === undefined ? null : `${percent}%`, job.speedBytesPerSec ? `${formatBytes(job.speedBytesPerSec)}/s` : null,
    job.etaSeconds !== null ? formatEta(job.etaSeconds) : null].filter(Boolean).join(" · ");
  return (
    <li data-testid="local-job-active">
      <div className="flex items-center justify-between text-muted">
        <span className="truncate" data-testid="local-job-name">{name}</span>
        {pace && <span className="tabular-nums shrink-0 ml-2" data-testid="local-job-pace">{pace}</span>}
      </div>
      <div className="flex items-end gap-2">
        <div className="flex-1 min-w-0"><TransferProgress status={transfer}/></div>
        <button
          type="button"
          onClick={() => chrome.runtime.sendMessage({ type: "local-cancel", id: job.id } satisfies PopupToBackgroundMessage, () => void chrome.runtime.lastError)}
          className="bg-surface-2 hover:bg-neutral-600 text-white px-2 py-0.5 rounded-md text-[11px]"
        >
          {LOCAL.cancel}
        </button>
      </div>
    </li>
  );
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function formatEta(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
