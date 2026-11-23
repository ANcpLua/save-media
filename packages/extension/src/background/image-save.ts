// Alt+S over an image. The engine fetches the image once and checks its
// bytes; only a Blob of those verified bytes reaches the Downloads folder,
// under a name savemedia builds itself.
import type { JobError } from "@savemedia/core";
import type { BackgroundToEngineMessage, EngineEvent } from "../types/messages";
import { observedAmong, unobservedLocalTarget, webOrigin } from "../util/address-space";
import type { NotAnImage } from "../ui/text";

export type ImageSaveResult =
  | { readonly kind: "saved"; readonly filename: string }
  | { readonly kind: "refused"; readonly received: NotAnImage }
  /** A blob: address lives only in the page's memory. */
  | { readonly kind: "page-only" }
  /** A public page pointing at a server inside the user's network that the browser was not answered from for this tab. */
  | { readonly kind: "local-network" }
  /** The tab went on to another page before the image arrived: nothing is saved and nothing is said. */
  | { readonly kind: "left-page" }
  | { readonly kind: "failed"; readonly error: JobError | null };

type ImageReply = Extract<EngineEvent, { type: "image-complete" | "image-refused" | "image-failed" }>;

export interface ImageSaveDeps {
  readonly mirrorReferer: (url: string, pageUrl: string) => Promise<void>;
  /** Opens the engine if needed and hands it the image job. Rejects when the engine cannot be opened. */
  readonly startEngine: (msg: Extract<BackgroundToEngineMessage, { type: "start-image" }>) => Promise<void>;
  /** Saves the Blob and resolves with the file name it got on disk. */
  readonly download: (blobUrl: string, filename: string) => Promise<string>;
  readonly release: (blobUrl: string) => void;
  /** Ends an image job the engine still runs. */
  readonly cancel?: (streamId: string) => void;
  /**
   * What the browser reported about the image request explains a network failure (a block by the user's
   * network, a certificate the browser refused). Nothing is requested for it.
   */
  readonly explainNetwork?: (error: JobError, context: { readonly since: number; readonly address: string; readonly pageUrl: string;
    readonly tabId: number | null }) => JobError;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export function createImageSaver(deps: ImageSaveDeps) {
  const waiting = new Map<string, { readonly tabId: number | null; readonly settle: (reply: ImageReply | null) => void }>();
  let saving = 0;
  return {
    /** An image save is under way: the engine document must stay open. */
    busy: (): boolean => saving > 0,
    /** Engine replies for image jobs. Returns false for any other message. */
    handleEngineMessage(msg: EngineEvent): boolean {
      if (msg.type !== "image-complete" && msg.type !== "image-refused" && msg.type !== "image-failed") return false;
      const waiter = waiting.get(msg.streamId);
      waiting.delete(msg.streamId);
      if (waiter) waiter.settle(msg);
      // Nobody waits for this output any more: let the engine drop it.
      else if (msg.type === "image-complete") deps.release(msg.blobUrl);
      return true;
    },

    /** The engine is gone: every image it was fetching fails now, so nothing waits for an answer that cannot come. */
    engineLost(): void {
      for (const [streamId, waiter] of [...waiting]) {
        waiting.delete(streamId);
        waiter.settle({ type: "image-failed", streamId, error: { code: "engine_stopped", severity: "terminal", when: "running" } });
      }
    },

    /**
     * The tab shows another page: an image of the page before it that has not arrived is given up. The
     * engine ends its request, so nothing keeps the engine open for a page the user has left.
     */
    leftPage(tabId: number): void {
      for (const [streamId, waiter] of [...waiting]) {
        if (waiter.tabId !== tabId) continue;
        waiting.delete(streamId);
        deps.cancel?.(streamId);
        waiter.settle(null);
      }
    },

    /**
     * `localOrigins`: the origins inside the user's network the browser itself was answered from in the
     * image's tab. For a public page, an image on any other local server is not requested.
     *
     * `loaded`: the page shows this picture in an img element, as savemedia's own content script read it.
     * The browser was then answered with the picture from the image's origin, which counts like an answer
     * the browser's requests showed: image requests themselves are not observed. It opens that one origin
     * for this one save and is not remembered for the tab. A broken image, and an address a page only
     * names, opens nothing.
     */
    async save(request: { readonly url: string; readonly pageUrl: string; readonly localOrigins?: readonly string[];
      readonly loaded?: boolean; readonly tabId?: number }): Promise<ImageSaveResult> {
      const shown = request.loaded ? webOrigin(request.url) : null;
      const image = { url: request.url, pageUrl: request.pageUrl,
        localOrigins: shown && !request.localOrigins?.includes(shown) ? [...(request.localOrigins ?? []), shown] : request.localOrigins };
      if (!/^(https?|data):/i.test(image.url)) return { kind: "page-only" };
      if (/^https?:/i.test(image.url)) {
        if (unobservedLocalTarget(image.pageUrl, image.url, observedAmong(image.localOrigins))) return { kind: "local-network" };
        // Hotlink-protected hosts see the page origin as Referer, as the page's own request carried it.
        await deps.mirrorReferer(image.url, image.pageUrl);
      }
      const streamId = `image:${deps.newId?.() ?? crypto.randomUUID()}`;
      const tabId = request.tabId ?? null;
      const since = (deps.now ?? Date.now)();
      saving++;
      try {
        const reply = await new Promise<ImageReply | null>((resolve, reject) => {
          waiting.set(streamId, { tabId, settle: resolve });
          deps.startEngine({ type: "start-image", streamId, url: image.url, pageUrl: image.pageUrl,
            ...(image.localOrigins?.length ? { localOrigins: image.localOrigins } : {}) }).catch(reject);
        });
        if (!reply) return { kind: "left-page" };
        if (reply.type === "image-refused") return { kind: "refused", received: reply.received };
        if (reply.type === "image-failed") {
          return { kind: "failed", error: deps.explainNetwork?.(reply.error, { since, address: image.url, pageUrl: image.pageUrl, tabId }) ?? reply.error };
        }
        try {
          return { kind: "saved", filename: await deps.download(reply.blobUrl, reply.filename) };
        } finally {
          deps.release(reply.blobUrl);
        }
      } catch {
        waiting.delete(streamId);
        return { kind: "failed", error: null };
      } finally {
        saving--;
      }
    },
  };
}
