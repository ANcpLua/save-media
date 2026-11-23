import { vi, beforeEach, afterEach } from "vitest";

/**
 * vitest 5 infers `Mock<Procedure>` for a bare `vi.fn()`, and `Procedure` is
 * internal to vitest, so a declaration-emitting file cannot name the inferred
 * type (TS2883). Naming the signature ourselves keeps the loose vitest 1
 * behaviour these chrome stubs rely on.
 */
export type AnyMockFn = (...args: any[]) => any;

/** The browser's session storage: it outlives a service worker, so one object backs every chrome mock of a test. */
let sessionData: Record<string, unknown> = {};

function sessionArea() {
  const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  return {
    get: vi.fn(async (keys?: string | string[] | null) => {
      if (keys === null || keys === undefined) return copy(sessionData);
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).flatMap(key => key in sessionData ? [[key, copy(sessionData[key])]] : []));
    }),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(sessionData, copy(items)); }),
    remove: vi.fn(async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionData[key]; }),
  };
}

/** What chrome.storage.session holds now. */
export function storedSession(): Readonly<Record<string, unknown>> { return sessionData; }

/**
 * A service worker restart inside a test: every module is loaded again with
 * fresh memory and a fresh chrome mock, while session storage keeps what was
 * written. Import the modules under test again after calling it.
 */
export function restartWorker(): ChromeMock {
  vi.resetModules();
  const chromeMock = makeChromeMock();
  (globalThis as unknown as { chrome: ChromeMock }).chrome = chromeMock;
  return chromeMock;
}

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
      onUpdated: { addListener: vi.fn<AnyMockFn>(), removeListener: vi.fn<AnyMockFn>() },
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
      // What a worker stored stays across restartWorker(): it is the browser's memory, not the worker's.
      session: sessionArea(),
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
  sessionData = {};
  (globalThis as unknown as { chrome: ChromeMock }).chrome = makeChromeMock();
});

afterEach(() => {
  vi.resetAllMocks();
});
