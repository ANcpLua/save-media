import { Fragment } from "react";
import type { TechnicalDetail } from "@savemedia/core";
import { POPUP } from "../../ui/text";

interface Props {
  readonly rows: readonly TechnicalDetail[];
  /** "failure": what went wrong, in codes and servers. "item": the listed item's own facts. A card can show both, so each is named. */
  readonly about?: "failure" | "item";
}

/**
 * Codes, statuses, hosts and other technical facts, closed until the user
 * opens them. One labelled row per fact: a value is its own element and is
 * never joined to another.
 */
export function TechnicalDetails({ rows, about = "failure" }: Props) {
  if (!rows.length) return null;
  return (
    <details className="text-muted mt-1" data-testid={about === "item" ? "item-details" : "technical-details"}>
      <summary className="cursor-pointer">{about === "item" ? POPUP.aboutItem : POPUP.technicalDetails}</summary>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        {rows.map(row => (
          <Fragment key={row.label}>
            <dt className="text-neutral-500">{row.label}</dt>
            <dd className="break-words min-w-0">{row.value}</dd>
          </Fragment>
        ))}
      </dl>
    </details>
  );
}
