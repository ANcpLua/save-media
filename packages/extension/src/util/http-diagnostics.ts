import { z } from "zod";

/** The part of a response this module reads. The engine's own response type has this shape. */
export interface ObservedResponse {
  readonly url?: string | undefined;
  readonly status: number;
  readonly headers: { forEach(callback: (value: string, name: string) => void): void };
}

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hostField = z.string().max(253).regex(/^[a-z0-9.:[\]-]*$/i);
const requestRange = /^bytes=\d{1,16}-\d{0,16}$/i;
const contentRange = /^bytes (?:\d{1,16}-\d{1,16}|\*)\/(?:\d{1,16}|\*)$/i;
const networkCode = /^(?:net::ERR_|NS_ERROR_)[A-Z0-9_]{1,80}$/;
const readOutcome = z.enum(["complete", "prefix-read", "ended-early", "read-error", "cancelled", "timed-out", "range-rejected"]);

export const httpObservationSchema = z.object({
  host: hostField, finalHost: hostField.nullable(), status: count.max(599).nullable(),
  requestRange: z.string().regex(requestRange).nullable(), contentRange: z.string().regex(contentRange).nullable(),
  declaredBytes: count.nullable(), ifRange: z.enum(["none", "etag", "date", "other"]),
  acceptRanges: z.enum(["bytes", "none", "other"]).nullable(),
  validator: z.enum(["strong-etag", "weak-etag", "last-modified", "other"]).nullable(),
  hasETag: z.boolean(), hasLastModified: z.boolean(), elapsedMs: count,
  browserCode: z.string().regex(networkCode).optional(), bodyBytes: count.optional(),
  readOutcome: readOutcome.optional(),
  requestNumber: count.optional(),
  waitMs: count.optional(), receiveMs: count.optional(),
});
export type HttpObservation = z.infer<typeof httpObservationSchema>;
export type HttpReporter = (event: HttpObservation) => void;
type ReadOutcome = z.infer<typeof readOutcome>;
const bodyReports = new WeakMap<ObservedResponse, (bytes: number, outcome: ReadOutcome) => void>();

/** The existing reader reports its own count once. No additional reader or
 * clone competes with the actual transfer. */
export function reportHttpBody(response: ObservedResponse, bytes: number, outcome: ReadOutcome) {
  const report = bodyReports.get(response);
  if (!report) return;
  bodyReports.delete(response);
  try { report(bytes, outcome); } catch { /* Reporting cannot affect the reader. */ }
}

export function httpReadFailure(error: unknown): ReadOutcome {
  if (error instanceof Error && error.name === "TimeoutError") return "timed-out";
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  return "read-error";
}

export function diagnosticHost(address: string): string {
  try { return new URL(address).hostname; } catch { return ""; }
}

type Header = (name: string) => string | null;

/** Project HTTP metadata before it crosses an extension context or enters storage. */
export function httpObservation(url: string, finalUrl: string | undefined, status: number | null,
  request: Header, response: Header, elapsedMs: number): HttpObservation {
  const requested = request("range")?.trim() ?? "";
  const returned = response("content-range")?.trim() ?? "";
  const length = response("content-length")?.trim() ?? "";
  const condition = request("if-range");
  const acceptRanges = response("accept-ranges")?.trim().toLowerCase();
  const etag = response("etag")?.trim();
  const lastModified = !!response("last-modified");
  const host = diagnosticHost(url);
  const finalHost = finalUrl ? diagnosticHost(finalUrl) : host;
  const declared = /^\d{1,16}$/.test(length) ? Number(length) : NaN;
  return {host, finalHost: finalHost === host ? null : finalHost, status,
    requestRange: requestRange.test(requested) ? requested : null,
    contentRange: contentRange.test(returned) ? returned : null, declaredBytes: Number.isSafeInteger(declared) ? declared : null,
    ifRange: !condition ? "none" : condition.startsWith('"') ? "etag" : Number.isFinite(Date.parse(condition)) ? "date" : "other",
    acceptRanges: !acceptRanges ? null : acceptRanges === "bytes" || acceptRanges === "none" ? acceptRanges : "other",
    validator: etag?.startsWith('"') ? "strong-etag" : etag?.startsWith('W/"') ? "weak-etag" : lastModified ? "last-modified" : etag ? "other" : null,
    hasETag: !!etag, hasLastModified: lastModified, elapsedMs: Math.max(0, Math.round(elapsedMs))};
}

type FetchShape<I, R> = (url: string, init: I) => Promise<R>;

/** Keep the original Response. Observing headers must never clone, drain or
 * otherwise change the transport's stream. */
export function observeFetch<I extends {readonly headers?: HeadersInit}, R extends ObservedResponse>(
  transport: FetchShape<I, R>, report: HttpReporter,
): FetchShape<I, R> {
  let requestCount = 0;
  return async (url: string, init: I): Promise<R> => {
    const requestNumber = ++requestCount;
    const start = performance.now();
    const request = new Headers(init.headers);
    let response: R | undefined;
    let code: string | undefined;
    try {
      response = await transport(url, init);
      return response;
    } catch (error) {
      if (error && typeof error === "object" && "diagnostic" in error) {
        const diagnostic = error.diagnostic as {code?: unknown} | null;
        if (typeof diagnostic?.code === "string" && networkCode.test(diagnostic.code)) code = diagnostic.code;
      }
      throw error;
    } finally {
      try {
        const headers = new Map<string, string>();
        response?.headers.forEach((value, name) => {
          if (["content-range", "content-length", "content-encoding", "accept-ranges", "etag", "last-modified"].includes(name.toLowerCase())) headers.set(name.toLowerCase(), value);
        });
        const headersAt = performance.now();
        const event = {...httpObservation(url, response?.url, response?.status ?? null, name => request.get(name),
          name => headers.get(name) ?? null, headersAt - start), requestNumber};
        if (response) bodyReports.set(response, (bytes, outcome) => report({...event, bodyBytes: bytes,
          readOutcome: outcome, receiveMs: Math.max(0, Math.round(performance.now() - headersAt))}));
        report(code ? {...event, browserCode: code} : event);
      } catch { /* Diagnostics cannot interrupt the transfer. */ }
    }
  };
}
