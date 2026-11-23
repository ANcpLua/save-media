import { describe, expect, it } from "vitest";
import { errorFacts, EXPORTED_ERROR_CODES } from "../../src/errors/facts";
import type { JobError, JobErrorCode } from "../../src/errors/taxonomy";
import { ALL_VARIANTS, VARIANTS, diagnostic } from "./samples";

/** One sample per code. The record type fails to compile when a code has none. */
const SAMPLES = Object.fromEntries(Object.entries(VARIANTS).map(([code, variants]) => [code, variants[0]])) as
  { readonly [C in JobErrorCode]: Extract<JobError, { code: C }> };

describe("errorFacts", () => {
  it("has an export decision for every error code", () => {
    expect([...EXPORTED_ERROR_CODES].sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  it.each(ALL_VARIANTS.map(error => [error.code, error] as const))("exports no address, path, file name or prose for %s", (_code, error) => {
    const facts = errorFacts(error);
    expect(facts["code"]).toBe(error.code);
    for (const value of Object.values(facts)) {
      if (typeof value !== "string") continue;
      expect(value).not.toMatch(/[\/\s]/);
      expect(value).not.toContain("secret");
    }
    expect(JSON.stringify(facts)).not.toContain("/private/");
  });

  it("keeps the counts, statuses and closed words that explain a failure", () => {
    expect(errorFacts(SAMPLES.access_denied)).toEqual({ code: "access_denied", phase: "direct", httpStatus: 403, explanation: "forbidden-or-expired-url" });
    expect(errorFacts(VARIANTS.http_error[2]!)).toEqual({ code: "http_error", phase: "manifest", httpStatus: 404, atSaveStart: true });
    expect(errorFacts(SAMPLES.tls_certificate_rejected)).toEqual({ code: "tls_certificate_rejected", phase: "direct",
      browserCode: "net::ERR_CERT_AUTHORITY_INVALID", browserHost: "cdn.example:8443" });
    expect(errorFacts(SAMPLES.encrypted_media_detected)).toEqual({ code: "encrypted_media_detected",
      detectedVia: "eme-hook+mp4-protection", keySystem: "com.widevine.alpha" });
    expect(errorFacts(SAMPLES.cdm_required)).toEqual({ code: "cdm_required", keySystem: "com.widevine.alpha", detectedVia: "dash-content-protection" });
    expect(errorFacts(SAMPLES.range_body_empty)).toMatchObject({ host: "cdn.example", rangeStart: 10, rangeEnd: 20, declaredBytes: null, reason: "stream-ended" });
    expect(errorFacts(SAMPLES.browser_download_failed)).toEqual({ code: "browser_download_failed" });
    expect(errorFacts(SAMPLES.engine_stopped)).toEqual({ code: "engine_stopped", when: "start" });
  });

  it("exports the kind of a server address and whether a redirect led elsewhere, never the address", () => {
    const facts = errorFacts({ code: "unexpected_media_response", severity: "terminal", response: "page", host: "media.public-site.net",
      browserDiagnostic: diagnostic({ host: "media.public-site.net", ip: "192.168.1.1",
        redirect: { toHost: "filter.public-site.net", status: 302, fromIp: "192.168.1.1" } }) });
    expect(facts).toEqual({ code: "unexpected_media_response", response: "page", host: "media.public-site.net",
      browserHost: "media.public-site.net", browserAddressScope: "private", browserRedirected: true });
    expect(JSON.stringify(facts)).not.toContain("192.168");
  });

  it("replaces a code that is not code-shaped", () => {
    expect(errorFacts({ ...SAMPLES.user_cancelled, code: "Not A Code" as never })).toEqual({ code: "unknown_error" });
  });
});
