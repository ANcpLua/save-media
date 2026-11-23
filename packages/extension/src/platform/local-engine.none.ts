// Chromium: no engine in the service worker. See local-engine.ts.
import type { LocalEngineFactory } from "./local-engine";

export const createLocalEngine: LocalEngineFactory | null = null;
