import { compareVideoQuality, dispatch, hasPendingHlsPair, type StreamDescriptor, type UserChoice, type Variant } from "@savemedia/core";
import { suggestFilename } from "./filename";

interface DownloadOption {
  readonly descriptor: StreamDescriptor;
  readonly variant: Variant | null;
  readonly choice: UserChoice;
}

// Descriptors are immutable snapshots. Reuse the result when the popup
// re-renders on progress or compares multiple representations of a video.
const choices = new WeakMap<StreamDescriptor, readonly DownloadOption[]>();

export function downloadOptions(descriptor: StreamDescriptor): readonly DownloadOption[] {
  const known = choices.get(descriptor);
  if (known) return known;
  const options: DownloadOption[] = [];
  if (!descriptor.drm) {
    const filename = suggestFilename(descriptor);
    const variants = [...descriptor.variants].sort(compareVideoQuality);
    const audios = descriptor.protocol === "dash"
      ? [...(descriptor.audioRenditions ?? [])].sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
      : [];
    for (const variant of variants.length ? variants : [null]) {
      const tracks = audios.length ? audios.map(audio => audio.audioRenditionId) : [variant?.audioRenditionId ?? null];
      for (const audioRenditionId of tracks) {
        const choice: UserChoice = { outputMode: "Original", filename, variantId: variant?.id ?? null, audioRenditionId };
        const plan = dispatch(descriptor, choice);
        if (plan.kind === "refuse" && !(plan.reason === "no_usable_variant" && hasPendingHlsPair(descriptor, choice))) continue;
        options.push({ descriptor, variant, choice });
        break;
      }
    }
  }
  choices.set(descriptor, options);
  return options;
}

export function compareDownloads(a: StreamDescriptor, b: StreamDescriptor): number {
  const left = downloadOptions(a)[0];
  const right = downloadOptions(b)[0];
  return Number(!!right) - Number(!!left)
    || compareVideoQuality(left?.variant ?? null, right?.variant ?? null)
    || Number(b.capabilities.directDownload) - Number(a.capabilities.directDownload);
}

export function isDownloadableCandidate(descriptor: StreamDescriptor): boolean {
  return downloadOptions(descriptor).length > 0;
}
