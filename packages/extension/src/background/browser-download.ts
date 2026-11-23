import { createDownloadWatch } from "./download-watch";

type Downloads = Pick<typeof chrome.downloads, "download" | "onChanged" | "search">;

/** The downloads API returns an ID when it accepts the request, before the file is saved. */
export async function saveVerifiedDownload(api: Downloads, options: chrome.downloads.DownloadOptions): Promise<number> {
  const id = await api.download(options);
  return waitForDownload(api, id);
}

export function waitForDownload(api: Pick<Downloads, "search" | "onChanged">, id: number,
  onUpdate?: (item: chrome.downloads.DownloadItem) => void): Promise<number> {
  return createDownloadWatch(api).wait(id, onUpdate);
}
