import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export type Urgency = "polite" | "assertive";
type Announce = (text: string, urgency?: Urgency) => void;

const AnnounceContext = createContext<Announce>(() => undefined);

/** The same words within this time are one announcement. */
const REPEAT_WINDOW_MS = 1_000;

/**
 * The popup's two live regions: one polite, one for failures. They are
 * mounted empty and are the only live regions in the popup. Text reaches
 * them only through announce(), which is called for things that happen
 * while the popup is open. What the popup already shows when it opens is
 * rendered, not announced.
 */
export function AnnouncerProvider({ children }: { readonly children: ReactNode }) {
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const last = useRef<{ text: string; urgency: Urgency; at: number } | null>(null);
  const frames = useRef<number[]>([]);

  useEffect(() => () => { for (const frame of frames.current) cancelAnimationFrame(frame); }, []);

  const announce = useCallback<Announce>((text, urgency = "polite") => {
    if (!text) return;
    const now = Date.now();
    const previous = last.current;
    if (previous && previous.text === text && previous.urgency === urgency && now - previous.at < REPEAT_WINDOW_MS) return;
    last.current = { text, urgency, at: now };
    const set = urgency === "assertive" ? setAssertive : setPolite;
    // Emptied, then filled in the next frame: a region whose text does not change is not announced again.
    set("");
    frames.current.push(requestAnimationFrame(() => set(text)));
  }, []);

  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="announce-polite">{polite}</div>
      <div className="sr-only" role="alert" aria-atomic="true" data-testid="announce-alert">{assertive}</div>
    </AnnounceContext.Provider>
  );
}

export function useAnnounce(): Announce {
  return useContext(AnnounceContext);
}
