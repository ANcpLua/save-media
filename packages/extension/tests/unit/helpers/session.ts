import { vi } from "vitest";
import type { SessionArea } from "../../../src/background/state/session-store";

/**
 * chrome.storage.session as an object in memory. Values are copied through
 * JSON, as the browser stores them, so a test that reads `data` sees what a
 * restarted worker would read.
 */
export function memoryArea(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  const area = {
    data,
    get: vi.fn(async (_keys: null) => JSON.parse(JSON.stringify(data)) as Record<string, unknown>),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(data, JSON.parse(JSON.stringify(items)) as Record<string, unknown>); }),
    remove: vi.fn(async (keys: string[]) => { for (const key of keys) delete data[key]; }),
  };
  return area satisfies SessionArea & { data: Record<string, unknown> };
}
