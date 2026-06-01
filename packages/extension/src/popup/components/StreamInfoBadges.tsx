// Static capability legend shown at the bottom of the popup. It advertises
// savemedia's fixed product boundary — what it saves and what it refuses — and
// is intentionally NOT derived from the current detections: it is the same on
// every page so users understand the tool's scope before they trust it.

interface Badge {
  readonly label: string;
  readonly supported: boolean;
}

const BADGES: readonly Badge[] = [
  { label: "MP4", supported: true },
  { label: "HLS VOD", supported: true },
  { label: "DASH", supported: false },
  { label: "Encrypted/DRM", supported: false },
];

export function StreamInfoBadges() {
  return (
    <div className="px-3 pt-3 pb-1" data-testid="stream-info">
      <p className="text-[11px] font-medium text-muted mb-1.5">Stream support</p>
      <ul className="flex flex-wrap gap-1.5">
        {BADGES.map(b => (
          <li
            key={b.label}
            className={
              b.supported
                ? "inline-flex items-center gap-1 rounded-md bg-emerald-600/90 text-white px-2 py-0.5 text-[11px] font-medium"
                : b.label === "Encrypted/DRM"
                  ? "inline-flex items-center gap-1 rounded-md bg-red-600/90 text-white px-2 py-0.5 text-[11px] font-medium"
                  : "inline-flex items-center gap-1 rounded-md bg-surface-2 text-muted px-2 py-0.5 text-[11px] font-medium"
            }
          >
            {b.label}
            <span aria-hidden="true">{b.supported ? "✓" : "✗"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
