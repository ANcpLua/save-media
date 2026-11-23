import { createContext, useContext } from "react";
import type { JobError } from "@savemedia/core";
import { isDelegableError } from "../../native/local-downloader";
import { LOCAL } from "../../ui/text";

/** What the popup knows about the Local downloader, for the failures it may handle. */
export interface LocalOffer {
  /** off: the user has not turned it on. ready: on, with the helper and its tools found. unavailable: on, but not usable now. */
  readonly state: "off" | "ready" | "unavailable";
  /** Hand the page to the Local downloader. */
  readonly save: () => void;
}

export const LocalOfferContext = createContext<LocalOffer | null>(null);

/**
 * Under a failure the Local downloader may handle: a pointer to it while it
 * is off, a button once it is ready. Never under protected media: those
 * codes are not on the list of failures it is offered for.
 */
export function LocalOfferSlot({ error }: { readonly error: JobError }) {
  const offer = useContext(LocalOfferContext);
  if (!offer || !isDelegableError(error)) return null;
  if (offer.state === "off") return <p className="mt-1 text-muted" data-testid="local-offer">{LOCAL.offerWhenOff}</p>;
  if (offer.state !== "ready") return null;
  return (
    <button type="button" onClick={offer.save} data-testid="local-offer"
      className="mt-1.5 rounded-md bg-surface-2 hover:bg-neutral-600 px-2.5 py-1 text-xs font-medium text-white">
      {LOCAL.offerButton}
    </button>
  );
}
