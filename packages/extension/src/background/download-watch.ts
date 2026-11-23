// Waiting for the browser's download manager. One onChanged listener,
// registered when the worker starts, so the browser starts the worker again
// for a download it was waiting on before a restart.

type DownloadsApi = Pick<typeof chrome.downloads, "onChanged" | "search">;

/** The browser did not finish the file. `reason` is Chrome's interrupt reason code, when it gave one. */
export class DownloadEnded extends Error {
  constructor(readonly state: string | undefined, readonly reason: string | undefined) {
    super(reason ?? "The browser did not finish saving the file");
    this.name = "DownloadEnded";
  }
}

export interface DownloadWatch {
  /** Resolves with the id once the download is complete; rejects with DownloadEnded otherwise. */
  wait(id: number, onUpdate?: (item: chrome.downloads.DownloadItem) => void): Promise<number>;
  /** The newest download of exactly this address, or null. */
  findByUrl(url: string): Promise<number | null>;
}

/**
 * `persistent`: keep the listener for the worker's lifetime (the top-level
 * watch). Otherwise it is registered only while someone waits.
 */
export function createDownloadWatch(api: DownloadsApi, persistent = false): DownloadWatch {
  const waiting = new Map<number, Set<(state: string | undefined, reason?: string) => void>>();
  let listening = false;
  const changed = (delta: chrome.downloads.DownloadDelta): void => {
    if (!delta.state?.current) return;
    for (const settle of [...waiting.get(delta.id) ?? []]) settle(delta.state.current, delta.error?.current);
  };
  function listen(): void {
    if (listening) return;
    listening = true;
    api.onChanged.addListener(changed);
  }
  if (persistent) listen();

  return {
    wait(id, onUpdate) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (state: string | undefined, reason?: string): void => {
          if (settled || state === "in_progress") return;
          settled = true;
          clearInterval(poll);
          const group = waiting.get(id);
          group?.delete(settle);
          if (group && !group.size) waiting.delete(id);
          if (!persistent && !waiting.size) { api.onChanged.removeListener(changed); listening = false; }
          if (state === "complete") resolve(id);
          else reject(new DownloadEnded(state, reason));
        };
        const query = (): void => void api.search({ id }).then(([item]) => {
          if (settled) return;
          if (item) onUpdate?.(item);
          settle(item?.state, item?.error);
        }, () => settle(undefined));
        // Chrome reports state changes, not byte counts. The poll only refreshes the progress shown for a resume.
        const poll = onUpdate ? setInterval(query, 5_000) : undefined;
        listen();
        (waiting.get(id) ?? waiting.set(id, new Set()).get(id)!).add(settle);
        // The file may finish before the listener is in place. Query afterward so neither order loses the end.
        query();
      });
    },
    async findByUrl(url) {
      const items = await api.search({ url, orderBy: ["-startTime"] });
      return items.find(item => item.url === url)?.id ?? null;
    },
  };
}
