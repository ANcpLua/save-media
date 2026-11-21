import { verifiedDirectFile } from "./jobs/direct";
import { readBytes, type MediaFetch } from "./net/range-recovery";
import type { DiscoveredMedia } from "../types/messages";
import { userMessage, type JobError } from "@savemedia/core";

interface Curl {
  load_wasm(url: string): Promise<void>;
  set_websocket(url: string): void;
  fetch(url: string, init: RequestInit): Promise<Response>;
  logger: () => void;
  stderr: () => void;
  stdout: () => void;
}

function publicHttps(value: string, base?: string): URL {
  const url = new URL(value, base);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
    || !url.hostname.includes(".") || /^[\d.]+$/.test(url.hostname)
    || /(?:^|\.)(localhost|local|internal|test|invalid)\.?$/i.test(url.hostname)) {
    throw new Error("The site supplied an address the secure relay cannot use.");
  }
  return url;
}

async function transfer(input: { endpoint: string; source: DiscoveredMedia; filename: string; referrer: string }) {
  const vendor = new URL("/vendor/libcurl/", self.location.href);
  const { libcurl }: { libcurl: Curl } = await import(/* @vite-ignore */ new URL("libcurl.mjs", vendor).href);
  // Upstream's default error logger includes request URLs. Never log signed requests.
  libcurl.logger = libcurl.stderr = libcurl.stdout = () => {};
  await libcurl.load_wasm(new URL("libcurl.wasm", vendor).href);
  libcurl.set_websocket(input.endpoint);
  const referrer = new URL(input.referrer).origin + "/";
  const fetchFile: MediaFetch = async (value, init) => {
    let url = publicHttps(value);
    for (let hops = 0; hops <= 8; hops++) {
      let response: Response;
      try {
        response = await libcurl.fetch(url.href, { method: "GET", credentials: "omit", redirect: "manual",
          headers: { ...init.headers, Referer: referrer }, ...(init.signal ? {signal: init.signal} : {}) });
      } catch (err) {
        init.signal?.throwIfAborted();
        if (err instanceof Error && /error code (51|60)\b/.test(err.message)) {
          throw new Error("The secure relay reached a server whose TLS certificate could not be verified.");
        }
        throw new Error("The secure relay could not connect to the file server.");
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const next = response.headers.get("location");
      await response.body?.cancel();
      if (!next) throw new Error("The site returned a redirect without a destination.");
      url = publicHttps(next, url.href);
    }
    throw new Error("The site returned too many redirects.");
  };

  const file = publicHttps(input.source.url);
  const signing = input.source.signatureRequest;
  const fields = [...file.searchParams.keys()].filter(key => /^(token|sig|signature|ex|exp|expires)$/i.test(key));
  if (signing && fields.some(key => /^(token|sig|signature)$/i.test(key))) {
    const signer = publicHttps(signing);
    if (signer.searchParams.size !== 1 || signer.searchParams.get("path") !== file.pathname) {
      throw new Error("The site’s renewal request belongs to a different file.");
    }
    const response = await fetchFile(signer.href, {credentials: "include"});
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error("The site declined to issue a download link on this connection.");
    }
    const bytes = await readBytes(response, 8193, false);
    if (bytes.length > 8192) throw new Error("The site returned an unexpected link response.");
    let data: Record<string, unknown>;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new Error("The site returned an unexpected link response."); }
    for (const key of fields) {
      const value: unknown = data?.[key];
      if ((typeof value !== "string" && typeof value !== "number") || !String(value)) {
        throw new Error("The site returned incomplete download link information.");
      }
      file.searchParams.set(key, String(value));
    }
  }
  const result = await verifiedDirectFile({kind: "direct", url: file.href, filename: input.filename},
    () => self.postMessage({progress: true}), new AbortController().signal, fetchFile);
  self.postMessage(result);
}

self.onmessage = event => {
  void transfer(event.data).catch((err: unknown) => {
    const body = err && typeof err === "object" && "code" in err && "severity" in err
      ? userMessage(err as JobError).body
      : err instanceof Error && /^(The site |The site’s |The secure relay )/.test(err.message)
        ? err.message : "The secure relay could not finish this transfer.";
    self.postMessage({error: body});
  });
};
