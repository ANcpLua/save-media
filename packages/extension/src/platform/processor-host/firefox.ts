export async function ensureEngineHost(): Promise<void> {
  // Firefox MV3 background is an event page with DOM; the engine host loads
  // alongside the background script. No separate document creation needed.
}

export async function closeEngineHost(): Promise<void> {
  // No-op on Firefox.
}
