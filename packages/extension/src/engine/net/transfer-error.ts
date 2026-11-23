import { isCertificateError, type BrowserRequestDiagnostic } from "@savemedia/core";
import type { EmptyBody, RangeMetadata } from "./range-recovery";

/** A request the browser failed, with the network error code it reported for it. */
export class BrowserFetchError extends TypeError {
  constructor(readonly diagnostic: BrowserRequestDiagnostic) {
    super("The browser could not complete the media request");
  }
}

/**
 * Why a transfer stopped. The set is closed: every failure is created with
 * one of these reasons at the transport boundary (fetch, body reads, status
 * and range checks), retry decisions read the reason, and range-recovery's
 * rangeFailure maps it to one JobError. No reason carries English text.
 */
export type TransferReason =
  /** A non-2xx response. */
  | "http-status"
  /** fetch rejected, or the body stream failed. */
  | "network"
  /** No bytes arrived within the stall window. */
  | "timeout"
  /** An HTTPS request ended on HTTP. */
  | "insecure-redirect"
  /** The body ended before its announced length. */
  | "body-short"
  /** The body exceeded its announced or requested length. */
  | "body-long"
  /** HTTP 200 to a Range request. */
  | "range-ignored"
  /** HTTP 400, 416 or 501 to a Range request: the server does not resume. */
  | "range-refused"
  /** Content-Range does not match the request. */
  | "range-mismatch"
  /** Content-Length contradicts Content-Range. */
  | "range-length"
  /** HTTP 206 that delivered no usable bytes. */
  | "range-empty"
  /** The server returns too few bytes per range request to finish. */
  | "range-slices"
  /** A byte range with a Content-Encoding cannot be reassembled. */
  | "range-encoded"
  /** No ETag, Last-Modified date or whole-file checksum proves the rest is the same file. */
  | "no-validator"
  /** The file length, validator or type changed between requests. */
  | "changed"
  /** Retained bytes differ from the current file. */
  | "content-mismatch"
  /** The assembled file does not match the server's whole-file checksum. */
  | "checksum"
  /** The link now leads to another resource. */
  | "redirected";

export interface TransferFacts {
  /** The address of the request that failed. Only its host leaves the engine. */
  readonly url: string;
  readonly status?: number | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly during?: "request" | "body" | undefined;
  /** Bytes of the file in hand when the transfer stopped. */
  readonly received?: number | undefined;
  /** Bytes the response or the file announced. */
  readonly expected?: number | null | undefined;
  /** The requested range when a range failed. */
  readonly range?: { readonly start: number; readonly end: number; readonly total: number } | undefined;
  readonly declaredLength?: number | null | undefined;
  /** File identity a contradictory range still established. */
  readonly metadata?: RangeMetadata | null | undefined;
  readonly emptyBody?: EmptyBody | undefined;
  readonly diagnostic?: BrowserRequestDiagnostic | undefined;
  readonly digest?: { readonly expected: string; readonly actual: string } | undefined;
  /** Automatic reconnects made before the transfer stopped. */
  readonly reconnects?: number | undefined;
  /** The request's own quick retries were made and are spent (fetchWithRetry). */
  readonly retriesSpent?: boolean | undefined;
}

/**
 * What a failure means for the bytes of the file received before it:
 * keep: they stay valid, and a later request can continue from them, after
 *   an outage within the job or with Retry save;
 * drop: they stay valid, but the server lets nothing continue from them, so
 *   nothing is kept and Retry save starts from byte zero;
 * restart: they belong to another version of the file; they are dropped and
 *   the file is read once more from byte zero.
 */
export type RetainedOutcome = "keep" | "drop" | "restart";

interface ReasonPolicy {
  /** Repeating the same request can succeed. For HTTP statuses the status decides. */
  readonly retryable: boolean;
  /** No usable answer arrived (no response, a stalled one, or a busy server): waiting and reconnecting can help. */
  readonly outage: boolean;
  readonly retained: RetainedOutcome;
}

/** The one policy table: retries, reconnects and retained bytes all read it. */
const POLICY: Readonly<Record<TransferReason, ReasonPolicy>> = {
  "http-status": { retryable: false, outage: true, retained: "keep" },
  network: { retryable: true, outage: true, retained: "keep" },
  timeout: { retryable: true, outage: true, retained: "keep" },
  "insecure-redirect": { retryable: false, outage: false, retained: "drop" },
  "body-short": { retryable: true, outage: false, retained: "keep" },
  "body-long": { retryable: false, outage: false, retained: "drop" },
  "range-ignored": { retryable: false, outage: false, retained: "drop" },
  "range-refused": { retryable: false, outage: false, retained: "drop" },
  "range-mismatch": { retryable: false, outage: false, retained: "drop" },
  "range-length": { retryable: false, outage: false, retained: "drop" },
  "range-empty": { retryable: false, outage: false, retained: "keep" },
  "range-slices": { retryable: false, outage: false, retained: "drop" },
  "range-encoded": { retryable: false, outage: false, retained: "drop" },
  "no-validator": { retryable: false, outage: false, retained: "drop" },
  changed: { retryable: false, outage: false, retained: "restart" },
  "content-mismatch": { retryable: false, outage: false, retained: "restart" },
  checksum: { retryable: false, outage: false, retained: "restart" },
  redirected: { retryable: false, outage: false, retained: "drop" },
};

/** Statuses that refuse who asked: nothing kept would be served on a later request either. */
const REFUSED_ACCESS = new Set([401, 402, 403, 451]);

export class TransferError extends Error {
  readonly retryable: boolean;

  constructor(readonly reason: TransferReason, readonly facts: TransferFacts, retryable = POLICY[reason].retryable) {
    super(facts.status === undefined ? reason : `${reason} ${facts.status}`);
    this.name = "TransferError";
    this.retryable = retryable;
  }

  /** The same failure with more facts or a final retry decision. */
  with(facts: Partial<TransferFacts>, retryable = this.retryable): TransferError {
    return new TransferError(this.reason, { ...this.facts, ...facts }, retryable);
  }
}

export function isTransferError(error: unknown, ...reasons: readonly TransferReason[]): error is TransferError {
  return error instanceof TransferError && (reasons.length === 0 || reasons.includes(error.reason));
}

/** A retry of the same request can still succeed. */
export function isInterruptedRead(error: unknown): error is TransferError {
  return error instanceof TransferError && error.retryable;
}

/** What the failure means for bytes received before it; anything that is not a transfer failure drops them. */
export function retainedOutcome(error: unknown): RetainedOutcome {
  if (!(error instanceof TransferError)) return "drop";
  if (error.reason === "http-status" && REFUSED_ACCESS.has(error.facts.status ?? 0)) return "drop";
  return POLICY[error.reason].retained;
}

/** A network outage or a busy server that may answer after a wait: the only failures a job reconnects after. */
export function isOutage(error: unknown): error is TransferError {
  return isInterruptedRead(error) && POLICY[error.reason].outage;
}

/**
 * An outage a save may come back to after a wait. A request whose own quick retries are spent is not
 * repeated at once (it is no longer retryable), but a reconnect after the wait is a new try.
 */
export function isOutageAfterRetries(error: unknown): error is TransferError {
  return error instanceof TransferError && POLICY[error.reason].outage && (error.retryable || error.facts.retriesSpent === true);
}

/**
 * Turns a fetch or stream failure into a transfer failure at the boundary
 * where it happens. Cancellation and other errors pass through unchanged.
 */
export function transportFailure(error: unknown, url: string, during: "request" | "body",
  received?: number, expected?: number | null): unknown {
  if (error instanceof TransferError) return error;
  const facts = { url, during, received, expected };
  if (error instanceof BrowserFetchError) {
    return new TransferError("network", { ...facts, diagnostic: error.diagnostic }, !isCertificateError(error.diagnostic.code));
  }
  if (error instanceof TypeError) return new TransferError("network", facts);
  if (error instanceof Error && error.name === "TimeoutError") return new TransferError("timeout", facts);
  return error;
}
