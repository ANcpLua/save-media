import { MAX_AUTOMATIC_WAIT_MS } from "@savemedia/core";
import { delay } from "./retry-delay";
import { isOutageAfterRetries, isTransferError } from "./transfer-error";

// What a save does after an outage: no answer, a stalled connection, or a
// busy server that may answer after a wait. It keeps what it has, waits, and
// asks again for the part it was reading. A direct file and a stream of
// segments share the number of reconnects and the waits between them.

/** Reconnects in a row without progress before a save gives up. */
export const MAX_RECONNECTS = 5;

/** The wait before a reconnect: 1, 2, 4, 8 and 16 seconds, or the server's own wait when that is longer. */
export function reconnectWaitMs(reconnects: number, retryAfterMs = 0): number {
  return Math.max(retryAfterMs, 1000 * 2 ** reconnects);
}

/**
 * One part of a stream (a segment), read through outages: after an outage the
 * same part is read again after the wait, and everything the caller already
 * holds stays as it is. `onWait` hears each wait before it starts. The
 * reconnects count per call, so each part that arrives starts a new count.
 * Any other failure, and an outage that outlasts the reconnects, is thrown
 * as it is, with the number of reconnects made.
 */
export async function readThroughOutages<T>(read: () => Promise<T>, signal: AbortSignal, onWait: (waitMs: number) => void): Promise<T> {
  for (let reconnects = 0; ; reconnects++) {
    signal.throwIfAborted();
    try {
      return await read();
    } catch (error) {
      signal.throwIfAborted();
      const final = isTransferError(error) && reconnects ? error.with({ reconnects }) : error;
      if (!isOutageAfterRetries(error) || reconnects >= MAX_RECONNECTS) throw final;
      const retryAfter = error.facts.retryAfterMs ?? 0;
      // A server that asks for a longer wait than a save makes by itself is not asked early.
      if (retryAfter > MAX_AUTOMATIC_WAIT_MS) throw final;
      const waitMs = reconnectWaitMs(reconnects, retryAfter);
      onWait(waitMs);
      await delay(waitMs, signal);
    }
  }
}
