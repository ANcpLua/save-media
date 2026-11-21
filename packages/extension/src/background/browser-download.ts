type Downloads = Pick<typeof chrome.downloads, "download" | "onChanged" | "search">;

/** The downloads API returns an ID when it accepts the request, before the file is saved. */
export async function saveVerifiedDownload(api: Downloads, options: chrome.downloads.DownloadOptions): Promise<number> {
  const id = await api.download(options);
  return new Promise((resolve, reject) => {
    function finish(state: string | undefined, reason?: string): void {
      if (state === "in_progress") return;
      api.onChanged.removeListener(change);
      if (state === "complete") resolve(id);
      else reject(new Error(reason ?? "The browser did not finish saving the file"));
    }

    function change(delta: chrome.downloads.DownloadDelta): void {
      if (delta.id === id && delta.state?.current) finish(delta.state.current, delta.error?.current);
    }

    api.onChanged.addListener(change);
    // The file may finish before download() resolves or while the listener is
    // being installed. Query afterward so neither ordering can lose completion.
    void api.search({ id }).then(([item]) => finish(item?.state, item?.error), () => finish(undefined));
  });
}
