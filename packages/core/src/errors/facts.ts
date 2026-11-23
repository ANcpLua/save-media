import { addressScope } from "../net/address";
import type { BrowserRequestDiagnostic, JobError, JobErrorCode } from "./taxonomy";

export type FactValue = string | number | boolean | null;
export type ErrorFacts = Readonly<Record<string, FactValue>>;

type Fields<C extends JobErrorCode> = Exclude<keyof Extract<JobError, { code: C }>, "code" | "severity">;

/**
 * Per code, the fields that may leave the device in a diagnostic export:
 * counts, statuses, closed enums, key systems and hosts. Never an address, a
 * path, a file name or free text. Of a server's network address only its
 * kind (public, local network, ...) is exported. The mapped type stops compiling when a
 * code is added or a field renamed without a decision here.
 */
const EXPORTED: { readonly [C in JobErrorCode]: readonly Fields<C>[] } = {
  encrypted_media_detected: ["detectedVia", "keySystem"],
  cdm_required: ["keySystem", "detectedVia"],
  license_bound_stream: ["httpStatus"],
  clearkey_deferred: ["detectedVia"],
  hls_key_unusable: ["response", "byteLength", "browserDiagnostic"],
  manifest_malformed: [],
  manifest_too_large: ["limit"],
  private_network_target: [],
  unsupported_output: ["from", "to", "reason"],
  codec_unsupported: ["track", "codec"],
  dash_unsupported: [],
  hls_encryption_unsupported: ["method"],
  hls_live_unsupported: [],
  hls_layout_unsupported: ["layout"],
  range_body_empty: ["host", "rangeStart", "rangeEnd", "totalBytes", "declaredBytes", "reconnects", "reason"],
  transfer_failed: ["reason", "host", "receivedBytes", "totalBytes", "httpStatus", "browserDiagnostic"],
  segment_budget_exhausted: ["totalSegments"],
  rate_limited: ["phase", "httpStatus", "retryAfterSeconds"],
  server_busy: ["phase", "httpStatus", "browserDiagnostic"],
  http_error: ["phase", "httpStatus", "atSaveStart", "browserDiagnostic"],
  access_denied: ["phase", "httpStatus", "explanation", "atSaveStart", "browserDiagnostic"],
  network_unreachable: ["phase", "during", "receivedBytes", "totalBytes", "browserDiagnostic"],
  tls_certificate_rejected: ["phase", "browserDiagnostic"],
  insecure_media_redirect: [],
  verification_segment_count: ["expected", "got"],
  verification_duration: ["expectedMs", "gotMs", "toleranceMs"],
  verification_checksum: ["algo"],
  verification_container: [],
  engine_job_failed: ["at", "cause"],
  engine_stopped: ["when"],
  unexpected_media_response: ["response", "host", "atSaveStart", "browserDiagnostic"],
  browser_download_failed: [],
  user_cancelled: [],
};

const CODE = /^[a-z][a-z0-9_]{0,60}$/;
/** Enum words, key systems, hosts and browser codes. A slash or a space keeps addresses, paths and prose out. */
const TOKEN = /^[A-Za-z0-9_.:+-]{1,80}$/;

function isDiagnostic(value: unknown): value is BrowserRequestDiagnostic {
  return !!value && typeof value === "object" && "code" in value && "host" in value;
}

/** The exportable facts of an error: its code and the listed fields that pass the value rules. */
export function errorFacts(error: JobError): ErrorFacts {
  const facts: Record<string, FactValue> = { code: CODE.test(error.code) ? error.code : "unknown_error" };
  const fields = (EXPORTED as Readonly<Record<string, readonly string[]>>)[error.code] ?? [];
  const values = error as unknown as Readonly<Record<string, unknown>>;
  for (const field of fields) {
    const value = values[field];
    if (typeof value === "number" ? Number.isFinite(value) : typeof value === "boolean" || value === null) {
      facts[field] = value as FactValue;
    } else if (typeof value === "string") {
      if (TOKEN.test(value)) facts[field] = value;
    } else if (Array.isArray(value)) {
      const joined = value.every(item => typeof item === "string") ? value.join("+") : "";
      if (TOKEN.test(joined)) facts[field] = joined;
    } else if (isDiagnostic(value)) {
      if (typeof value.code === "string" && TOKEN.test(value.code)) facts["browserCode"] = value.code;
      if (typeof value.host === "string" && TOKEN.test(value.host)) facts["browserHost"] = value.host;
      // The kind of address, never the address: a local address can name a device on the user's network.
      const scope = typeof value.ip === "string" ? addressScope(value.ip) : null;
      if (scope) facts["browserAddressScope"] = scope;
      if (value.redirect || value.finalHost) facts["browserRedirected"] = true;
    }
  }
  return facts;
}

/** The codes with an export decision. For tests. */
export const EXPORTED_ERROR_CODES: readonly JobErrorCode[] = Object.keys(EXPORTED) as JobErrorCode[];
