import { describe, expect, it } from "vitest";
import { userMessage, type JobError } from "@savemedia/core";
import { explainNetwork, withOutcome } from "../../../src/background/explain-network";
import type { RequestOutcome, RequestOutcomes } from "../../../src/background/request-outcomes";

const outcome = (fields: Partial<RequestOutcome> = {}): RequestOutcome =>
  ({ host: "media.public-site.net", code: null, ip: null, finalHost: null, redirect: null, status: 200, at: 10, ...fields });

/** A log that answers every lookup with `found` and records what was asked. */
function log(found: RequestOutcome | null) {
  const asked: unknown[][] = [];
  const outcomes: RequestOutcomes = {
    watch: () => { throw new Error("not used"); },
    latestForHost: (...args) => { asked.push(args); return found; },
  };
  return { outcomes, asked };
}

const ADDRESS = "https://media.public-site.net/v/master.m3u8?token=secret";
const page: JobError = { code: "unexpected_media_response", severity: "terminal", response: "page" };

describe("a job's failure, explained by what the browser reported", () => {
  it("names the server from the job's address and attaches the latest answer from that server", () => {
    const { outcomes, asked } = log(outcome({ ip: "192.168.1.1" }));
    const explained = explainNetwork(outcomes, page, { since: 5, address: ADDRESS });
    expect(asked).toEqual([["media.public-site.net", 5, "answer", null]]);
    expect(explained).toEqual({ ...page, host: "media.public-site.net",
      browserDiagnostic: { host: "media.public-site.net", code: null, ip: "192.168.1.1", finalHost: null, redirect: null } });
    expect(userMessage(explained).title).toBe("Blocked or redirected by your network");
    expect(JSON.stringify(explained)).not.toContain("secret");
  });

  // Behind a proxy inside the user's network, the address the browser reports for every server is the proxy's.
  it("never explains a failure as a public name at a local address when the addresses of that tab say nothing", () => {
    const answered = outcome({ ip: "127.0.0.1", redirect: { toHost: "cdn.public-site.net", status: 302, fromIp: "127.0.0.1" } });
    const explained = explainNetwork(log(answered).outcomes, page, { since: 5, address: ADDRESS, addressesSayNothing: true });
    expect(explained).toEqual({ ...page, host: "media.public-site.net", browserDiagnostic: { host: "media.public-site.net", code: null, ip: null,
      finalHost: null, redirect: { toHost: "cdn.public-site.net", status: 302, fromIp: null } } });
    // The redirect to a page on another server still explains it. The proxy's address does not.
    expect(JSON.stringify(explained)).not.toContain("127.0.0.1");
    const plain = explainNetwork(log(outcome({ ip: "10.0.0.8" })).outcomes, page, { since: 5, address: ADDRESS, addressesSayNothing: true });
    expect(userMessage(plain).title).not.toBe("Blocked or redirected by your network");
    expect(userMessage(plain).body).not.toContain("local address");
    // The browser's own error code still names what blocked the request.
    const unreachable: JobError = { code: "network_unreachable", severity: "terminal", phase: "direct", url: "https://cdn.public-site.net/clip.mp4", during: "request" };
    const refused = explainNetwork(log(outcome({ host: "cdn.public-site.net", code: "net::ERR_TUNNEL_CONNECTION_FAILED", ip: "10.0.0.8", status: null })).outcomes,
      unreachable, { since: 0, address: ADDRESS, addressesSayNothing: true });
    expect((refused as { browserDiagnostic?: { code: string | null; ip: string | null } }).browserDiagnostic).toMatchObject({ code: "net::ERR_TUNNEL_CONNECTION_FAILED", ip: null });
    // A report the failure already carried loses its addresses the same way.
    const carried = withOutcome({ ...page, browserDiagnostic: { host: "media.public-site.net", code: null, ip: "10.0.0.8", finalHost: null, redirect: null } },
      null, ADDRESS, true);
    expect((carried as { browserDiagnostic?: { ip: string | null } }).browserDiagnostic?.ip).toBeNull();
  });

  it("asks for an answer with the failure's status, and for a browser error when no answer arrived", () => {
    const denied: JobError = { code: "access_denied", severity: "terminal", phase: "segment", url: "https://cdn.public-site.net/s1.ts", httpStatus: 403,
      explanation: "forbidden-or-expired-url" };
    const first = log(null);
    expect(explainNetwork(first.outcomes, denied, { since: 0, address: ADDRESS })).toBe(denied);
    expect(first.asked).toEqual([["cdn.public-site.net", 0, "answer", 403]]);

    const unreachable: JobError = { code: "network_unreachable", severity: "terminal", phase: "direct", url: "https://cdn.public-site.net/clip.mp4", during: "request" };
    const second = log(outcome({ host: "cdn.public-site.net", code: "net::ERR_CERT_AUTHORITY_INVALID", status: null }));
    const explained = explainNetwork(second.outcomes, unreachable, { since: 0, address: ADDRESS });
    expect(second.asked).toEqual([["cdn.public-site.net", 0, "error", null]]);
    // The engine cannot see why its request failed. With the browser's report the user is told.
    expect(userMessage(explained).title).toBe("Secure connection not trusted");
    expect(userMessage(unreachable).title).toBe("Couldn't reach the video server");
  });

  it("uses the key's server for a key failure and the failure's own server for a transfer failure", () => {
    const key: JobError = { code: "hls_key_unusable", severity: "terminal", keyUri: "https://keys.public-site.net/k1", response: "page", byteLength: 300 };
    const first = log(null);
    explainNetwork(first.outcomes, key, { since: 0, address: ADDRESS });
    expect(first.asked[0]![0]).toBe("keys.public-site.net");
    const transfer: JobError = { code: "transfer_failed", severity: "terminal", reason: "ended-early", host: "files.public-site.net", receivedBytes: 1,
      totalBytes: 2, httpStatus: 200 };
    const second = log(null);
    explainNetwork(second.outcomes, transfer, { since: 0, address: ADDRESS });
    expect(second.asked[0]).toEqual(["files.public-site.net", 0, "answer", 200]);
  });

  it("keeps what a failure already knows and adds only what it lacks", () => {
    const known: JobError = { code: "tls_certificate_rejected", severity: "terminal", phase: "direct",
      browserDiagnostic: { host: "cdn.public-site.net", code: "net::ERR_CERT_DATE_INVALID", ip: null, finalHost: null, redirect: null } };
    const { outcomes } = log(outcome({ host: "cdn.public-site.net", code: "net::ERR_CERT_AUTHORITY_INVALID", ip: "203.0.113.9" }));
    expect(explainNetwork(outcomes, known, { since: 0, address: ADDRESS })).toMatchObject({
      browserDiagnostic: { host: "cdn.public-site.net", code: "net::ERR_CERT_DATE_INVALID", ip: "203.0.113.9" } });
  });

  it("leaves every failure the network does not explain exactly as it is", () => {
    const { outcomes, asked } = log(outcome({ ip: "192.168.1.1" }));
    const others: JobError[] = [
      { code: "cdm_required", severity: "terminal", keySystem: "com.widevine.alpha" },
      { code: "verification_container", severity: "terminal", probeError: "no moov" },
      { code: "user_cancelled", severity: "terminal" },
      { code: "engine_stopped", severity: "terminal", when: "running" },
      { code: "manifest_malformed", severity: "terminal", url: ADDRESS, parserError: "x" },
    ];
    for (const error of others) expect(explainNetwork(outcomes, error, { since: 0, address: ADDRESS })).toBe(error);
    expect(asked).toEqual([]);
  });
});

describe("a check's failure, explained by the request behind its answer", () => {
  it("names the server also when the browser reported nothing", () => {
    expect(withOutcome(page, null, ADDRESS)).toEqual({ ...page, host: "media.public-site.net" });
  });

  it("attaches the report of that request", () => {
    const explained = withOutcome(page, outcome({ ip: "127.0.0.1", finalHost: "filter.public-site.net",
      redirect: { toHost: "filter.public-site.net", status: 302, fromIp: "127.0.0.1" } }), ADDRESS);
    const rows = Object.fromEntries(userMessage(explained).details.map(row => [row.label, row.value]));
    expect(rows).toMatchObject({ "Server": "media.public-site.net", "Address": "127.0.0.1 (this computer)",
      "Redirected to": "filter.public-site.net (HTTP 302)", "Error code": "unexpected_media_response" });
  });
});
