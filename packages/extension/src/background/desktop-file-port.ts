import { FILE_CONNECTION_PORT } from "../native/file-connection";
import { NATIVE_HOST_NAME } from "../types/native";

/** Only the extension's own offscreen media verifier may open this connection. */
export function registerDesktopFilePorts(enabled: () => Promise<boolean>): void {
  const engine = chrome.runtime.getURL("src/engine/offscreen.html");
  chrome.runtime.onConnect.addListener(client => {
    if (client.name !== FILE_CONNECTION_PORT) return;
    if (client.sender?.id !== chrome.runtime.id || client.sender.url !== engine) {
      client.disconnect();
      return;
    }
    let host: chrome.runtime.Port | undefined;
    let closed = false;
    let requestId: string | undefined;
    function close() {
      if (closed) return;
      closed = true;
      host?.disconnect();
      client.disconnect();
    }
    client.onDisconnect.addListener(() => { void chrome.runtime.lastError; close(); });
    client.onMessage.addListener(message => {
      if (closed) return;
      if (host && message?.id === requestId && (message.type === "file-pull" || message.type === "cancel")) {
        try { host.postMessage(message); } catch { close(); }
        return;
      }
      if (requestId !== undefined || message?.type !== "read-file" || typeof message.id !== "string") {
        close();
        return;
      }
      requestId = message.id;
      void enabled().then(allowed => {
        if (closed) return;
        if (!allowed) { close(); return; }
        host = chrome.runtime.connectNative(NATIVE_HOST_NAME);
        host.onDisconnect.addListener(() => { void chrome.runtime.lastError; close(); });
        host.onMessage.addListener(reply => {
          if (closed) return;
          try { client.postMessage(reply); } catch { close(); }
        });
        host.postMessage(message);
      }).catch(close);
    });
  });
}
