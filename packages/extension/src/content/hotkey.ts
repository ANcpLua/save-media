// What the bridge does with a key event, as a function of the event alone,
// so the rule can be read and tested without a browser.

export interface KeyFacts {
  readonly isTrusted: boolean;
  readonly repeat: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly code: string;
  /** The event's target takes text: an input, a text area, a select, or editable content. */
  readonly editable: boolean;
}

/**
 * Alt+S and nothing else: never Ctrl+S or Cmd+S, which belong to the browser
 * and the page. `altS` is whether the browser's command is bound to Alt+S:
 * false ignores the key (the user changed or cleared the shortcut), true
 * takes it, and null (not known yet) asks the background without taking the
 * key from the page.
 */
export function altSAction(event: KeyFacts, altS: boolean | null): "ignore" | "send" | "take" {
  if (!event.isTrusted || event.repeat || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.code !== "KeyS") return "ignore";
  if (event.editable || altS === false) return "ignore";
  return altS === true ? "take" : "send";
}
