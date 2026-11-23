// The bounds of a frame's facts. The frame's content script keeps to them
// when it collects, and the background's schema refuses what exceeds them:
// one module, so the two cannot drift apart. Plain numbers and no imports,
// so the classic content scripts can inline it.
export const FACT_LIMITS = {
  /** The page title. Longer titles are cut. */
  title: 2000,
  /** An image address under the pointer, data: addresses included. A longer one is not reported. */
  imageUrl: 2_000_000,
  /** Media layers under the pointer. */
  layers: 200,
  elements: 1000,
  childFrames: 200,
  thumbnail: 200_000,
} as const;
