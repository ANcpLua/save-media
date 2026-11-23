// The one listener for runtime messages. Who sent a message decides what it
// may be: a popup request, a page's bridge message, or nothing. A content
// script can be made to send anything, so a popup request from a tab's
// content script is not answered at all. Every popup request gets exactly
// one reply, also when its handler fails.
import {
  REQUEST_FAILED, parseBridgeRequest, parsePopupRequest,
  type BridgeToBackgroundMessage, type PopupReply, type PopupRequest,
} from "../types/messages";
import type { Logger } from "../util/logger";

export type SenderKind = "popup" | "content" | "engine" | "foreign";

export interface MessageSender {
  readonly id?: string | undefined;
  readonly url?: string | undefined;
  readonly origin?: string | undefined;
  readonly tab?: { readonly id?: number | undefined; readonly url?: string | undefined } | undefined;
  readonly frameId?: number | undefined;
  readonly documentId?: string | undefined;
  readonly documentLifecycle?: string | undefined;
}

const POPUP_PAGE = "src/popup/index.html";
const ENGINE_PAGE = "src/engine/offscreen.html";

/**
 * popup: the extension's popup page, in the toolbar or as its own window.
 * engine: the engine document. content: a script of this extension in a tab's
 * page. Anything else is foreign.
 */
export function senderKind(sender: MessageSender, runtime: { readonly id: string; getURL(path: string): string }): SenderKind {
  if (sender.id !== runtime.id) return "foreign";
  const page = sender.url?.split(/[?#]/, 1)[0];
  if (page === runtime.getURL(POPUP_PAGE)) return "popup";
  if (sender.url === runtime.getURL(ENGINE_PAGE) && sender.tab === undefined) return "engine";
  if (sender.tab?.id !== undefined && !sender.url?.startsWith(runtime.getURL(""))) return "content";
  return "foreign";
}

export type PopupHandlers = { readonly [T in PopupRequest["type"]]: (msg: Extract<PopupRequest, { type: T }>) => Promise<PopupReply<T>> };

/** A bridge handler that returns a value answers the frame with it; the others answer nothing. */
export type BridgeHandlers = { readonly [T in BridgeToBackgroundMessage["type"]]:
  (msg: Extract<BridgeToBackgroundMessage, { type: T }>, sender: MessageSender & { readonly tab: { readonly id: number } }) => void | Promise<unknown> };

/** Bridge messages the frame waits on. */
const ANSWERED: ReadonlySet<BridgeToBackgroundMessage["type"]> = new Set(["frame-active"]);

export function createDispatcher(
  handlers: { readonly popup: PopupHandlers; readonly bridge: BridgeHandlers },
  ready: Promise<void>,
  runtime: { readonly id: string; getURL(path: string): string },
  logger?: Logger,
): (msg: unknown, sender: MessageSender, sendResponse: (reply: unknown) => void) => boolean {
  return (raw, sender, sendResponse) => {
    const kind = senderKind(sender, runtime);
    if (kind === "popup") {
      const msg = parsePopupRequest(raw);
      if (!msg) return false;
      const handler = handlers.popup[msg.type] as (msg: PopupRequest) => Promise<unknown>;
      ready.then(() => handler(msg)).then(sendResponse, error => {
        logger?.error("popup request failed", { type: msg.type, error: error instanceof Error ? error.message : String(error) });
        sendResponse(REQUEST_FAILED);
      });
      return true;
    }
    if (kind === "content") {
      const msg = parseBridgeRequest(raw);
      if (!msg) return false;
      const handler = handlers.bridge[msg.type] as (msg: BridgeToBackgroundMessage, sender: MessageSender) => void | Promise<unknown>;
      const handled = ready.then(() => handler(msg, sender));
      if (!ANSWERED.has(msg.type)) {
        handled.catch(error => logger?.error("bridge message failed", { type: msg.type, error: error instanceof Error ? error.message : String(error) }));
        return false;
      }
      handled.then(sendResponse, () => sendResponse(null));
      return true;
    }
    return false;
  };
}
