/** 1024-based units labelled KB, MB and GB, the way the browser's Downloads page shows sizes. */
export function formatBytes(n: number): string {
  const bytes = Number.isFinite(n) && n > 0 ? n : 0;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
