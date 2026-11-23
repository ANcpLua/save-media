// MAIN world. Reports that a media element used a key: a licence request
// through its MediaKeys. Asking the browser what it could play
// (requestMediaKeySystemAccess) and attaching keys (setMediaKeys) are not
// proof of protected media and report nothing. Every wrapper calls the
// original first, returns its result unchanged and never throws into the page.

export const EME_EVENT = "savemedia:eme";

interface EmeScope {
  readonly MediaKeySystemAccess?: { prototype: object };
  readonly MediaKeys?: { prototype: object };
  readonly MediaKeySession?: { prototype: object };
  readonly HTMLMediaElement?: { prototype: object };
  readonly document: Document;
  readonly CustomEvent: typeof CustomEvent;
}

type Method = (this: unknown, ...args: unknown[]) => unknown;

function wrap(owner: { prototype: object } | undefined, name: string, after: (self: object, args: readonly unknown[], result: unknown) => void): void {
  const prototype = owner?.prototype as Record<string, unknown> | undefined;
  const original = prototype?.[name];
  if (!prototype || typeof original !== "function") return;
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    const result = (original as Method).apply(this, args);
    try { if (this !== null && typeof this === "object") after(this, args, result); } catch { /* Observation only. */ }
    return result;
  };
  try { prototype[name] = wrapped; } catch { /* A frozen prototype stays untouched. */ }
}

export function installEmeProof(scope: EmeScope = globalThis as unknown as EmeScope): void {
  const keySystems = new WeakMap<object, string>();
  const elements = new WeakMap<object, Element>();
  const sessionKeys = new WeakMap<object, object>();
  const requested = new WeakSet<object>();

  const report = (target: EventTarget, keys: object | undefined): void => {
    const detail = JSON.stringify({ via: "license-request", keySystem: (keys && keySystems.get(keys)) ?? null });
    target.dispatchEvent(new scope.CustomEvent(EME_EVENT, { bubbles: true, composed: true, detail }));
  };

  wrap(scope.MediaKeySystemAccess, "createMediaKeys", (access, _args, result) => {
    const keySystem = (access as { keySystem?: unknown }).keySystem;
    if (typeof keySystem !== "string" || !(result instanceof Promise)) return;
    void result.then(keys => { if (keys && typeof keys === "object") keySystems.set(keys as object, keySystem); }, () => undefined);
  });
  wrap(scope.HTMLMediaElement, "setMediaKeys", (element, args) => {
    const keys = args[0];
    if (keys === null || typeof keys !== "object") return;
    elements.set(keys, element as Element);
    // The licence request may come before the keys reach an element.
    if (requested.has(keys)) report(element as Element, keys);
  });
  wrap(scope.MediaKeys, "createSession", (keys, _args, session) => {
    if (session !== null && typeof session === "object") sessionKeys.set(session, keys);
  });
  wrap(scope.MediaKeySession, "generateRequest", session => {
    const keys = sessionKeys.get(session);
    if (keys) requested.add(keys);
    const element = keys ? elements.get(keys) : undefined;
    report(element?.isConnected ? element : scope.document, keys);
  });
}
