import type { ProgressFn } from "./job";
import type { DiscoveredMedia } from "../types/messages";
import { relayUrl } from "./relay-config";

export type RelayResult = { blobUrl: string; filename: string; bytes: number } | { error: string };

export function transferThroughRelay(source: DiscoveredMedia, filename: string, referrer: string, progress: ProgressFn): Promise<RelayResult> {
  if (!relayUrl) return Promise.resolve({error: "This build has no secure relay configured."});
  // One worker per user-approved file isolates sessions and releases sockets/WASM
  // on completion or a stalled connection, including during library initialization.
  const worker = new Worker(new URL("./relay-worker.ts", import.meta.url), {type: "module"});
  return new Promise(resolve => {
    // Each offscreen message keeps Chrome's service worker alive while it waits
    // for this verified blob, including long transfers while the popup is closed.
    const heartbeat = setInterval(() => chrome.runtime.sendMessage({type: "relay-active"}, () => void chrome.runtime.lastError), 20_000);
    let timer: ReturnType<typeof setTimeout>;
    function finish(result: RelayResult) {
      clearTimeout(timer);
      clearInterval(heartbeat);
      worker.terminate();
      resolve(result);
    }
    function arm() {
      clearTimeout(timer);
      timer = setTimeout(() => finish({error: "The secure relay stopped responding. Try again later."}), 55_000);
    }
    worker.onmessage = ({data}) => {
      if (data.progress) {
        arm();
        progress(data.progress.bytesWritten, data.progress.bytesTotal, data.progress.stage);
        return;
      }
      if (data.blob instanceof Blob && data.blob.size > 0 && typeof data.filename === "string") {
        finish({blobUrl: URL.createObjectURL(data.blob), filename: data.filename, bytes: data.blob.size});
      } else finish({error: data.error || "The secure relay could not verify this file."});
    };
    worker.onerror = () => finish({error: "The secure relay could not start."});
    arm();
    worker.postMessage({source, filename, referrer, endpoint: relayUrl});
  });
}
