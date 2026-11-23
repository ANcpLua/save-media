import { describe, expect, it } from "vitest";
import { toastDetail, userMessage, type UserMessage } from "../../src/errors/messages";
import type { JobError } from "../../src/errors/taxonomy";
import { ALL_VARIANTS, VARIANTS, diagnostic } from "./samples";

/** Codes, protocol words, addresses and wrong names never appear in what the user reads first. */
const JARGON = /HTTP|net::|NS_ERROR|manifest|segment|\bCDM\b|\bEME\b|DASH|HLS|MIME|Blob|remux|CENC|ClearKey|https?:\/\/|SaveMedia|Chrome|Firefox|\b[a-z]+(?:_[a-z]+)+\b/;
/** A number shaped like an HTTP status. Sizes such as "420.0 MB" are amounts, not statuses. */
const STATUS_NUMBER = /\b[1-5]\d\d\b/;
const withoutAmounts = (text: string): string => text.replace(/\d+(?:\.\d+)? (?:B|KB|MB|GB)\b/g, "");
const PROTECTED_CODES = new Set(["encrypted_media_detected", "cdm_required", "clearkey_deferred", "license_bound_stream"]);
const RETRY_CODES = new Set(["rate_limited", "server_busy", "network_unreachable", "tls_certificate_rejected", "segment_budget_exhausted",
  "verification_checksum", "verification_segment_count", "verification_duration", "verification_container", "engine_job_failed", "engine_stopped"]);

const mainText = (message: UserMessage): string => [message.title, message.body, message.hint ?? ""].join("\n");

describe("the wording of every error", () => {
  it.each(ALL_VARIANTS.map(error => [describeVariant(error), error] as const))("%s", (_name, error) => {
    const message = userMessage(error);
    expect(message.title.length).toBeGreaterThan(0);
    expect(message.title.length).toBeLessThanOrEqual(60);
    expect(message.title).not.toMatch(/[.!]$/);
    expect(message.body.length).toBeGreaterThan(0);
    const text = mainText(message);
    expect(text).not.toMatch(JARGON);
    expect(withoutAmounts(text)).not.toMatch(STATUS_NUMBER);
    expect(text).not.toMatch(/[–—]|\p{Extended_Pictographic}|!|\bplease\b/iu);
    expect(text).not.toMatch(/secret|\/private\//);
    expect(text).not.toMatch(/not implemented|not supported (?:yet|in this version)/i);
    expect(text).not.toMatch(/\b(?:VPN|another DNS|different DNS|turn off|switch off|disable)\b/i);
    expect(text).not.toMatch(/site's (?:own )?(?:download )?button|use the site/i);
    expect(message.details.at(-1)).toEqual({ label: "Error code", value: error.code });
    for (const row of message.details) {
      expect(row.label).not.toBe("");
      expect(row.value).not.toMatch(/secret|\/private\/|\?token/);
    }
    expect(new Set(message.details.map(row => row.label)).size).toBe(message.details.length);
    if (message.hint !== null) expect(message.hint).toMatch(/^[A-Z][a-z]+\b/);
  });

  it.each(Object.keys(VARIANTS))("%s offers Retry save only where trying again can help", code => {
    for (const error of VARIANTS[code as keyof typeof VARIANTS]) {
      const { action, hint } = userMessage(error);
      // A file whose rest the server will not send can only be started again: the hint names the button, so the button is there.
      const startsAgain = error.code === "transfer_failed" && (error.reason === "resume-refused" || error.reason === "resume-unverifiable");
      if (RETRY_CODES.has(code) || startsAgain) expect(action).toEqual({ label: "Retry save", kind: "retry-job" });
      else expect(action).toBeNull();
      if (hint?.includes("Retry save")) expect(action).not.toBeNull();
    }
  });

  it.each(ALL_VARIANTS.map(error => [describeVariant(error), error] as const))("%s: the toast never points at a control only the popup has", (_name, error) => {
    const message = userMessage(error);
    const toast = toastDetail(message);
    if (/Check page again|Retry save|lower quality/.test(message.hint ?? "")) expect(message.toastHint).toBeDefined();
    expect(toast).not.toMatch(/^(?!.*Open savemedia).*(?:Check page again|lower quality)/);
    expect(toast).not.toMatch(/Retry save|this popup/);
    if (message.toastHint !== undefined) expect(message.toastHint).toMatch(/^[A-Z][a-z]+\b/);
  });

  it.each([...PROTECTED_CODES])("%s is a protected video with no hint, no retry and no promise of a later feature", code => {
    for (const error of VARIANTS[code as keyof typeof VARIANTS]) {
      const message = userMessage(error);
      expect(message.title).toBe("Protected video");
      expect(message.tone).toBe("protected");
      expect(message.hint).toBeNull();
      expect(message.action).toBeNull();
      expect(message.body).toMatch(/savemedia does not/);
      expect(message.body).not.toMatch(/\byet\b|not implemented|this version/i);
    }
  });
});

function describeVariant(error: JobError): string {
  const { code, severity: _severity, ...rest } = error as JobError & Record<string, unknown>;
  const mark = ["reason", "response", "when", "during", "explanation", "limit", "layout", "cause", "keySystem", "retryAfterSeconds", "httpStatus", "ip"]
    .flatMap(key => key in rest && typeof rest[key] !== "object" ? [`${key}=${String(rest[key])}`] : []).join(" ");
  return mark ? `${code} (${mark})` : code;
}

const rowsOf = (message: UserMessage): Record<string, string> => Object.fromEntries(message.details.map(row => [row.label, row.value]));

describe("protection is described from what the error states", () => {
  it("names the DRM system under Technical details only", () => {
    const message = userMessage(VARIANTS.cdm_required[0]!);
    expect(message.body).toBe("This video is protected with DRM. savemedia does not save DRM-protected media.");
    expect(rowsOf(message)).toMatchObject({ "Protection": "Widevine", "Detected in": "DASH manifest", "Error code": "cdm_required" });
  });

  it("tells an HLS encryption method from a DRM system", () => {
    const message = userMessage(VARIANTS.cdm_required[1]!);
    expect(message.body).toBe("This video uses an encryption method that savemedia does not decrypt.");
    expect(rowsOf(message)).toMatchObject({ "Method": "SAMPLE-AES" });
  });

  it("maps the FairPlay key delivery format to its name", () => {
    expect(rowsOf(userMessage(VARIANTS.cdm_required[2]!))).toMatchObject({ "Protection": "FairPlay" });
  });

  it("says scrambled for a transport stream", () => {
    const message = userMessage(VARIANTS.encrypted_media_detected[1]!);
    expect(message.body).toBe("This video stream is scrambled. savemedia does not descramble protected streams.");
    expect(rowsOf(message)).toMatchObject({ "Detected in": "Transport stream" });
  });

  it("says protected playback for key use seen in the player, Clear Key included", () => {
    for (const error of [VARIANTS.clearkey_deferred[0]!, VARIANTS.cdm_required[3]!, VARIANTS.encrypted_media_detected[0]!]) {
      expect(userMessage(error).body).toBe("This video plays through your browser's protected playback. savemedia does not save media protected this way.");
    }
    expect(rowsOf(userMessage(VARIANTS.clearkey_deferred[0]!))).toMatchObject({ "Protection": "Clear Key", "Detected in": "Player" });
  });

  it("names a licence server for a refused key", () => {
    const message = userMessage(VARIANTS.license_bound_stream[0]!);
    expect(message.body).toBe("The key for this video comes from a licence server. savemedia does not use licence keys.");
    expect(rowsOf(message)).toMatchObject({ "Key server": "media.example", "HTTP status": "403" });
  });
});

describe("server answers", () => {
  it("turns Retry-After into a hint in seconds or minutes", () => {
    const [short, long, none] = VARIANTS.rate_limited.map(userMessage);
    expect(short!.hint).toBe("Try again in about 10 seconds.");
    expect(long!.hint).toBe("Try again in about 5 minutes.");
    expect(none!.hint).toBe("Wait a few minutes, then try again.");
    expect(rowsOf(short!)).toMatchObject({ "HTTP status": "429", "Retry-After": "10 s", "Server": "media.example", "Request": "File" });
  });

  it("says a busy server did not answer in time for a gateway timeout", () => {
    const message = userMessage(VARIANTS.server_busy[1]!);
    expect(message.title).toBe("The server is busy");
    expect(message.body).toBe("The video server did not answer in time.");
    expect(rowsOf(message)).toMatchObject({ "HTTP status": "522", "Request": "Playlist" });
  });

  it("explains each refusal of access by what the server said", () => {
    const [expired, session, purchase, legal] = VARIANTS.access_denied.map(userMessage);
    expect(expired!.body).toBe("The server refused this file. Its link may have expired.");
    expect(session!.body).toBe("The server did not accept your session for this file.");
    expect(purchase!.body).toBe("The server says this file needs an account or a purchase.");
    expect(purchase!.hint).toBe("If you have access, play the video on the page while signed in, then try again.");
    expect(legal!.title).toBe("Blocked for legal reasons");
    expect(rowsOf(legal!)).toMatchObject({ "HTTP status": "451" });
  });

  it("says a file that is gone is gone", () => {
    expect(userMessage(VARIANTS.http_error[1]!).body).toBe("The server no longer has this file.");
  });

  it("says that a playlist which answered when the video was found no longer answers as the save starts, without a guess why", () => {
    for (const error of [VARIANTS.http_error[2]!, VARIANTS.access_denied[4]!]) {
      const message = userMessage(error);
      expect(message.title).toBe("The video's playlist no longer answers");
      expect(message.body).toBe("This video's playlist answered when savemedia found it, but the server refused it when the save started.");
      expect(message.hint).toBe("Play the video on the page again, then save.");
      // The user plays the video first: the button under the failure is the plain Save.
      expect(message.action).toBeNull();
      expect(`${message.title} ${message.body} ${message.hint}`).not.toMatch(/expired|session|sign|account|\d{3}/i);
      expect(rowsOf(message)).toEqual({ "HTTP status": String(error.httpStatus), "Server": "media.example",
        "Request": "Playlist, read again as the save started", "Error code": error.code });
      expect(toastDetail(message)).toBe("The video's playlist no longer answers. Play the video on the page again, then save.");
    }
    // The same status for a playlist at any other moment keeps its own words.
    expect(userMessage({ ...VARIANTS.access_denied[4]!, atSaveStart: undefined } as never).title).toBe("The server refused access");
  });

  // A session that ended, or a network that answers in the server's place: the address sends a page where the playlist was.
  it("says the same when the playlist's address sends a web page or other data as the save starts, and never calls the playlist incomplete or live", () => {
    for (const error of [VARIANTS.unexpected_media_response[3]!, VARIANTS.unexpected_media_response[4]!]) {
      const message = userMessage(error);
      const page = error.response === "page";
      expect(message.title).toBe("The video's playlist no longer answers");
      expect(message.body).toBe(page
        ? "This video's playlist answered when savemedia found it, but the server sent a web page in its place when the save started."
        : "This video's playlist answered when savemedia found it, but the server sent something else in its place when the save started.");
      expect(message.hint).toBe("Play the video on the page again, then save.");
      expect(message.action).toBeNull();
      expect(`${message.title} ${message.body} ${message.hint}`).not.toMatch(/incomplete|quality|live|Check page again|expired|session|sign/i);
      expect(rowsOf(message)).toEqual({ "Server": "media.example", "Answer": page ? "Web page" : "Data",
        "Request": "Playlist, read again as the save started", "Error code": "unexpected_media_response" });
      expect(toastDetail(message)).toBe("The video's playlist no longer answers. Play the video on the page again, then save.");
    }
    // A network that answered in the server's place is explained as for any other page answer.
    const blocked = userMessage({ ...VARIANTS.unexpected_media_response[3]!, host: "media.public-site.net",
      browserDiagnostic: { code: null, host: "media.public-site.net", ip: "192.168.1.1", finalHost: null, redirect: null } });
    expect(blocked.title).toBe("Blocked or redirected by your network");
    // The same answer at any other moment keeps its own words.
    expect(userMessage(VARIANTS.unexpected_media_response[0]!).title).toBe("The server sent a web page instead of the video");
  });

  it("tells every transfer failure apart and keeps exact bytes under Technical details", () => {
    const byReason = Object.fromEntries(VARIANTS.transfer_failed.map(error => [error.reason, userMessage(error)]));
    expect(byReason["ended-early"]!.body).toBe("The server stopped after 420.0 MB of 512.0 MB and did not let savemedia continue.");
    expect(byReason["resume-refused"]!.hint).toBe("Retry save starts the file again from the beginning.");
    expect(byReason["resume-unverifiable"]!.title).toBe("The download can't continue safely");
    expect(byReason["file-changed"]!.title).toBe("The file changed on the server");
    expect(byReason["content-mismatch"]!.title).toBe("The file changed on the server");
    expect(byReason["link-changed"]!.title).toBe("The link now leads to a different file");
    for (const reason of ["range-mismatch", "range-length", "range-slices", "range-encoded", "body-long"]) {
      expect(byReason[reason]!.title).toBe("The server's answer can't be used");
    }
    expect(rowsOf(byReason["ended-early"]!)).toMatchObject({ "Server": "cdn.example", "HTTP status": "206",
      "Received": `${420 * 1024 ** 2} of ${512 * 1024 ** 2} bytes`, "Reason": "ended-early" });
  });

  it("tells a page, data and an unsupported file apart", () => {
    const [page, data, unsupported] = VARIANTS.unexpected_media_response.map(userMessage);
    expect(page!.title).toBe("The server sent a web page instead of the video");
    expect(data!.title).toBe("The server sent data instead of the video");
    expect(unsupported!.title).toBe("This isn't a video savemedia can save");
    expect(unsupported!.hint).toBeNull();
    expect([page!.tone, data!.tone, unsupported!.tone]).toEqual(["unusable", "unusable", "unusable"]);
  });

  it("says a codec the MP4 file cannot hold as that, and never sends the user to look at the page again", () => {
    const [sound, picture] = VARIANTS.codec_unsupported.map(userMessage);
    expect(sound).toMatchObject({ title: "Can't save in this format", hint: null, action: null,
      body: "This video's sound is in a format savemedia can't put into an MP4 file in the browser." });
    expect(picture!.body).toBe("This video's picture is in a format savemedia can't put into an MP4 file in the browser.");
    // The codec is a technical detail.
    expect(rowsOf(sound!)).toMatchObject({ "Audio format": "alac", "Server": "media.example" });
    expect(rowsOf(picture!)).toMatchObject({ "Video format": "prores" });
    expect(toastDetail(sound!)).toBe("Can't save in this format");
    for (const message of [sound!, picture!]) expect(`${message.title} ${message.body} ${message.hint ?? ""}`).not.toMatch(/playlist|Check page|alac|prores/i);
  });

  it("keeps the key's size and the parser's words out of the main text", () => {
    const binary = userMessage(VARIANTS.hls_key_unusable[2]!);
    expect(binary.body).toBe("The key address sent something other than a 16-byte key.");
    expect(rowsOf(binary)).toMatchObject({ "Size": "240 bytes", "Key server": "media.example" });
    const malformed = userMessage(VARIANTS.manifest_malformed[0]!);
    expect(malformed.hint).toBe("Press Check page again, then save.");
    expect(rowsOf(malformed)["Detail"]).toBe("line 3: bad tag at media.example");
  });
});

describe("the user's network", () => {
  it("names the server it could not reach, and what was received before a drop", () => {
    const [request, transfer, stalled] = VARIANTS.network_unreachable.map(userMessage);
    expect(request!.body).toBe("Your browser got no answer from media.example.");
    expect(transfer!.body).toBe("The connection to the video server dropped after 300.0 MB of 512.0 MB.");
    expect(stalled!.body).toBe("The download stalled after 140.0 KB.");
  });

  it.each(["net::ERR_CONNECTION_RESET", "net::ERR_NETWORK_CHANGED", "net::ERR_HTTP2_PROTOCOL_ERROR"])(
    "a connection that dropped during a transfer with %s keeps its own text, and the browser's code is a row", code => {
      const dropped: JobError = { code: "network_unreachable", severity: "terminal", phase: "direct", url: "https://cdn.example.net/v.mp4", during: "transfer",
        receivedBytes: 540 * 1024 ** 2, totalBytes: 1200 * 1024 ** 2, browserDiagnostic: diagnostic({ host: "cdn.example.net", code, ip: "93.184.216.34" }) };
      const message = userMessage(dropped);
      expect(message.title).toBe("The connection was lost");
      expect(message.body).toBe("The connection to the video server dropped after 540.0 MB of 1.17 GB.");
      expect(message.hint).toBe("Check your connection, then try again.");
      expect(rowsOf(message)).toMatchObject({ "Server": "cdn.example.net", "Address": "93.184.216.34 (internet)", "Browser error": code, "During": "Transfer" });
      const stalled = userMessage({ ...dropped, during: "timeout" });
      expect(stalled.title).toBe("The video server stopped sending data");
      expect(stalled.body).toBe("The download stalled after 540.0 MB of 1.17 GB.");
    });

  it("a request that never connected keeps its own text too: a refused connection names no block", () => {
    const message = userMessage(VARIANTS.network_unreachable[3]!);
    expect(message.title).toBe("Couldn't reach the video server");
    expect(message.body).toBe("Your browser got no answer from media.example.");
    expect(rowsOf(message)).toMatchObject({ "Browser error": "net::ERR_CONNECTION_RESET" });
  });

  it("losing the network during a transfer is said as being offline", () => {
    const message = userMessage({ ...VARIANTS.network_unreachable[1]!, browserDiagnostic: diagnostic({ code: "net::ERR_INTERNET_DISCONNECTED" }) });
    expect(message.title).toBe("You're offline");
  });

  it("explains a certificate from an unknown authority as a possible network filter, never as something to wait out", () => {
    const message = userMessage(VARIANTS.tls_certificate_rejected[0]!);
    expect(message.title).toBe("Secure connection not trusted");
    expect(message.body).toContain("cdn.example:8443");
    expect(message.hint).toBe("Check your network filter or security software, or the secure DNS setting in your browser's settings.");
    expect(message.body).toMatch(/sends a server to its own block page/);
    expect(message.hint).not.toMatch(/later|again when/i);
    expect(message.details).toEqual([
      { label: "Server", value: "cdn.example:8443" },
      { label: "Browser error", value: "net::ERR_CERT_AUTHORITY_INVALID" },
      { label: "Request", value: "File" },
      { label: "Error code", value: "tls_certificate_rejected" },
    ]);
  });

  it("explains a web page answered from a local address for a public name as a block by the network", () => {
    const message = userMessage({ code: "unexpected_media_response", severity: "terminal", response: "page", host: "media.public-site.net",
      browserDiagnostic: diagnostic({ host: "media.public-site.net", ip: "10.0.0.1" }) });
    expect(message.title).toBe("Blocked or redirected by your network");
    expect(message.body).toBe("Your network gave media.public-site.net a local address instead of its address on the internet. "
      + "Network filters, parental controls and some providers do this to block a server. On a company network this can be normal.");
    expect(message.hint).toBe("Check your network filter, or the secure DNS setting in your browser's settings.");
    expect(message.body).not.toContain("10.0.0.1");
    expect(message.tone).toBe("unavailable");
    expect(rowsOf(message)).toMatchObject({ "Server": "media.public-site.net", "Address": "10.0.0.1 (local network)", "Answer": "Web page",
      "Error code": "unexpected_media_response" });
  });

  it("gives a public name that led into the local network the same explanation, and says that savemedia set the answer aside", () => {
    const message = userMessage(VARIANTS.private_network_target[1]!);
    expect(message.title).toBe("Blocked or redirected by your network");
    expect(message.body).toMatch(/On a company network this can be normal\. Your browser has not loaded anything from that server for this page, so savemedia does not use the answer it got from there\.$/);
    // The next answer would be set aside as well.
    expect(message.action).toBeNull();
    expect(rowsOf(message)).toMatchObject({ "Address": "192.168.1.1 (local network)" });
  });

  it("says plainly why a local server a page on the internet only names is not requested, and what makes it saveable", () => {
    const named = userMessage(VARIANTS.private_network_target[0]!);
    expect(named.title).toBe("This media is on your local network");
    expect(named.body).toBe("This page is on the internet, and the media address it names points into your own network. "
      + "Your browser has not loaded anything from that server for this page, so savemedia does not request it either.");
    // What the browser itself loads from there is saved: the hint says how to get there, without naming a control of the page.
    expect(named.hint).toBe("Start playback on the page, then try again. savemedia saves what your browser itself loads.");
    expect(named.action).toBeNull();
    expect(rowsOf(named)).toEqual({ "Server": "router.local", "Error code": "private_network_target" });
    expect(toastDetail(named)).toBe("This media is on your local network. Start playback on the page, then try again. savemedia saves what your browser itself loads.");
  });

  it("never says the network gave a local address to a name that has no address on the internet", () => {
    for (const host of ["nas", "nas:8080", "printer.home.arpa", "router.internal", "router.local"]) {
      const named = userMessage({ code: "private_network_target", severity: "terminal", host });
      expect(named.title, host).toBe("This media is on your local network");
      expect(named.body, host).toMatch(/so savemedia does not request it either\.$/);
      // Even where an answer from there was set aside: the name is local, so no filter and no secure DNS setting is at work.
      const answered = userMessage({ code: "private_network_target", severity: "terminal", host, ip: "192.168.1.1" });
      expect(answered.title, host).toBe("This media is on your local network");
      expect(answered.body, host).toMatch(/so savemedia does not use the answer it got from there\.$/);
      expect(answered.hint, host).toBe("Start playback on the page, then try again. savemedia saves what your browser itself loads.");
    }
  });

  it("leaves a plain refusal by a server at a local address as the server's own answer", () => {
    const message = userMessage({ ...VARIANTS.access_denied[0]!, browserDiagnostic: diagnostic({ host: "media.public-site.net", ip: "10.0.0.1" }) });
    expect(message.title).toBe("The server refused access");
    expect(rowsOf(message)).toMatchObject({ "Address": "10.0.0.1 (local network)" });
  });
});

describe("cancel and toast text", () => {
  it("a cancel is neutral and promises nothing about discarded bytes", () => {
    const message = userMessage({ code: "user_cancelled", severity: "terminal" });
    expect(message).toMatchObject({ title: "Cancelled", body: "Nothing was saved.", hint: null, tone: "neutral", action: null });
  });

  it("a toast says what happened and, when there is one, what to do", () => {
    expect(toastDetail(userMessage(VARIANTS.server_busy[0]!))).toBe("The server is busy. Try again in a few minutes.");
    expect(toastDetail(userMessage(VARIANTS.cdm_required[0]!))).toBe("Protected video");
  });

  it("a toast names savemedia where the popup's hint points at one of its controls", () => {
    expect(toastDetail(userMessage(VARIANTS.manifest_malformed[0]!))).toBe("The video's playlist can't be used. Open savemedia and press Check page again, then save.");
    const refused = VARIANTS.transfer_failed.find(error => error.reason === "resume-refused")!;
    expect(toastDetail(userMessage(refused))).toBe("The download can't continue. Save again to start the file from the beginning.");
  });
});
