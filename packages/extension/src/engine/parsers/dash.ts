import { checkManifestSize, dispatch, isJobError, parseDash } from "@savemedia/core";
import type { JobError, StreamDescriptor, UserChoice, Variant } from "@savemedia/core";
import { report, type PrepareRequests, type ProgressFn } from "../job";
import { fetchWithRetry } from "../net/fetch-with-retry";
import { classifyPlaylistReread } from "../net/error-classification";
import { readManifestText } from "../net/manifest-text";
import { requireManifestAtSave } from "../manifest-at-save";
import { dispatchRefusalToError } from "../../util/dispatch-refusal";

/** The part of a variant id after the manifest's address: the representation's own name. */
function nameOf(id: string): string {
  const at = id.indexOf("#");
  return at < 0 ? id : id.slice(at);
}

/** A track as the manifest states it now, under the id the listed row gave it. */
function underKnownId(fresh: Variant, known: readonly Variant[]): Variant {
  const same = known.find(track => nameOf(track.id) === nameOf(fresh.id));
  return same ? { ...fresh, id: same.id } : fresh;
}

/**
 * Reads a DASH manifest when its save starts, as the engine reads an HLS
 * playlist. A listed row carries a sample of each track's segment list, never
 * the whole list, so the manifest as the server sends it now is the authority
 * for what is requested: its segment addresses, and its declared protection,
 * which is refused here exactly as it is at detection.
 *
 * A row that cannot be saved as it is listed is returned unchanged, without
 * a request: dispatch refuses it with its reason.
 */
export async function materializeDash(
  descriptor: StreamDescriptor,
  choice: UserChoice,
  onProgress: ProgressFn,
  signal: AbortSignal,
  request: typeof fetchWithRetry = fetchWithRetry,
  prepareRequests?: PrepareRequests,
): Promise<StreamDescriptor> {
  if (descriptor.protocol !== "dash" || descriptor.source.kind !== "dash-manifest" || descriptor.drm) return descriptor;
  if (dispatch(descriptor, choice).kind === "refuse") return descriptor;

  const manifestUrl = descriptor.source.manifestUrl;
  report(onProgress, { kind: "playlist" }, 0, null);
  await prepareRequests?.([manifestUrl]);
  const response = await request(manifestUrl, signal, "manifest", { credentials: "include", cache: "no-store" }).catch(err => {
    throw classifyPlaylistReread(err, manifestUrl) ?? err;
  });
  const text = await readManifestText(response, manifestUrl);
  // The address answers with something that is not a manifest any more: a sign-in page, an error document.
  requireManifestAtSave("dash", text, manifestUrl);
  checkManifestSize("dash", text, manifestUrl);
  let parsed: ReturnType<typeof parseDash>;
  try {
    parsed = parseDash(text, response.url || manifestUrl);
  } catch (error) {
    if (isJobError(error)) throw error;
    throw { code: "manifest_malformed", severity: "terminal", url: manifestUrl,
      parserError: error instanceof Error ? error.message : "not a DASH manifest" } satisfies JobError;
  }
  if (parsed.drm) throw dispatchRefusalToError(parsed.drm.reason, { ...descriptor, drm: parsed.drm });
  return {
    ...descriptor,
    variants: parsed.videoVariants.map(track => underKnownId(track, descriptor.variants)),
    audioRenditions: parsed.audioRenditions.map(track => underKnownId(track, descriptor.audioRenditions ?? [])),
    presentation: parsed.presentation,
  };
}
