declare const __BROWSER__: "chromium" | "firefox" | undefined;

const target: "chromium" | "firefox" =
  typeof __BROWSER__ !== "undefined" ? __BROWSER__ : "chromium";

const impl = target === "firefox"
  ? await import("./firefox")
  : await import("./chromium");

export const { ensureEngineHost, closeEngineHost } = impl;
