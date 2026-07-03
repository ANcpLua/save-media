// Small strict-TypeScript helpers shared by the site resolvers. No `any`:
// everything narrows from `unknown`.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Depth-first walk over every object node in a parsed-JSON tree. Site API
 * payloads bury the media object at varying, undocumented depths (timeline
 * vs. single-post vs. reel shapes), so resolvers scan for the marker field
 * rather than hard-coding a path that rots on the next redesign.
 *
 * Iterative + a visited set: payloads can be large and are not guaranteed
 * acyclic once the same result object is referenced from multiple entries.
 */
export function walkObjects(
  root: unknown,
  visit: (node: Record<string, unknown>) => void,
): void {
  const stack: unknown[] = [root];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    if (!isRecord(node)) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    visit(node);
    for (const key of Object.keys(node)) stack.push(node[key]);
  }
}

/** Same asset regardless of query token (twimg `?tag=`, IG `?efg=`, ...). */
export function dedupeKey(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/** Twitter/IG CDN URLs embed `/1280x720/`; use it for the quality label. */
export function dimensionsFromUrl(url: string): { width: number | null; height: number | null } {
  const m = /\/(\d{2,5})x(\d{2,5})\//.exec(url);
  if (!m) return { width: null, height: null };
  return { width: Number(m[1]), height: Number(m[2]) };
}
