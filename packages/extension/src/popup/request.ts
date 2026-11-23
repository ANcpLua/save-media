// How the popup talks to the background. Every request gets one answer or
// null: null when the background could not be reached (the extension was
// reloaded while the popup is open), when its handler failed, or when the
// reply is not the reply this request has. The caller keeps what it shows.
import { VIEW_PORT, parsePopupReply, type PopupReply, type PopupRequest, type ViewMessage } from "../types/messages";

export function ask<T extends PopupRequest["type"]>(msg: Extract<PopupRequest, { type: T }>, answer: (reply: PopupReply<T> | null) => void): void {
  let answered = false;
  const once = (reply: PopupReply<T> | null): void => {
    if (answered) return;
    answered = true;
    answer(reply);
  };
  try {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.sendMessage) { once(null); return; }
    runtime.sendMessage(msg, (reply: unknown) => {
      // Reading lastError is what tells the browser the failure was seen.
      if (runtime.lastError) { once(null); return; }
      once(parsePopupReply(msg.type, reply));
    });
  } catch {
    once(null);
  }
}

/** ask() as a promise. */
export function request<T extends PopupRequest["type"]>(msg: Extract<PopupRequest, { type: T }>): Promise<PopupReply<T> | null> {
  return new Promise(resolve => ask(msg, resolve));
}

/**
 * A runtime message reaches every extension page, also one a page's content
 * script sent. What the popup acts on comes from the background, which has
 * no tab.
 */
export function fromBackground(sender: { readonly id?: string | undefined; readonly tab?: unknown } | undefined): boolean {
  if (!sender) return true;
  return sender.tab === undefined && (sender.id === undefined || sender.id === globalThis.chrome?.runtime?.id);
}

export interface View {
  /** Tell the background which tab this popup shows now. */
  show(tabId: number | null): void;
  close(): void;
}

/**
 * The port that tells the background a popup is open and which tab it
 * shows: the background sends a tab's list only to views of that tab. When
 * the background restarts, the port is opened again.
 */
export function openView(): View {
  let port: chrome.runtime.Port | null = null;
  let shown: number | null = null;
  let closed = false;
  function connect(): void {
    if (closed || port) return;
    try {
      const opened = globalThis.chrome?.runtime?.connect?.({ name: VIEW_PORT });
      if (!opened) return;
      port = opened;
      opened.onDisconnect?.addListener(() => {
        void globalThis.chrome?.runtime?.lastError;
        if (port !== opened) return;
        port = null;
        connect();
      });
      opened.postMessage({ type: "view", tabId: shown } satisfies ViewMessage);
    } catch {
      port = null;
    }
  }
  connect();
  return {
    show(tabId) {
      shown = tabId;
      if (!port) { connect(); return; }
      try { port.postMessage({ type: "view", tabId } satisfies ViewMessage); }
      catch { port = null; connect(); }
    },
    close() {
      closed = true;
      try { port?.disconnect(); } catch { /* already closed */ }
      port = null;
    },
  };
}
