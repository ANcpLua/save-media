// Errors that no handler caught, in a context of the extension's own code (the service worker, the
// engine document). They are reported once each, as one short line, so a failure in a listener or an
// unhandled rejection is logged where the extension's other errors are, and fails a test that watches them.

interface ErrorEvents {
  addEventListener(type: "error" | "unhandledrejection", listener: (event: unknown) => void): void;
}

/** The most characters of an error that are reported. */
const MAX_DETAIL = 500;

function describe(value: unknown): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  return text.slice(0, MAX_DETAIL);
}

export function reportUncaught(scope: ErrorEvents, report: (detail: string) => void): void {
  scope.addEventListener("error", event => {
    const { error, message } = event as { readonly error?: unknown; readonly message?: unknown };
    report(describe(error ?? message ?? "error"));
  });
  scope.addEventListener("unhandledrejection", event => {
    report(describe((event as { readonly reason?: unknown }).reason));
  });
}
