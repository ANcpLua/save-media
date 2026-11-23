import type { BrowserContext, Page, Worker } from "@playwright/test";

/** The extension's service worker as it runs now, or the next one to start. */
export async function extensionWorker(context: BrowserContext, extensionId: string, timeout = 10_000): Promise<Worker> {
  const running = context.serviceWorkers().find(worker => worker.url().startsWith(`chrome-extension://${extensionId}/`));
  return running ?? context.waitForEvent("serviceworker", { timeout, predicate: worker => worker.url().startsWith(`chrome-extension://${extensionId}/`) });
}

/**
 * Stop the extension's service worker the way the browser does when it has
 * been idle: its memory is gone, chrome.storage.session stays. The next
 * extension event starts a new worker. `page` is any open page of the
 * context; the stop is asked for over its DevTools session.
 *
 * Throws when the worker did not stop: a restart test that silently ran
 * against the same worker would prove nothing.
 */
export async function stopExtensionWorker(context: BrowserContext, extensionId: string, page: Page): Promise<void> {
  const prefix = `chrome-extension://${extensionId}/`;
  const worker = await extensionWorker(context, extensionId);
  // A value in the worker's memory: a worker that still answers with it has not been stopped.
  const mark = `instance-${Date.now()}-${Math.random()}`;
  await worker.evaluate(value => { (globalThis as unknown as { __savemediaInstance?: string }).__savemediaInstance = value; }, mark);
  const stillRunning = async (): Promise<boolean> => {
    for (const candidate of context.serviceWorkers().filter(item => item.url().startsWith(prefix))) {
      const seen = await Promise.race([
        candidate.evaluate(() => (globalThis as unknown as { __savemediaInstance?: string }).__savemediaInstance).catch(() => undefined),
        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 1_000)),
      ]);
      if (seen === mark) return true;
    }
    return false;
  };
  const session = await context.newCDPSession(page);
  const attempts: (() => Promise<void>)[] = [
    async () => {
      const { targetInfos } = await session.send("Target.getTargets");
      const target = targetInfos.find(info => info.type === "service_worker" && info.url.startsWith(prefix));
      if (!target) throw new Error("no service worker target");
      await session.send("Target.closeTarget", { targetId: target.targetId });
    },
    async () => {
      await session.send("ServiceWorker.enable");
      await session.send("ServiceWorker.stopAllWorkers");
    },
  ];
  const errors: string[] = [];
  try {
    for (const attempt of attempts) {
      try { await attempt(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); continue; }
      for (let waited = 0; waited < 20; waited++) {
        if (!await stillRunning()) return;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      errors.push("the worker kept its memory");
    }
  } finally {
    await session.detach().catch(() => undefined);
  }
  throw new Error(`The extension's service worker could not be stopped: ${errors.join("; ")}`);
}

/**
 * Collect what the extension's own code logs as an error in its service
 * worker (logger.error in src/util/logger.ts), for every worker instance of
 * the context. A handler that failed where no assertion looks shows up here.
 * So does an error nothing caught, in the worker or in the engine document:
 * the browser gives a test only the worker's console, so both are logged
 * there (util/uncaught.ts). launchExtension collects for every suite
 * (ExtensionSession.workerErrors).
 */
export function collectWorkerErrors(context: BrowserContext, extensionId: () => string): string[] {
  const errors: string[] = [];
  const watch = (worker: Worker): void => {
    worker.on("console", message => {
      if (message.type() === "error" && message.text().startsWith("[savemedia:") && worker.url().startsWith(`chrome-extension://${extensionId()}/`)) {
        errors.push(message.text());
      }
    });
  };
  for (const worker of context.serviceWorkers()) watch(worker);
  context.on("serviceworker", watch);
  return errors;
}
