// Adds the browser's account of savemedia's own request to a failure the
// user's network can explain. It reads what request-outcomes.ts recorded and
// requests nothing. The text is written from the result in core.
import type { BrowserRequestDiagnostic, JobError } from "@savemedia/core";
import { diagnosticOf, type RequestOutcome, type RequestOutcomes } from "./request-outcomes";

/** Failures where a server answered: the address it answered from and a redirect can explain them. */
const ANSWERED = new Set<JobError["code"]>(["unexpected_media_response", "access_denied", "http_error", "server_busy", "hls_key_unusable", "transfer_failed"]);
/** Failures where no answer arrived: the browser's error code explains them. */
const UNANSWERED = new Set<JobError["code"]>(["network_unreachable", "tls_certificate_rejected"]);

function hostOf(url: string | undefined): string | null {
  try { return url ? new URL(url).host || null : null; } catch { return null; }
}

/** The server the failure is about: the one it names, else the job's or the check's own address. */
function hostOfError(error: JobError, address: string): string | null {
  const fields = error as { readonly browserDiagnostic?: BrowserRequestDiagnostic; readonly host?: string; readonly url?: string; readonly keyUri?: string };
  return fields.browserDiagnostic?.host ?? fields.host ?? hostOf(fields.url) ?? hostOf(fields.keyUri) ?? hostOf(address);
}

/** What the failure already knows stays; what it lacks is taken from the browser's report. */
function merged(known: BrowserRequestDiagnostic | undefined, outcome: RequestOutcome): BrowserRequestDiagnostic {
  const reported = diagnosticOf(outcome);
  if (!known) return reported;
  return { host: known.host, code: known.code ?? reported.code, ip: known.ip ?? reported.ip, finalHost: known.finalHost ?? reported.finalHost,
    redirect: known.redirect ?? reported.redirect };
}

/**
 * The report without its server addresses. Where the browser reaches the tab's own page at an address inside
 * the user's network (a proxy there, or a network that names its own servers), the address it reports for a
 * request is the proxy's or says nothing new: a failure is then never explained as "a public name at a local
 * address". The browser's error code, a redirect and the server's own answer still explain it.
 */
function withoutAddresses(report: BrowserRequestDiagnostic): BrowserRequestDiagnostic {
  return { ...report, ip: null, redirect: report.redirect ? { ...report.redirect, fromIp: null } : null };
}

/**
 * The failure with the given report attached, when it is a failure a report explains.
 * `addressesSayNothing`: see withoutAddresses.
 */
export function withOutcome(error: JobError, outcome: RequestOutcome | null, address: string, addressesSayNothing = false): JobError {
  if (!ANSWERED.has(error.code) && !UNANSWERED.has(error.code)) return error;
  const named = error.code === "unexpected_media_response" && !error.host ? { ...error, host: hostOf(address) ?? outcome?.host ?? "" } : error;
  const known = (named as { readonly browserDiagnostic?: BrowserRequestDiagnostic }).browserDiagnostic;
  const report = outcome ? merged(known, outcome) : known;
  if (!report) return named;
  return { ...named, browserDiagnostic: addressesSayNothing ? withoutAddresses(report) : report } as JobError;
}

/**
 * For a job's failure: the latest request of that job's time to the server
 * the failure is about, of the kind the failure describes (answered, or
 * failed by the browser).
 */
export function explainNetwork(outcomes: RequestOutcomes, error: JobError,
  context: { readonly since: number; readonly address: string; readonly addressesSayNothing?: boolean }): JobError {
  if (!ANSWERED.has(error.code) && !UNANSWERED.has(error.code)) return error;
  const host = hostOfError(error, context.address);
  if (!host) return error;
  const status = "httpStatus" in error && typeof error.httpStatus === "number" ? error.httpStatus : null;
  const outcome = outcomes.latestForHost(host, context.since, ANSWERED.has(error.code) ? "answer" : "error", status);
  return withOutcome(error, outcome, context.address, context.addressesSayNothing === true);
}
