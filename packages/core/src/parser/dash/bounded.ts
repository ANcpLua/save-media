// A DASH manifest is counted before it is expanded. The count comes from
// mpd-parser's own stage before expansion (inheritAttributes), which has
// already applied template inheritance, BaseURL combinations and XML
// decoding, so the numbers counted are the numbers the parser would build.
// Counting the raw text instead misses every one of those.
import { inheritAttributes, stringToMpdXml, toM3u8, toPlaylists, type MpdElement, type MpdManifest, type RepresentationInfo } from "mpd-parser";
import { manifestTooLarge, MAX_DASH_BASE_URL_COMBINATIONS, MAX_MANIFEST_ADDRESS_BYTES, MAX_SEGMENTS_PER_MANIFEST, MAX_SEGMENTS_PER_TRACK } from "../limits";

export interface DashSegmentEstimate {
  /** The largest number of segments one representation expands to. */
  readonly perTrack: number;
  readonly total: number;
}

function children(node: MpdElement, name: string): MpdElement[] {
  const found: MpdElement[] = [];
  const list = node.childNodes;
  for (let index = 0; index < (list?.length ?? 0); index++) {
    const child = list![index];
    if (child?.tagName === name) found.push(child);
  }
  return found;
}

/**
 * How many base address combinations mpd-parser builds: it multiplies the
 * BaseURL elements of the MPD, each Period, each AdaptationSet and each
 * Representation, also for levels that hold no representation.
 */
export function dashBaseUrlCombinations(mpd: MpdElement): number {
  const bases = (node: MpdElement): number => Math.max(1, children(node, "BaseURL").length);
  const root = bases(mpd);
  let total = root;
  for (const period of children(mpd, "Period")) {
    const inPeriod = root * bases(period);
    total += inPeriod;
    for (const set of children(period, "AdaptationSet")) {
      const inSet = inPeriod * bases(set);
      total += inSet;
      for (const representation of children(set, "Representation")) total += inSet * bases(representation);
    }
  }
  return total;
}

/**
 * An attribute as the parser's own arithmetic reads it. The parser stores
 * numbers, and null for a period start it could not work out, which its
 * arithmetic counts as zero; the same arithmetic runs here.
 */
const numberOf = (value: unknown, missing = NaN): number => value === undefined ? missing : value as number;

/** The iterations of mpd-parser's `for (i = start; i < end; i++)`. */
function rangeCount(start: number, end: number): number {
  return end > start ? Math.ceil(end - start) : 0;
}

/** mpd-parser's segmentRange: how many segments a fixed @duration expands to. */
function countByDuration(attributes: Record<string, unknown>): number {
  const duration = numberOf(attributes.duration);
  const timescale = numberOf(attributes.timescale, 1);
  const stated = attributes.endNumber;
  const parsedEnd = stated && typeof stated !== "number" ? parseInt(String(stated), 10) : stated;
  const endNumber = typeof parsedEnd === "number" && !Number.isNaN(parsedEnd) ? parsedEnd : null;
  if (attributes.type !== "dynamic") {
    if (endNumber !== null) return rangeCount(0, endNumber);
    const section = typeof attributes.periodDuration === "number" ? attributes.periodDuration : numberOf(attributes.sourceDuration);
    return rangeCount(0, section / (duration / timescale));
  }
  const now = (numberOf(attributes.NOW) + numberOf(attributes.clientOffset)) / 1000;
  const periodStart = numberOf(attributes.periodStart, 0);
  const update = numberOf(attributes.minimumUpdatePeriod, 0);
  const depth = numberOf(attributes.timeShiftBufferDepth, Infinity);
  const startWallClock = numberOf(attributes.availabilityStartTime) + periodStart;
  const segmentCount = Math.ceil((now + update - startWallClock) * timescale / duration);
  const availableStart = Math.floor((now - startWallClock - depth) * timescale / duration);
  const availableEnd = Math.floor((now - startWallClock) * timescale / duration);
  return rangeCount(Math.max(0, availableStart), endNumber !== null ? endNumber : Math.min(segmentCount, availableEnd));
}

/** mpd-parser's parseByTimeline: the segments a SegmentTimeline expands to. */
function countByTimeline(attributes: Record<string, unknown>, timeline: readonly Record<string, unknown>[]): number {
  const timescale = numberOf(attributes.timescale, 1);
  const media = typeof attributes.media === "string" ? attributes.media : "";
  const update = numberOf(attributes.minimumUpdatePeriod, 0);
  let total = 0;
  let time = -1;
  for (let index = 0; index < timeline.length; index++) {
    const entry = timeline[index]!;
    const duration = entry.d as number;
    const repeat = (entry.r as number) || 0;
    const at = (entry.t as number) || 0;
    if (time < 0) time = at;
    if (at && at > time) time = at;
    let count: number;
    if (repeat < 0) {
      if (index + 1 === timeline.length) {
        if (attributes.type === "dynamic" && update > 0 && media.indexOf("$Number$") > 0) {
          const now = (numberOf(attributes.NOW) + numberOf(attributes.clientOffset)) / 1000;
          const periodStart = numberOf(attributes.periodStart, 0);
          const periodDuration = now + update - (numberOf(attributes.availabilityStartTime) + periodStart);
          count = Math.ceil((periodDuration * timescale - time) / duration);
        } else count = (numberOf(attributes.sourceDuration) * timescale - time) / duration;
      } else count = ((timeline[index + 1]!.t as number) - time) / duration;
    } else count = repeat + 1;
    const made = count > 0 ? Math.ceil(count) : 0;
    total += made;
    if (!(total <= Number.MAX_SAFE_INTEGER)) return Infinity;
    time += duration * made;
  }
  return total;
}

/**
 * The entries mpd-parser's toPlaylists would build for one representation.
 * It mirrors generateSegments: a template, then a base, then a list, each
 * with the attributes merged the way the parser merges them.
 */
export function representationSegments(info: RepresentationInfo): number {
  const { segmentInfo, attributes } = info;
  const timeline = segmentInfo.segmentTimeline;
  if (segmentInfo.template) {
    const merged = { ...attributes, ...segmentInfo.template };
    if (!merged.duration && !timeline) return 1;
    return merged.duration ? countByDuration(merged) : countByTimeline(merged, timeline ?? []);
  }
  if (segmentInfo.base) {
    const merged = { ...attributes, ...segmentInfo.base };
    // A SegmentBase is one segment, but a @duration on it is expanded first.
    return merged.duration ? Math.max(1, countByDuration(merged)) : 1;
  }
  if (segmentInfo.list) {
    const merged = { ...attributes, ...segmentInfo.list };
    // The whole time line is expanded before it is matched to the listed addresses.
    const listed = Array.isArray(merged.segmentUrls) ? merged.segmentUrls.length : 0;
    return Math.max(listed, merged.duration ? countByDuration(merged) : timeline ? countByTimeline(merged, timeline) : 0);
  }
  return 0;
}

function estimate(representations: readonly RepresentationInfo[]): DashSegmentEstimate {
  let perTrack = 0;
  let total = 0;
  for (const representation of representations) {
    const count = representationSegments(representation);
    // A count that is not a number (an endless or broken declaration) never passes.
    if (!(count <= Number.MAX_SAFE_INTEGER)) return { perTrack: Infinity, total: Infinity };
    perTrack = Math.max(perTrack, count);
    total += count;
  }
  return { perTrack, total };
}

const textOf = (value: unknown): string => typeof value === "string" ? value : "";

/**
 * The most characters a segment template stands for once its identifiers are
 * filled in: $RepresentationID$ becomes the id, and a number, time or bit
 * rate becomes at most twenty digits, or the width its format asks for.
 */
function templateLength(template: string, representationId: string): number {
  let length = template.length;
  for (const match of template.matchAll(/\$([A-Za-z]*)(?:%0([0-9]+)d)?\$/g)) {
    length += match[1] === "RepresentationID" ? representationId.length : Math.max(20, Number(match[2] ?? 0));
  }
  return length;
}

/**
 * An upper bound of the address text mpd-parser builds for the segments of
 * these representations: each segment's address is its base address joined
 * with its filled-in template or its listed name.
 */
export function dashAddressEstimate(representations: readonly RepresentationInfo[]): number {
  let total = 0;
  for (const representation of representations) {
    const count = representationSegments(representation);
    if (!(count <= Number.MAX_SAFE_INTEGER)) return Infinity;
    const { attributes, segmentInfo } = representation;
    const base = textOf(attributes.baseUrl).length;
    const id = textOf(attributes.id);
    let name = 0;
    if (segmentInfo.template) name = templateLength(textOf({ ...attributes, ...segmentInfo.template }.media), id);
    else if (segmentInfo.list) {
      const listed = { ...attributes, ...segmentInfo.list }.segmentUrls;
      for (const item of Array.isArray(listed) ? listed : []) name = Math.max(name, textOf((item as Record<string, unknown>)?.media).length);
    }
    total += count * (base + name);
    if (!(total <= Number.MAX_SAFE_INTEGER)) return Infinity;
  }
  return total;
}

function inherit(xml: string, manifestUri: string, nowMs: number) {
  const mpd = stringToMpdXml(xml);
  if (dashBaseUrlCombinations(mpd) > MAX_DASH_BASE_URL_COMBINATIONS) throw manifestTooLarge(manifestUri, "segments");
  return inheritAttributes(mpd, { manifestUri, NOW: nowMs });
}

/** How many segments mpd-parser would expand an MPD to, without expanding it. */
export function dashSegmentEstimate(xml: string, nowMs: number = Date.now(), manifestUri = ""): DashSegmentEstimate {
  return estimate(inherit(xml, manifestUri, nowMs).representationInfo);
}

/**
 * mpd-parser's parse, refused with manifest_too_large before anything is
 * expanded when the manifest declares more than the limits allow.
 */
export function parseMpdBounded(xml: string, manifestUri: string, nowMs: number = Date.now()): MpdManifest {
  const info = inherit(xml, manifestUri, nowMs);
  const { perTrack, total } = estimate(info.representationInfo);
  if (!(perTrack <= MAX_SEGMENTS_PER_TRACK) || !(total <= MAX_SEGMENTS_PER_MANIFEST)) throw manifestTooLarge(manifestUri, "segments");
  // A long base address or a wide number format times many segments: refused before a single address is built.
  if (!(dashAddressEstimate(info.representationInfo) <= MAX_MANIFEST_ADDRESS_BYTES)) throw manifestTooLarge(manifestUri, "segments");
  return toM3u8({
    dashPlaylists: toPlaylists(info.representationInfo),
    locations: info.locations,
    contentSteering: info.contentSteeringInfo,
    eventStream: info.eventStream,
  });
}
