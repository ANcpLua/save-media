import { vi, beforeEach, afterEach } from "vitest";

/**
 * vitest 5 infers `Mock<Procedure>` for a bare `vi.fn()`, and `Procedure` is
 * internal to vitest, so a declaration-emitting file cannot name the inferred
 * type (TS2883). Naming the signature ourselves keeps the loose vitest 1
 * behaviour these chrome stubs rely on.
 */
export type AnyMockFn = (...args: any[]) => any;

export function makeChromeMock() {
  return {
    runtime: {
      onMessage: { addListener: vi.fn<AnyMockFn>(), removeListener: vi.fn<AnyMockFn>() },
      sendMessage: vi.fn((_msg: unknown, cb?: (resp: unknown) => void) => { if (cb) cb(undefined); }),
      getURL: (path: string) => `chrome-extension://abcdef/${path}`,
      lastError: undefined as undefined | { message: string },
      openOptionsPage: vi.fn<AnyMockFn>(),
      connect: vi.fn<AnyMockFn>(),
      connectNative: vi.fn<AnyMockFn>(),
      getContexts: vi.fn(async () => []),
    },
    tabs: {
      onRemoved: { addListener: vi.fn<AnyMockFn>() },
      onUpdated: { addListener: vi.fn<AnyMockFn>() },
      query: vi.fn((_q: unknown, cb: (tabs: { id: number }[]) => void) => cb([{ id: 1 }])),
      sendMessage: vi.fn<AnyMockFn>(),
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
