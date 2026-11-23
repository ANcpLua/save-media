// Small decorative marks, drawn inline and hidden from assistive technology.
// They are never a button's only name.
const common = { "aria-hidden": true, focusable: false, viewBox: "0 0 16 16", fill: "currentColor" } as const;

export function PlayIcon({ className = "w-4 h-4" }: { readonly className?: string }) {
  return <svg {...common} className={className}><path d="M4 2.5v11l9-5.5z"/></svg>;
}

export function DownloadIcon({ className = "w-3 h-3" }: { readonly className?: string }) {
  return <svg {...common} className={className}><path d="M7 1h2v7.2l2.3-2.3 1.4 1.4L8 12 3.3 7.3l1.4-1.4L7 8.2zM2 13h12v2H2z"/></svg>;
}

export function ChevronIcon({ open, className = "w-3 h-3" }: { readonly open: boolean; readonly className?: string }) {
  return <svg {...common} className={className}><path d={open ? "M2.5 5l5.5 6 5.5-6z" : "M5 2.5l6 5.5-6 5.5z"}/></svg>;
}

export function CheckIcon({ className = "w-3 h-3" }: { readonly className?: string }) {
  return <svg {...common} className={className}><path d="M6.2 12.6L1.8 8.2l1.4-1.4 3 3 6.6-6.6 1.4 1.4z"/></svg>;
}
