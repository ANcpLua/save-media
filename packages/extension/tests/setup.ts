import { vi, beforeEach, afterEach } from "vitest";

export function makeChromeMock() {
  return {
    runtime: {
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      sendMessage: vi.fn((_msg: unknown, cb?: (resp: unknown) => void) => { if (cb) cb(undefined); }),
      getURL: (path: string) => `chrome-extension://abcdef/${path}`,
      lastError: undefined as undefined | { message: string },
      openOptionsPage: vi.fn(),
      connect: vi.fn(),
      connectNative: vi.fn(),
      getContexts: vi.fn(async () => []),
    },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      query: vi.fn((_q: unknown, cb: (tabs: { id: number }[]) => void) => cb([{ id: 1 }])),
      sendMessage: vi.fn(),
    },
    downloads: {
      download: vi.fn(async () => 1),
      cancel: vi.fn(async () => undefined),
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setIcon: vi.fn(async () => undefined),
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
      sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
    },
    offscreen: {
      createDocument: vi.fn(async () => undefined),
      closeDocument: vi.fn(async () => undefined),
      Reason: { BLOBS: "BLOBS" },
    },
    scripting: {
      executeScript: vi.fn(async () => []),
    },
  };
}

export type ChromeMock = ReturnType<typeof makeChromeMock>;

beforeEach(() => {
  (globalThis as unknown as { chrome: ChromeMock }).chrome = makeChromeMock();
});

afterEach(() => {
  vi.resetAllMocks();
});
