/** Part of a file, as a manifest or playlist states it. */
export interface FileRange {
  readonly offset: number;
  readonly length: number;
}

/**
 * Where a file ends when `ranges`, in the order given, cover it from its
 * first byte without a gap or an overlap: the offset after the last range.
 * Such ranges are a statement about one whole file, so the file can be read
 * as one. Null when a range is missing, empty, out of order or leaves a gap:
 * those ranges do not say what the whole file is.
 */
export function coveredFileEnd(ranges: readonly (FileRange | null | undefined)[]): number | null {
  let end = 0;
  for (const range of ranges) {
    if (!range || range.offset !== end || !(range.length > 0)) return null;
    end += range.length;
  }
  return ranges.length > 0 && Number.isSafeInteger(end) ? end : null;
}

/**
 * The same for ranges that may leave bytes out between them: where the file
 * ends, and the stretches no range names. The ranges start at the file's
 * first byte and only move forward, never over one another. Null when a
 * range is missing, empty, out of order or overlaps the one before it. What
 * the left-out stretches hold is for the caller to check once it has the file.
 */
export function coveredFileWithGaps(ranges: readonly (FileRange | null | undefined)[]): { readonly end: number; readonly gaps: FileRange[] } | null {
  let end = 0;
  const gaps: FileRange[] = [];
  for (const [index, range] of ranges.entries()) {
    if (!range || !(range.length > 0) || range.offset < end || (index === 0 && range.offset !== 0)) return null;
    if (range.offset > end) gaps.push({ offset: end, length: range.offset - end });
    end = range.offset + range.length;
  }
  return ranges.length > 0 && Number.isSafeInteger(end) ? { end, gaps } : null;
}
