// A listed row never carries a stream's whole segment list. Nothing outside
// the engine reads the list: a save reads the playlist or manifest again when
// it starts, as the page's player does. What a row keeps is an even sample,
// enough to recognise the page's later requests as this stream's. A row
// therefore has a bounded size in the worker's memory, in session storage
// and in what the popup receives, however long the stream is.
import type { StreamDescriptor, Variant } from "@savemedia/core";

/** Segment addresses a row keeps in total, as an even sample across its tracks. */
export const MAX_KEPT_PARTS = 240;
/** The most text those kept addresses hold together. */
export const MAX_KEPT_PART_BYTES = 32 * 1024;
/** The most text one row may hold after thinning. A larger one is not listed. */
export const MAX_ROW_BYTES = 512 * 1024;

function listOf(variant: Variant): readonly string[] {
  const ref = variant.segmentRef;
  return ref.kind === "hls-segments" ? ref.segmentUrls : ref.kind === "dash-segments" ? ref.mediaUrls : [];
}

/** The indexes of an even sample of `keep` entries, always with the first. */
function sampleIndexes(length: number, keep: number): number[] {
  const step = Math.ceil(length / keep);
  const indexes: number[] = [];
  for (let index = 0; index < length; index += step) indexes.push(index);
  return indexes;
}

function thinVariant(variant: Variant, keep: number, bytes: number): Variant {
  const ref = variant.segmentRef;
  const list = listOf(variant);
  // An address of this track stands for the others: a stream's segment addresses differ in a counter.
  const limit = Math.max(1, Math.min(keep, Math.floor(bytes / Math.max(1, list[0]?.length ?? 1))));
  if (list.length <= limit) return variant;
  const indexes = sampleIndexes(list.length, limit);
  const kept = indexes.map(index => list[index]!);
  if (ref.kind === "hls-segments") {
    // The keys stay aligned with the addresses they belong to.
    const keys = ref.segmentKeys?.length === list.length ? { segmentKeys: indexes.map(index => ref.segmentKeys![index]!) } : {};
    return { ...variant, segmentRef: { ...ref, segmentUrls: kept, ...keys } };
  }
  if (ref.kind === "dash-segments") return { ...variant, segmentRef: { ...ref, mediaUrls: kept } };
  return variant;
}

/**
 * The descriptor with each track's segment list cut down to its sample. A
 * list that was empty stays empty and one that had entries keeps at least
 * one, so what can be saved is decided as before. Returns the descriptor
 * itself when nothing was cut.
 */
export function thinDescriptor(descriptor: StreamDescriptor): StreamDescriptor {
  const tracks = [...descriptor.variants, ...(descriptor.audioRenditions ?? [])];
  const long = tracks.filter(track => listOf(track).length > 1).length;
  if (!long) return descriptor;
  const keep = Math.max(1, Math.floor(MAX_KEPT_PARTS / long));
  let cut = false;
  const thin = (variant: Variant): Variant => {
    const next = thinVariant(variant, keep, MAX_KEPT_PART_BYTES / long);
    if (next !== variant) cut = true;
    return next;
  };
  const variants = descriptor.variants.map(thin);
  const audioRenditions = descriptor.audioRenditions?.map(thin);
  if (!cut) return descriptor;
  return { ...descriptor, variants, ...(audioRenditions ? { audioRenditions } : {}) };
}

const sizes = new WeakMap<StreamDescriptor, number>();

/** The row's size as text: what it costs in memory, in storage and in a message, near enough. */
export function rowBytes(descriptor: StreamDescriptor): number {
  let size = sizes.get(descriptor);
  if (size === undefined) {
    size = JSON.stringify(descriptor).length;
    sizes.set(descriptor, size);
  }
  return size;
}
