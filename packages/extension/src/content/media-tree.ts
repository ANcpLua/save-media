// Walks a document together with its shadow trees.

interface DomApi { openOrClosedShadowRoot?: (element: HTMLElement) => ShadowRoot | null }

/**
 * An element's shadow root. Closed roots are read only on custom elements,
 * where player components live, through the extension's own DOM API: nothing
 * in the page is patched.
 */
export function shadowRootOf(element: Element): ShadowRoot | null {
  if (element.shadowRoot) return element.shadowRoot;
  if (!element.localName.includes("-")) return null;
  try {
    const dom = (globalThis as { chrome?: { dom?: DomApi } }).chrome?.dom;
    return dom?.openOrClosedShadowRoot?.(element as HTMLElement) ?? null;
  } catch { return null; }
}

/** The parent element, or the host when the node sits at the top of a shadow tree. */
export function parentAcrossShadow(node: Node): Element | null {
  const parent = node.parentNode;
  if (!parent) return null;
  if (parent.nodeType === 1) return parent as Element;
  return parent.nodeType === 11 && "host" in parent ? (parent as ShadowRoot).host : null;
}

export interface MediaTree {
  readonly videos: HTMLVideoElement[];
  readonly canvases: HTMLCanvasElement[];
  readonly roots: ShadowRoot[];
}

const MAX_ELEMENTS = 1000;

/** Every video and canvas of the document and its reachable shadow roots, in tree order. */
export function walkMedia(root: Document): MediaTree {
  const tree: MediaTree = { videos: [], canvases: [], roots: [] };
  const visit = (scope: Document | ShadowRoot): void => {
    const walker = root.createTreeWalker(scope, 1 /* SHOW_ELEMENT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node as Element;
      if (element.localName === "video" && tree.videos.length < MAX_ELEMENTS) tree.videos.push(element as HTMLVideoElement);
      else if (element.localName === "canvas" && tree.canvases.length < MAX_ELEMENTS) tree.canvases.push(element as HTMLCanvasElement);
      const shadow = shadowRootOf(element);
      if (shadow && tree.roots.length < MAX_ELEMENTS) {
        tree.roots.push(shadow);
        visit(shadow);
      }
    }
  };
  visit(root);
  return tree;
}

/** Stable keys for elements of one document: "v1", "v2", ... in the order first asked. */
export function elementKeys(): (element: Element) => string {
  const keys = new WeakMap<Element, string>();
  let next = 0;
  return element => {
    let key = keys.get(element);
    if (!key) {
      key = `v${++next}`;
      keys.set(element, key);
    }
    return key;
  };
}
