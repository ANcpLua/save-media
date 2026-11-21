import { useEffect, useState } from "react";
import { NATIVE_HOST_NAME } from "../../types/native";

declare const __BROWSER__: "chromium" | "firefox";

const setting = "desktopFileConnection";
const permission = { permissions: ["nativeMessaging" as const] };

export function canRecoverFile(error?: { code: string } | null): boolean {
  return !!error && (error.code === "tls_certificate_rejected" || error.code === "network_unreachable");
}

/** Only the extra connection is enabled. The yt-dlp downloader keeps its own opt-in. */
export function useLocalConnection() {
  const supported = (typeof __BROWSER__ === "undefined" || __BROWSER__ === "chromium")
    && !!globalThis.chrome?.permissions?.request
    && !!globalThis.chrome?.storage?.local;
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (!supported) return;
    let active = true;
    let revision = 0;
    function read() {
      const current = ++revision;
      void Promise.all([chrome.storage.local.get(setting), chrome.permissions.contains(permission)])
        .then(([data, granted]) => {
          if (active && current === revision) setEnabled(data[setting] === true && granted);
        }).catch(() => { if (active && current === revision) setEnabled(null); });
    }
    function storageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
      if (area === "local" && setting in changes) read();
    }
    function permissionsChanged(update: chrome.permissions.Permissions) {
      if (update.permissions?.includes("nativeMessaging")) read();
    }
    chrome.storage.onChanged.addListener(storageChanged);
    chrome.permissions.onRemoved.addListener(permissionsChanged);
    chrome.permissions.onAdded.addListener(permissionsChanged);
    read();
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(storageChanged);
      chrome.permissions.onRemoved.removeListener(permissionsChanged);
      chrome.permissions.onAdded.removeListener(permissionsChanged);
    };
  }, [supported]);

  async function enable(): Promise<string | null> {
    try {
      // This must happen in the original click gesture, before any other await.
      if (!await chrome.permissions.request(permission)) return "Allow Chrome to connect to the SaveMedia helper to use this option.";
    } catch {
      return "Chrome couldn’t grant access to the SaveMedia helper.";
    }
    try {
      const reply = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { type: "file-connection-status" });
      if (reply?.type !== "file-connection-status" || reply.version !== 1) {
        return "Update the SaveMedia helper on this computer, then try again.";
      }
    } catch {
      return "Chrome couldn’t open the SaveMedia helper. Install it for this copy of the extension, then try again.";
    }
    try {
      await chrome.storage.local.set({ [setting]: true });
      setEnabled(true);
      return null;
    } catch {
      return "Chrome couldn’t remember this setting. Try again.";
    }
  }

  async function disable(): Promise<void> {
    await chrome.storage.local.remove(setting);
    setEnabled(false);
  }
  return { enabled, enable, disable };
}

export type LocalConnection = ReturnType<typeof useLocalConnection>;

export function LocalConnectionAction({ connection, retry }: { connection: LocalConnection; retry: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function connect() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const issue = await connection.enable();
      if (issue) setMessage(issue);
      else retry();
    } finally { setBusy(false); }
  }
  if (connection.enabled !== false) return null;
  return <div className="mt-2 text-xs">
    <p className="text-muted">SaveMedia’s helper can ask Cloudflare for the file server’s address and download directly from the site. This applies to future file saves too.</p>
    <button type="button" disabled={busy} onClick={connect}
      className="mt-2 rounded-md bg-surface-2 px-2.5 py-1 font-medium text-white hover:brightness-110 disabled:opacity-60">
      {busy ? "Connecting…" : "Use local connection"}
    </button>
    {message && <p role="status" className="mt-1 text-orange-300">{message}</p>}
  </div>;
}
