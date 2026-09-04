import { useEffect, useState } from "react";
import {
  isBackgroundToPopupMessage,
  type LocalJobView,
  type LocalSettingsValue,
  type PopupToBackgroundMessage,
} from "../../types/messages";
import { LOCAL_QUALITIES, localFailureText, type HostPong } from "../../types/native";

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
}

const COOKIE_OPTIONS: readonly { readonly value: LocalSettingsValue["cookies"]; readonly label: string }[] = [
  { value: "auto", label: "This browser" },
  { value: "none", label: "No cookies" },
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

function send(msg: PopupToBackgroundMessage, cb?: (status: Status) => void): void {
  chrome.runtime.sendMessage(msg, (response: unknown) => {
    void chrome.runtime.lastError;
    if (cb && isBackgroundToPopupMessage(response) && response.type === "local-status") {
      cb({ settings: response.settings, host: response.host, permissionGranted: response.permissionGranted, jobs: response.jobs });
    }
  });
}

const SETUP_URL = "https://raw.githubusercontent.com/ANcpLua/save-media/main/packages/native-host/setup.sh";

function setupCommand(): string {
  const id = globalThis.chrome?.runtime?.id ?? "<extension-id>";
  return `curl -fsSL ${SETUP_URL} | bash -s -- --extension-id ${id}`;
}

function CopyLine({ command, testId }: { readonly command: string; readonly testId: string }) {
  const [copied, setCopied] = useState(false);
  function copy(): void {
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(true);
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
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function LocalDownloader({ tabId, pageUrl, initialStatus, skipFetch = false }: Props) {
  const [status, setStatus] = useState<Status | null>(initialStatus ?? null);
  const [open, setOpen] = useState(initialStatus?.settings.enabled ?? false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (skipFetch) return;
    send({ type: "local-status" }, s => {
      setStatus(s);
      setOpen(s.settings.enabled);
    });
  }, [skipFetch]);

  useEffect(() => {
    function listener(msg: unknown): void {
      if (!isBackgroundToPopupMessage(msg) || msg.type !== "local-job") return;
      setStatus(prev => {
        if (!prev) return prev;
        const others = prev.jobs.filter(j => j.id !== msg.job.id);
        return { ...prev, jobs: [...others, msg.job] };
      });
    }
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  function patch(p: Partial<LocalSettingsValue>): void {
    setBusy(true);
    send({ type: "local-settings", patch: p }, s => {
      setStatus(s);
      setBusy(false);
    });
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
    setBusy(true);
    send({ type: "local-download", tabId, pageUrl }, s => {
      setStatus(s);
      setBusy(false);
    });
  }

  const enabled = status?.settings.enabled ?? false;
  const host = status?.host ?? null;
  const ready = enabled && host !== null && host.ytdlp.found && host.ffmpeg.found;
  const jobs = [...(status?.jobs ?? [])].reverse();
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
          <span aria-hidden="true">{open ? "▼" : "▶"}</span>
          Local downloader
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
          On
        </label>
      </div>

      {open && (
        <div className="mt-2 space-y-2 text-xs">
          <p className="text-muted leading-relaxed">
            Saves videos the browser cannot, using a small helper on this computer. Nothing is bundled and protected media is refused.
          </p>

          {enabled && host === null && (
            <div className="space-y-1.5" data-testid="local-host-missing">
              <p className="text-amber-500">The helper is not installed yet. Paste this into Terminal, then reopen this popup:</p>
              <CopyLine command={setupCommand()} testId="local-setup-command" />
            </div>
          )}
          {enabled && host && (!host.ytdlp.found || !host.ffmpeg.found) && (
            <div className="space-y-1.5" data-testid="local-tools-missing">
              <p className="text-amber-500">
                Still needed on this computer: {[!host.ytdlp.found && "yt-dlp", !host.ffmpeg.found && "ffmpeg"].filter(Boolean).join(" and ")}. Paste this into Terminal:
              </p>
              <CopyLine command={`brew install ${[!host.ytdlp.found && "yt-dlp", !host.ffmpeg.found && "ffmpeg"].filter(Boolean).join(" ")}`} testId="local-brew-command" />
            </div>
          )}
          {ready && (
            <p className="text-muted" data-testid="local-host-ready">
              yt-dlp {host.ytdlp.version ?? "?"} · ffmpeg {host.ffmpeg.version ?? "?"} · saves to <code>{host.outputDir}</code>
            </p>
          )}

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-0.5 text-muted">
              Quality
              <select
                className="bg-surface-2 rounded-md px-1.5 py-1 text-[12px]"
                value={status?.settings.quality ?? "best"}
                disabled={!enabled || busy}
                onChange={e => patch({ quality: e.target.value as LocalSettingsValue["quality"] })}
                data-testid="local-quality"
              >
                {LOCAL_QUALITIES.map(q => (
                  <option key={q} value={q}>{q === "best" ? "Best available" : `Up to ${q}p`}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-0.5 text-muted">
              Cookies
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
            Use for Alt+S when the browser engine cannot save the page
          </label>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={downloadHere}
              disabled={!ready || busy || !pageUrl || activeJob !== undefined}
              className="ml-auto inline-flex items-center gap-1 bg-accent hover:brightness-110 disabled:opacity-40 disabled:hover:brightness-100 text-ink font-medium px-2.5 py-1 rounded-md text-xs"
              data-testid="local-download-page"
            >
              <span aria-hidden="true">⇣</span> Save this page locally
            </button>
          </div>

          {jobs.length > 0 && (
            <ul className="space-y-1.5" data-testid="local-jobs">
              {jobs.slice(0, 4).map(job => <JobRow key={job.id} job={job} />)}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function StatusPill({ enabled, host }: { readonly enabled: boolean; readonly host: HostPong | null }) {
  let label: string;
  let cls: string;
  if (!enabled) {
    label = "Off";
    cls = "bg-surface-2 text-muted";
  } else if (host === null) {
    label = "Host missing";
    cls = "bg-amber-600/90 text-white";
  } else if (!host.ytdlp.found || !host.ffmpeg.found) {
    label = "Tools missing";
    cls = "bg-amber-600/90 text-white";
  } else {
    label = "Ready";
    cls = "bg-emerald-600/90 text-white";
  }
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium ${cls}`} data-testid="local-status-pill">
      {label}
    </span>
  );
}

function JobRow({ job }: { readonly job: LocalJobView }) {
  const name = job.filename ?? hostOf(job.pageUrl);
  if (job.phase === "complete") {
    return <li className="text-emerald-400 truncate" data-testid="local-job-complete">✓ Saved {name}</li>;
  }
  if (job.phase === "failed" && job.failure) {
    const text = localFailureText(job.failure.code, job.failure.message);
    return (
      <li className="text-red-400" data-testid="local-job-failed">
        <p className="font-medium">{text.title}</p>
        <p className="text-muted mt-0.5">{text.body}</p>
      </li>
    );
  }
  const width = job.percent !== null ? `${Math.max(2, Math.min(100, job.percent))}%` : "20%";
  return (
    <li data-testid="local-job-active">
      <div className="flex items-center justify-between text-muted">
        <span className="truncate">{phaseLabel(job.phase)} · {name}</span>
        <span className="tabular-nums shrink-0 ml-2">
          {job.percent !== null ? `${job.percent.toFixed(0)}%` : ""}
          {job.speedBytesPerSec ? ` · ${formatBytes(job.speedBytesPerSec)}/s` : ""}
          {job.etaSeconds !== null ? ` · ${formatEta(job.etaSeconds)}` : ""}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <div className="flex-1 h-1 rounded bg-surface-2 overflow-hidden">
          <div className="h-full bg-blue-600 transition-all" style={{ width }} />
        </div>
        <button
          type="button"
          onClick={() => chrome.runtime.sendMessage({ type: "local-cancel", id: job.id } satisfies PopupToBackgroundMessage, () => void chrome.runtime.lastError)}
          className="bg-surface-2 hover:bg-neutral-600 text-white px-2 py-0.5 rounded-md text-[11px]"
        >
          Cancel
        </button>
      </div>
    </li>
  );
}

function phaseLabel(phase: LocalJobView["phase"]): string {
  switch (phase) {
    case "probing": return "Resolving";
    case "downloading": return "Downloading";
    case "merging": return "Merging";
    default: return phase;
  }
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n.toFixed(0)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatEta(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
