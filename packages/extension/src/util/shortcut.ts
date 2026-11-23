// The save command's keyboard shortcut, as the browser reports it.

/** The name of the save command in the manifest. */
export const SAVE_COMMAND = "download-best";

/**
 * Whether the command's shortcut, as the browser reports it now, is Alt+S
 * ("⌥S" on a Mac). The page's own key listener serves only that shortcut: a
 * shortcut the user changed or cleared is the user's choice.
 */
export function isAltSShortcut(shortcut: string | undefined): boolean {
  return (shortcut ?? "").replace("⌥", "Alt+").replace(/\s/g, "").toUpperCase() === "ALT+S";
}

/**
 * How the popup names the shortcut: "Alt+S" for the one the manifest suggests, in the spelling the rest of
 * savemedia uses, and any other shortcut as the browser writes it. Empty when the command has no shortcut.
 */
export function shortcutLabel(shortcut: string): string {
  return isAltSShortcut(shortcut) ? "Alt+S" : shortcut.trim();
}
