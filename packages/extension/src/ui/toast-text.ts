// The words of the in-page toast. It imports nothing: the page bridge runs
// in every frame of every page and bundles only what it needs.
//
// Wording rules (the same in every text catalogue): a label says the state in
// one or two words, the detail says the object, and neither repeats the
// other. "savemedia" is lowercase. No codes, no long dashes, no pictographs,
// no exclamation marks. Nothing here points at a site's own buttons.

export const TOAST_OUTCOMES = ["preparing", "started", "delegated", "complete", "no-media", "waiting", "asked", "failed", "cancelled"] as const;
export type ToastOutcome = typeof TOAST_OUTCOMES[number];

/** The state, in the toast's bold label. */
export const TOAST_LABELS: Readonly<Record<ToastOutcome, string>> = {
  "preparing": "Checking",
  "started": "Saving",
  "delegated": "Saving",
  "complete": "Saved",
  "no-media": "Nothing to save",
  "waiting": "Not ready",
  "asked": "Already saved",
  "failed": "Not saved",
  "cancelled": "Cancelled",
};

/** The colour of the toast's dot. */
export const TOAST_TONE: Readonly<Record<ToastOutcome, string>> = {
  "preparing": "#2563eb",
  "started": "#16a34a",
  "delegated": "#2563eb",
  "complete": "#16a34a",
  "no-media": "#6b7280",
  "waiting": "#d97706",
  "asked": "#d97706",
  "failed": "#dc2626",
  "cancelled": "#6b7280",
};

/** How long a toast stays: longer when it asks the user to do something. */
export function toastDuration(outcome: ToastOutcome): number {
  if (outcome === "failed" || outcome === "waiting" || outcome === "asked") return 8_000;
  return outcome === "preparing" ? 12_000 : 4_000;
}

/** Only a failure interrupts a screen reader. */
export function toastUrgency(outcome: ToastOutcome): "assertive" | "polite" {
  return outcome === "failed" ? "assertive" : "polite";
}

/** Alt+S in a tab whose extension was reloaded under it: the page script can no longer reach savemedia. */
export const RECONNECT_HINT = "Reload this page to reconnect savemedia.";
