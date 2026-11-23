/**
 * A short, stable name for a list of values: FNV-1a over their JSON text, in
 * two 32-bit lanes, as 16 lowercase hex characters. The same values give the
 * same name in every worker instance, so an id built from it survives a
 * service worker restart and a lost store. Not a secret and not collision
 * proof: callers that need uniqueness check for a clash.
 */
export function contentId(parts: readonly (string | number)[]): string {
  const text = JSON.stringify(parts);
  let a = 0x811c9dc5;
  let b = 0xcbf29ce4;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ (code + index), 0x01000193) ^ (a >>> 13);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}
