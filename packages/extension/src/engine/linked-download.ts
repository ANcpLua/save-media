import type { DiscoveredMedia } from "../types/messages";

/** Give the site's advertised download page a browser document to run in. */
export function readLinkedDownload(pageUrl: string, filename: string): Promise<DiscoveredMedia | null> {
  const id = crypto.randomUUID();
  const frame = document.createElement("iframe");
  // Scripts and their ordinary requests still run. The sandbox prevents the
  // frame from opening windows or writing a browser download of its own.
  frame.sandbox.add("allow-scripts", "allow-same-origin");
  frame.width = "800";
  frame.height = "600";
  frame.src = pageUrl;
  const origin = new URL(pageUrl).origin;
  return new Promise(resolve => {
    const timeout = setTimeout(() => finish(null), 12_000);
    function finish(source: DiscoveredMedia | null): void {
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(onReply);
      frame.remove();
      resolve(source);
    }
    function onReply(msg: unknown, sender: chrome.runtime.MessageSender): void {
      if (sender.url !== pageUrl || !msg || typeof msg !== "object") return;
      const reply = msg as { type?: unknown; id?: unknown; source?: DiscoveredMedia };
      if (reply.type !== "file-download-url" || reply.id !== id) return;
      const source = reply.source;
      finish(source?.filenameHint === filename && typeof source.url === "string" ? source : null);
    }
    chrome.runtime.onMessage.addListener(onReply);
    frame.addEventListener("load", () => {
      frame.contentWindow?.postMessage({ type: "read-file-download", id, pageUrl, filename }, origin);
    });
    document.body.append(frame);
  });
}
