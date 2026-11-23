// The engine as a module of the background itself: Firefox, whose background
// page has a DOM. The Chromium build replaces this file with
// local-engine.none.ts (vite.config.ts), so the service worker never loads
// the engine and its muxer; there the engine runs in the offscreen document.
import { createInProcessEngineHost, type InProcessEngineHost, type InProcessEngineHostDeps } from "../engine/in-process-host";

export type LocalEngineFactory = (deps: InProcessEngineHostDeps) => InProcessEngineHost;
export const createLocalEngine: LocalEngineFactory | null = createInProcessEngineHost;
