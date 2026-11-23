// Extension storage and messages carry JSON. A Uint8Array (an HLS key's IV)
// would arrive as an object of numbered fields, so it travels as hex text.

/** Documentation only: T as it looks after toWire. */
export type Wire<T> = T;

const BYTES = "$bytes";

function toHex(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
  return text;
}

function fromHex(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length >> 1);
  for (let index = 0; index < bytes.length; index++) bytes[index] = parseInt(text.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

/** A JSON-safe copy: every Uint8Array becomes { $bytes: "<hex>" }; undefined fields are left out. */
export function toWire<T>(value: T): Wire<T> {
  if (value instanceof Uint8Array) return { [BYTES]: toHex(value) } as unknown as T;
  if (Array.isArray(value)) return value.map(item => toWire(item)) as unknown as T;
  if (value && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined) copy[key] = toWire(item);
    return copy as T;
  }
  return value;
}

/** The reverse of toWire. */
export function fromWire<T>(value: unknown): T {
  if (Array.isArray(value)) return value.map(item => fromWire(item)) as unknown as T;
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 1 && entries[0]![0] === BYTES && typeof entries[0]![1] === "string" && /^(?:[0-9a-f]{2})*$/.test(entries[0]![1])) {
      return fromHex(entries[0]![1]) as unknown as T;
    }
    const copy: Record<string, unknown> = {};
    for (const [key, item] of entries) copy[key] = fromWire(item);
    return copy as T;
  }
  return value as T;
}
