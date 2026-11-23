// File links a page declares in its own markup, and the media file name a
// page shows. savemedia never runs a site's own controls to obtain a link:
// it reads what the markup states, and the probe checks the bytes.
import type { FileDownloadOffer } from "../types/messages";
import { mediaFileName, mimeKind, urlKind } from "../util/media-url";

const LIMIT = 80;

/**
 * A transport stream name: ".ts" also names TypeScript sources, so such a
 * name says "media" only next to a MIME type or a media element. A heading,
 * a download attribute and a link's path are none of these.
 */
function isTransportName(name: string): boolean {
  return urlKind(`/${name}`) === "transport";
}

/** The name as far as it counts for this link: a transport stream name only when the link itself states a transport stream type. */
function nameForLink(name: string | undefined, link: HTMLAnchorElement): string | undefined {
  return name && (!isTransportName(name) || mimeKind(link.getAttribute("type")) === "transport") ? name : undefined;
}

function fileLinkName(link: HTMLAnchorElement, url: URL): string | undefined {
  const promised = nameForLink(mediaFileName(link.getAttribute("download")), link);
  if (promised) return promised;
  try { return nameForLink(mediaFileName(decodeURIComponent(url.pathname.split("/").at(-1) ?? "")), link); }
  catch { return undefined; }
}

interface DeclaredLink {
  readonly element: HTMLAnchorElement;
  readonly url: URL;
  /** The media file name the link itself carries, in its download attribute or path. */
  readonly name: string | undefined;
}

/**
 * Links the page itself marks as media files: a download attribute, a video
 * type, or a plain link whose path is the very file the page names. The
 * probe checks each one's bytes before anything is saved.
 */
function declaredMediaLinks(doc: Document, pageUrl: string): DeclaredLink[] {
  const named = declaredMediaFilename(doc, { transport: false });
  const links: DeclaredLink[] = [];
  for (const element of doc.querySelectorAll<HTMLAnchorElement>(named ? "a[href]" : "a[download][href], a[type^='video/' i][href]")) {
    const marked = element.hasAttribute("download") || /^video\//i.test(element.getAttribute("type") ?? "");
    if (element.closest('[hidden], [inert], [aria-hidden="true"], [aria-disabled="true"]')) continue;
    try {
      const url = new URL(element.getAttribute("href")!, doc.baseURI === "about:blank" ? pageUrl : doc.baseURI);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.href === pageUrl || element.getAttribute("href")?.startsWith("#")) continue;
      const name = fileLinkName(element, url);
      if (!marked && name !== named) continue;
      const style = doc.defaultView?.getComputedStyle(element);
      if (style?.display === "none" || style?.visibility === "hidden") continue;
      links.push({ element, url, name });
    } catch { /* Ignore invalid publisher links. */ }
  }
  return links;
}

export interface PublishedFileLink {
  readonly url: string;
  readonly filenameHint?: string;
  /** The link is to the very file the page names. */
  readonly named: boolean;
}

/** Each declared file link is a choice of its own. */
export function publishedFileLinks(doc: Document, pageUrl: string): PublishedFileLink[] {
  const pageName = declaredMediaFilename(doc, { transport: true });
  const files = new Map<string, PublishedFileLink>();
  for (const { element, url, name } of declaredMediaLinks(doc, pageUrl)) {
    const declared = nameForLink(pageName, element);
    if (name && declared && name !== declared) continue;
    const filenameHint = name ?? declared;
    // A link with neither a name that counts nor a video type declares no media: a download link to a source file is one.
    if (filenameHint || element.type.toLowerCase().startsWith("video/")) {
      files.set(url.href, { url: url.href, ...(filenameHint ? { filenameHint } : {}), named: !!declared && filenameHint === declared });
    }
    if (files.size >= LIMIT) break;
  }
  return [...files.values()];
}

/**
 * The one declared link to the file a page names, saved under the page's
 * name. A page that names no file has none. Only links the page lays out count, so a copy in a collapsed menu or
 * a layout the page does not show cannot make the choice ambiguous. Several
 * links resolve only when exactly one sits in the section of the heading that
 * names the file. savemedia never runs the site's own controls to obtain a link.
 */
export function fileDownloadOffer(doc: Document, pageUrl: string): FileDownloadOffer | undefined {
  const declared = declaredMediaFilename(doc, { transport: true });
  // Only a page that names a file is that file's page. On any other page a
  // file link is one declared source among the page's media: it is listed as
  // a card of its own and never stands in for the video the page plays.
  if (!declared) return undefined;
  const plainPage = new URL(pageUrl).protocol === "http:";
  const offers = new Map<string, { element: HTMLAnchorElement; offer: FileDownloadOffer }>();
  for (const { element, url } of declaredMediaLinks(doc, pageUrl)) {
    if (!nameForLink(declared, element) || !element.getClientRects().length) continue;
    const promised = element.getAttribute("download")?.trim();
    if ((url.protocol !== "https:" && !plainPage) || (promised && promised !== declared)) continue;
    offers.set(url.href, { element, offer: { filename: declared, url: url.href } });
  }
  const candidates = [...offers.values()];
  return (candidates.length <= 1 ? candidates[0] : linkInHeadingSection(doc, declared, candidates))?.offer;
}

function linkInHeadingSection<T extends { readonly element: Element }>(doc: Document, name: string | undefined, links: readonly T[]): T | undefined {
  const heading = name === undefined ? undefined : [...doc.querySelectorAll("h1")].find(item => item.textContent?.trim() === name);
  for (let section = heading?.parentElement; section && section !== doc.body; section = section.parentElement) {
    const inSection = links.filter(({ element }) => section.contains(element));
    if (inSection.length) return inSection.length === 1 ? inSection[0] : undefined;
  }
  return undefined;
}

/**
 * The media file name the page shows, in its heading or its title metadata:
 * the one reader of "the file this page names". The page's text alone cannot
 * name a transport stream (see isTransportName), so the caller says whether
 * it has what the text lacks: `transport` is true only where a MIME type or
 * a media element stands for the file the name would go to.
 */
export function declaredMediaFilename(doc: Document, context: { readonly transport: boolean }): string | undefined {
  const name = [...doc.querySelectorAll('h1, meta[property="og:title"]')]
    .map(el => (el.getAttribute("content") ?? el.textContent ?? "").trim())
    .map(value => mediaFileName(value)).find(value => value !== undefined);
  return name && (context.transport || !isTransportName(name)) ? name : undefined;
}
