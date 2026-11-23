/**
 * Engine host entry point.
 *
 * Chromium loads this in the offscreen document. It runs the engine and
 * talks to the background over one port (background-link.ts): the port
 * carries every message and tells each side when the other is gone. Firefox
 * runs the same engine inside its background page instead.
 */

import { createBackgroundLink, type BackgroundLink, type LinkRuntime } from "./background-link";
import { createInProcessEngineHost, type InProcessEngineHost } from "./in-process-host";
import { reportUncaught } from "../util/uncaught";

let link: BackgroundLink | undefined;
const host: InProcessEngineHost = createInProcessEngineHost({
  sendToBackground: msg => link?.send(msg),
  prepareRequests: (streamId, urls) => link ? link.prepareRequests(streamId, urls) : Promise.resolve(),
});
link = createBackgroundLink(chrome.runtime as unknown as LinkRuntime, () => host);
// An error nothing caught here would otherwise be seen by nobody: this document has no console a person
// looks at. The background is told, and logs it with the extension's other errors.
reportUncaught(globalThis, detail => link?.send({ type: "engine-fault", detail }));
link.start();

export {};
