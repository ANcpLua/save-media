import { vi } from "vitest";
import type { RouterDeps } from "../../../src/background/router";

/**
 * An engine for router tests: `sent` records every message that would reach
 * the engine document, in order.
 */
export function engineStub() {
  const sent = vi.fn<(message: unknown) => unknown>();
  const engine: RouterDeps["engine"] = {
    start: async message => { await sent(message); },
    cancel: streamId => { sent({ type: "cancel-job", streamId }); },
    release: blobUrl => { sent({ type: "release-output", blobUrl }); },
    ack: streamId => { sent({ type: "ack", streamId }); },
    isPending: () => false,
  };
  return { sent, engine };
}
