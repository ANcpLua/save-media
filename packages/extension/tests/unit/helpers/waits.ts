import { onTestFinished, vi } from "vitest";
import * as retryDelay from "../../../src/engine/net/retry-delay";

/**
 * Every wait the engine's retry and reconnect policies ask for goes through
 * retry-delay's `delay`. For the test that calls this, a wait passes at once
 * (a cancelled one still rejects), and the returned mock holds what was asked
 * for: a test states the policy's outcome, the requests made and the waits
 * requested, and never spends the policy's seconds waiting. The waits asked
 * for are the same in every run.
 */
export function noWaits() {
  const waits = vi.spyOn(retryDelay, "delay").mockImplementation(async (_ms, signal) => signal.throwIfAborted());
  // The quick retries add a random part to their waits. With it fixed, such a wait never happens to be a
  // whole second, which is how tests tell the reconnect waits (1, 2, 4, 8, 16 s) from the quick ones.
  const random = vi.spyOn(Math, "random").mockReturnValue(0.25);
  onTestFinished(() => { waits.mockRestore(); random.mockRestore(); });
  return waits;
}

/** The milliseconds each wait asked for, in order. */
export function waitsOf(waits: ReturnType<typeof noWaits>): number[] {
  return waits.mock.calls.map(([ms]) => ms);
}
