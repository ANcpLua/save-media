// What a failed or refused save says to the user: one text per JobError.
//
// Wording rules (the same in every text catalogue):
// - Title: what happened, at most about 8 words, sentence case, no period. No codes, no HTTP numbers and
//   no protocol words (HLS, DASH, manifest, segment, MIME, CDM, EME, TLS, Blob, remux, range).
// - Body: one or two plain sentences on what happened. A server name appears only in network messages,
//   because the user needs it to check a filter.
// - Hint: what the user can do, starting with a verb, or null when nothing helps (protected media). A hint that
//   points at one of the popup's controls has a second wording for the toast, which says to open savemedia first.
// - Technical details: labelled rows. They carry codes, HTTP statuses, hosts, addresses, key systems and
//   byte counts. Never an address path or query. The last row is always "Error code". No row is glued
//   onto another.
// - Names: "savemedia" in lowercase, also at the start of a sentence. "savemedia helper" for the native
//   program, "Local downloader" for the feature. "your browser", never a browser's name. "Downloads folder".
// - Typography: plain apostrophes, no long dashes, no pictographs, no exclamation marks, no "please".
// - A cancel by the user is neutral, never a failure.
// - Encryption is never "not implemented" or "not supported yet": nothing is coming.
// - Never tell the user to use a site's button or control.
// - Never suggest a VPN, another DNS server, switching a filter off or any other way around a block.
// - British spelling: licence, cancelled, organisation.
import { formatBytes } from "../format/bytes";
import { isLocalHostName } from "../net/address";
import { diagnosticRows, networkBlock, networkBlockText } from "./network-block";
import type { DrmSignalSource } from "../types/stream";
import type { BrowserRequestDiagnostic, JobError, TransferFailureReason } from "./taxonomy";

/** protected: refused for encryption. unusable: what arrived is not the file. unavailable: it could not be fetched or made. neutral: nothing went wrong. */
export type MessageTone = "protected" | "unusable" | "unavailable" | "neutral";

export interface TechnicalDetail { readonly label: string; readonly value: string }

export type ActionKind = "retry-job";

export interface UserMessage {
  readonly title: string;
  readonly body: string;
  /** What the user can do, or null when nothing helps. */
  readonly hint: string | null;
  /**
   * The hint for the in-page toast, where it differs: the popup is closed there, so a hint that points at
   * one of the popup's controls says to open savemedia first. Absent when the hint reads the same everywhere.
   */
  readonly toastHint?: string;
  /** Rows for the Technical details disclosure. The last row is the error code. */
  readonly details: readonly TechnicalDetail[];
  readonly tone: MessageTone;
  readonly action: { readonly label: "Retry save"; readonly kind: ActionKind } | null;
}

interface Draft {
  readonly title: string;
  readonly body: string;
  readonly hint?: string | null;
  /** The hint as the toast gives it, when the hint points at a control of the popup. */
  readonly toastHint?: string;
  readonly tone?: MessageTone;
  readonly retry?: boolean;
  readonly rows?: readonly (TechnicalDetail | null)[];
  /** The browser's report about the request behind the failure, when the error carries one. */
  readonly diagnostic?: BrowserRequestDiagnostic | undefined;
  /** The answer's own bytes were a web page. */
  readonly answeredWithPage?: boolean;
}

const RETRY = { label: "Retry save", kind: "retry-job" } as const;
const RELOAD_AND_PLAY = "Reload the page, start playback, then try again.";
const NOT_LOADED_FROM_THERE = "Your browser has not loaded anything from that server for this page";
const START_PLAYBACK = "Start playback on the page, then try again. savemedia saves what your browser itself loads.";

const row = (label: string, value: string | number | null | undefined): TechnicalDetail | null =>
  value === null || value === undefined || value === "" ? null : { label, value: String(value) };

export function userMessage(err: JobError): UserMessage {
  const draft = describe(err);
  const block = draft.diagnostic ? networkBlock(draft.diagnostic, { answeredWithPage: draft.answeredWithPage === true }) : null;
  const text = block ? networkBlockText(block) : null;
  const network = draft.diagnostic ? diagnosticRows(draft.diagnostic) : [];
  const named = new Set(network.map(item => item.label));
  const own = (draft.rows ?? []).filter((item): item is TechnicalDetail => item !== null && !named.has(item.label));
  return {
    title: text?.title ?? draft.title,
    body: text?.body ?? draft.body,
    hint: text ? text.hint : draft.hint ?? null,
    tone: text ? "unavailable" : draft.tone ?? "unavailable",
    action: (text ? text.retry : draft.retry === true) ? RETRY : null,
    details: [...network, ...own, { label: "Error code", value: err.code }],
    ...(!text && draft.toastHint ? { toastHint: draft.toastHint } : {}),
  };
}

/** The line a toast shows for a failure: what happened and, when there is one, what to do from the page. */
export function toastDetail(message: Pick<UserMessage, "title" | "hint" | "toastHint">): string {
  const hint = message.toastHint ?? message.hint;
  return hint ? `${message.title}. ${hint}` : message.title;
}

function describe(err: JobError): Draft {
  switch (err.code) {
    // ---- protected media: no hint, no retry ----
    case "encrypted_media_detected":
      return protectedMedia(err.detectedVia, err.keySystem);
    case "cdm_required":
      return protectedMedia(err.detectedVia ?? [], err.keySystem);
    case "clearkey_deferred":
      return protectedMedia(err.detectedVia ?? ["eme-hook"], "org.w3.clearkey");
    case "license_bound_stream":
      return {
        title: "Protected video",
        body: "The key for this video comes from a licence server. savemedia does not use licence keys.",
        tone: "protected",
        rows: [row("Key server", hostOf(err.keyUri)), row("HTTP status", err.httpStatus)],
      };

    // ---- what arrived is not the file ----
    case "unexpected_media_response": {
      const rows = [row("Server", err.host), row("Answer", err.response === "page" ? "Web page" : err.response === "data" ? "Data" : "Unsupported format")];
      if (err.atSaveStart) {
        // The playlist answered when the video was found and is none now. Why is not known, so none is guessed:
        // the page's own player gets a playlist when it plays the video again. A network that answered in the
        // server's place is still explained from the browser's report.
        return {
          title: "The video's playlist no longer answers",
          body: err.response === "page"
            ? "This video's playlist answered when savemedia found it, but the server sent a web page in its place when the save started."
            : "This video's playlist answered when savemedia found it, but the server sent something else in its place when the save started.",
          hint: "Play the video on the page again, then save.",
          tone: "unusable", rows: [...rows, row("Request", "Playlist, read again as the save started")],
          diagnostic: err.browserDiagnostic, answeredWithPage: err.response === "page",
        };
      }
      if (err.response === "unsupported") {
        return { title: "This isn't a video savemedia can save", body: "The file's content is not a video format savemedia supports.",
          tone: "unusable", rows, diagnostic: err.browserDiagnostic };
      }
      return {
        title: err.response === "page" ? "The server sent a web page instead of the video" : "The server sent data instead of the video",
        body: err.response === "page" ? "The server answered with a web page, not the video file." : "The server answered with data, not the video file.",
        hint: `${RELOAD_AND_PLAY} If your browser or network shows a warning page, read it there.`,
        tone: "unusable", rows, diagnostic: err.browserDiagnostic, answeredWithPage: err.response === "page",
      };
    }
    case "hls_key_unusable":
      return {
        title: "The video's key can't be used",
        body: err.response === "page" ? "The key address answered with a web page instead of a key."
          : err.response === "data" ? "The key address answered with data instead of a key."
            : err.response === "rejected" ? "The key the server sent does not open this video, so nothing was saved."
              : "The key address sent something other than a 16-byte key.",
        hint: RELOAD_AND_PLAY,
        tone: "unusable",
        rows: [row("Key server", hostOf(err.keyUri)), row("Method", "AES-128"),
          row("Answer", err.response === "page" ? "Web page" : err.response === "data" ? "Data" : err.response === "rejected" ? "Key does not decrypt" : null),
          err.response === "binary" ? row("Size", `${err.byteLength} bytes`) : null],
        diagnostic: err.browserDiagnostic, answeredWithPage: err.response === "page",
      };
    case "verification_segment_count":
      return notVerified([row("Check", "Part count"), row("Expected", err.expected), row("Got", err.got)]);
    case "verification_duration":
      return notVerified([row("Check", "Duration"), row("Expected", `${err.expectedMs} ms`), row("Got", `${err.gotMs} ms`), row("Tolerance", `${err.toleranceMs} ms`)]);
    case "verification_checksum":
      return notVerified([row("Check", `Checksum (${err.algo})`)]);
    case "verification_container":
      return {
        title: "The file didn't pass the check",
        body: "The server's answer was incomplete or not the video file savemedia expected.",
        hint: "Reload the page, then try again.",
        tone: "unusable", retry: true,
        rows: [row("Check", plainDetail(err.probeError))],
      };

    // ---- availability and format ----
    case "hls_live_unsupported":
      return {
        title: "Live stream",
        body: "This is a live stream. savemedia saves only videos that have an end.",
        hint: "Try again when the page plays the full recording.",
        rows: [row("Stream", "Live"), row("Server", hostOf(err.manifestUrl))],
      };
    case "codec_unsupported":
      // A limit of the file savemedia writes, not a fault of the playlist: nothing a new look at the page changes.
      return {
        title: "Can't save in this format",
        body: err.track === "audio"
          ? "This video's sound is in a format savemedia can't put into an MP4 file in the browser."
          : "This video's picture is in a format savemedia can't put into an MP4 file in the browser.",
        rows: [row(err.track === "audio" ? "Audio format" : "Video format", err.codec), row("Server", hostOf(err.manifestUrl))],
      };
    case "dash_unsupported":
      return {
        title: "Can't save this stream in the browser",
        body: "This video uses a streaming layout that savemedia can't assemble in the browser.",
        rows: [row("Stream", "DASH"), row("Server", hostOf(err.manifestUrl))],
      };
    case "hls_encryption_unsupported":
      return {
        title: "Can't save this encrypted stream",
        body: "This video's encryption is arranged in a way savemedia can't assemble in the browser.",
        rows: [row("Method", err.method), row("Server", hostOf(err.manifestUrl))],
      };
    case "hls_layout_unsupported":
      return {
        title: "Can't save this stream in the browser",
        body: "This stream is built in a way savemedia can't join into one video file.",
        rows: [row("Reason", LAYOUT[err.layout]), row("Server", hostOf(err.manifestUrl))],
      };
    case "manifest_malformed":
      return {
        title: "The video's playlist can't be used",
        body: "The playlist the page sent is incomplete, or the chosen quality is no longer in it.",
        hint: "Press Check page again, then save.",
        toastHint: "Open savemedia and press Check page again, then save.",
        rows: [row("Server", hostOf(err.url)), row("Detail", plainDetail(err.parserError))],
      };
    case "manifest_too_large":
      return {
        title: "The video's playlist is too large",
        body: err.limit === "bytes" ? "The playlist the page sent is larger than savemedia reads, so it was not opened."
          : "The playlist the page sent lists more than savemedia reads, so it was not opened.",
        rows: [row("Limit", err.limit === "bytes" ? "Playlist size" : "Entries and address text"), row("Server", hostOf(err.url))],
      };
    case "private_network_target": {
      // For a page on the internet, a server inside the user's network is used only when the browser itself was
      // answered from it for this page. Here it was not: the page names the server, the browser did not load from it.
      if (err.ip && !isLocalHostName(err.host)) {
        // A public name that led into the local network: the network's doing, explained as such. savemedia set the
        // answer aside itself, whatever it was, so the text says so and offers no retry: the next answer is set aside too.
        // A name that only resolves locally has no address on the internet, so no network gave it "a local address instead".
        const text = networkBlockText({ kind: "private-address", host: err.host, ip: err.ip, toHost: null, code: null });
        return { title: text.title, body: `${text.body} ${NOT_LOADED_FROM_THERE}, so savemedia does not use the answer it got from there.`, hint: text.hint,
          rows: diagnosticRows({ host: err.host, code: null, ip: err.ip, finalHost: null, redirect: null }) };
      }
      return {
        title: "This media is on your local network",
        body: `This page is on the internet, and the media address it names points into your own network. ${NOT_LOADED_FROM_THERE}, so savemedia does not ${err.ip ? "use the answer it got from there" : "request it either"}.`,
        hint: START_PLAYBACK,
        rows: [row("Server", err.host)],
      };
    }
    case "unsupported_output":
      return {
        title: "Can't save in this format",
        body: `savemedia can't save this ${CONTAINER_NAME[err.from] ?? "video"} file in the browser.`,
        rows: [row("From", err.from), row("To", err.to), row("Reason", err.reason === "container-not-supported" ? "Container not supported" : "No conversion for this pair")],
      };
    // ---- server and network ----
    case "rate_limited":
      return {
        title: "The server asked savemedia to slow down",
        body: "The video server is limiting requests right now.",
        hint: retryAfterHint(err.retryAfterSeconds),
        retry: true,
        rows: [row("HTTP status", err.httpStatus), row("Retry-After", err.retryAfterSeconds === null ? null : `${err.retryAfterSeconds} s`),
          row("Server", hostOf(err.url)), row("Request", REQUEST[err.phase])],
      };
    case "server_busy":
      return {
        title: "The server is busy",
        body: err.httpStatus === 522 || err.httpStatus === 524 ? "The video server did not answer in time." : "The video server is not responding properly right now.",
        hint: "Try again in a few minutes.",
        retry: true,
        rows: [row("HTTP status", err.httpStatus), row("Server", hostOf(err.url)), row("Request", REQUEST[err.phase])],
        diagnostic: err.browserDiagnostic,
      };
    case "http_error":
      if (err.atSaveStart) return playlistRefusedAtSave(err.httpStatus, err.url, err.browserDiagnostic);
      return {
        title: "The server refused the file",
        body: err.httpStatus === 404 || err.httpStatus === 410 ? "The server no longer has this file." : "The server would not send this file.",
        hint: RELOAD_AND_PLAY,
        rows: [row("HTTP status", err.httpStatus), row("Server", hostOf(err.url)), row("Request", REQUEST[err.phase])],
        diagnostic: err.browserDiagnostic,
      };
    case "access_denied":
      if (err.atSaveStart) return playlistRefusedAtSave(err.httpStatus, err.url, err.browserDiagnostic);
      return { ...accessDenied(err.httpStatus, err.explanation),
        rows: [row("HTTP status", err.httpStatus), row("Server", hostOf(err.url)), row("Request", REQUEST[err.phase])],
        diagnostic: err.browserDiagnostic };
    case "network_unreachable": {
      const host = hostOf(err.url);
      const received = err.receivedBytes ? progressText(err.receivedBytes, err.totalBytes ?? null) : null;
      const rows = [row("Server", host), row("Request", REQUEST[err.phase]),
        row("During", err.during === "request" ? "Request" : err.during === "transfer" ? "Transfer" : "Stalled transfer"),
        err.receivedBytes ? row("Received", bytesOf(err.receivedBytes, err.totalBytes ?? null)) : null];
      if (err.during === "timeout") {
        return { title: "The video server stopped sending data", body: received ? `The download stalled after ${received}.` : "The download stalled.",
          hint: "Try again.", retry: true, rows, diagnostic: err.browserDiagnostic };
      }
      if (err.during === "transfer") {
        return { title: "The connection was lost",
          body: received ? `The connection to the video server dropped after ${received}.` : "The connection to the video server dropped.",
          hint: "Check your connection, then try again.", retry: true, rows, diagnostic: err.browserDiagnostic };
      }
      return { title: "Couldn't reach the video server",
        body: host ? `Your browser got no answer from ${host}.` : "Your browser got no answer from the video server.",
        hint: "Check your connection, then try again.", retry: true, rows, diagnostic: err.browserDiagnostic };
    }
    case "tls_certificate_rejected":
      // The words for a certificate error the browser did not name more closely; a code it did name replaces them in userMessage.
      return {
        ...networkBlockText({ kind: "certificate-other", host: err.browserDiagnostic.host, ip: null, toHost: null, code: null }),
        rows: [row("Request", REQUEST[err.phase])],
        diagnostic: err.browserDiagnostic,
      };
    case "insecure_media_redirect":
      return {
        title: "Stopped at an unsecured link",
        body: "The video started over a secure connection, then was sent to an unsecured one, so savemedia stopped.",
      };
    case "range_body_empty":
      return {
        title: "The server sent no data for the rest of the file",
        body: "The server agreed to continue the file, then sent nothing.",
        hint: "Try again later.",
        rows: [row("Server", err.host), row("Requested bytes", `${err.rangeStart}-${err.rangeEnd}`), row("Total", `${err.totalBytes} bytes`),
          row("Declared length", err.declaredBytes === null ? "none" : `${err.declaredBytes} bytes`), row("Last read", err.reason),
          row("Reconnects", err.reconnects)],
      };
    case "segment_budget_exhausted":
      return {
        title: "Parts of the video failed to download",
        body: `${err.failedSegments.length} of ${err.totalSegments} parts failed after several tries. savemedia saved nothing rather than a broken video.`,
        hint: "Try again.",
        retry: true,
        rows: [row("Failed parts", err.failedSegments.slice(0, 20).join(", ") + (err.failedSegments.length > 20 ? ", ..." : ""))],
      };
    case "transfer_failed":
      return { ...transferFailure(err.reason, err.receivedBytes, err.totalBytes),
        rows: [row("Server", err.host), row("HTTP status", err.httpStatus),
          err.receivedBytes === null ? null : row("Received", bytesOf(err.receivedBytes, err.totalBytes)), row("Reason", err.reason)],
        diagnostic: err.browserDiagnostic };

    // ---- savemedia itself and the browser ----
    case "engine_job_failed":
      return {
        ...(err.cause === "browser-resume" ? {
          title: "Your browser couldn't finish the download",
          body: "Your browser stopped while it continued its own interrupted download of this file.",
          hint: "Save again to download it from the start.",
        } : {
          title: "The save stopped",
          body: "Something went wrong while savemedia was preparing the file.",
          hint: "Try again.",
        }),
        retry: true,
        rows: [row("Stage", err.at), row("Cause", err.cause ?? "unexpected"), row("Detail", plainDetail(err.detail))],
      };
    case "engine_stopped":
      return {
        title: err.when === "start" ? "The save couldn't start" : "The save stopped before it finished",
        body: err.when === "start" ? "Your browser did not start the part of savemedia that saves files."
          : err.when === "running" ? "Your browser closed the part of savemedia that was saving the file."
            : "Your browser paused savemedia while it was saving.",
        hint: "Save it again.",
        retry: true,
        rows: [row("When", err.when)],
      };
    case "browser_download_failed":
      return {
        title: "Your browser didn't save the file",
        body: `Your browser stopped saving ${err.filename}.`,
        hint: "Check free disk space and your browser's download settings, then try again.",
        rows: [row("Browser reason", plainDetail(err.reason))],
      };
    case "user_cancelled":
      return { title: "Cancelled", body: "Nothing was saved.", tone: "neutral" };
  }
}

const REQUEST: Readonly<Record<"manifest" | "segment" | "direct", string>> = { manifest: "Playlist", segment: "Video part", direct: "File" };

const LAYOUT: Readonly<Record<Extract<JobError, { code: "hls_layout_unsupported" }>["layout"], string>> = {
  "not-transport-stream": "A part is not an MPEG transport stream",
  "init-boxes": "The MP4 header lacks required boxes",
  "fragment-boxes": "A part lacks required MP4 boxes",
  "box-structure": "A part has damaged MP4 boxes",
  "byte-ranges": "The parts are byte ranges that do not add up to one file",
  "init-changes": "The MP4 header changes part-way through the stream",
};

const CONTAINER_NAME: Readonly<Record<string, string>> = {
  mp4: "MP4", mov: "QuickTime", webm: "WebM", mkv: "MKV", mpegts: "MPEG-TS", fmp4: "fragmented MP4", cmaf: "CMAF",
};

const KEY_SYSTEM_NAME: readonly (readonly [RegExp, string])[] = [
  [/^com\.widevine\.alpha/, "Widevine"],
  [/^com\.microsoft\.playready/, "PlayReady"],
  [/^com\.apple\.(?:fps|streamingkeydelivery)/, "FairPlay"],
  [/^org\.w3\.clearkey/, "Clear Key"],
];

const SOURCE_NAME: Readonly<Record<DrmSignalSource, string>> = {
  "eme-hook": "Player",
  "hls-ext-x-key": "HLS playlist",
  "dash-content-protection": "DASH manifest",
  "mp4-protection": "MP4 header",
  "matroska-protection": "WebM or Matroska track",
  "mpeg-ts": "Transport stream",
  "clearkey-detector": "DASH manifest",
};

/** The method names an HLS key tag can state that are not a key system. */
const HLS_METHOD = /^(?:SAMPLE-AES|AES-)/i;

function keySystemName(keySystem: string | null): string | null {
  if (!keySystem || keySystem === "unknown") return null;
  const value = keySystem.toLowerCase();
  return KEY_SYSTEM_NAME.find(([pattern]) => pattern.test(value))?.[1] ?? plainDetail(keySystem);
}

/** One title for every kind of protection. The body is chosen from what the error states, never guessed. */
function protectedMedia(detectedVia: readonly DrmSignalSource[], keySystem: string | null): Draft {
  const sources = [...new Set(detectedVia.map(source => SOURCE_NAME[source]))].join(", ");
  const base = { title: "Protected video", tone: "protected" as const };
  if (detectedVia.includes("mpeg-ts")) {
    return { ...base, body: "This video stream is scrambled. savemedia does not descramble protected streams.", rows: [row("Detected in", sources)] };
  }
  if (keySystem && HLS_METHOD.test(keySystem)) {
    return { ...base, body: "This video uses an encryption method that savemedia does not decrypt.",
      rows: [row("Method", keySystem.toUpperCase()), row("Detected in", sources)] };
  }
  const rows = [row("Protection", keySystemName(keySystem)), row("Detected in", sources)];
  if (detectedVia.includes("eme-hook")) {
    return { ...base, body: "This video plays through your browser's protected playback. savemedia does not save media protected this way.", rows };
  }
  return { ...base, body: "This video is protected with DRM. savemedia does not save DRM-protected media.", rows };
}

function notVerified(rows: readonly (TechnicalDetail | null)[]): Draft {
  return {
    title: "The file didn't pass the check",
    body: "The downloaded file was incomplete or damaged, so savemedia did not save it.",
    hint: "Try again.",
    tone: "unusable", retry: true, rows,
  };
}

function retryAfterHint(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "Wait a few minutes, then try again.";
  if (seconds < 120) return `Try again in about ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
  return `Try again in about ${Math.round(seconds / 60)} minutes.`;
}

/**
 * A save reads the video's playlist again when it starts. The playlist answered when the video was found and the
 * server refuses it now. Why is not known from a status, so none is guessed: the page's own player gets a
 * playlist that answers when it plays the video again.
 */
function playlistRefusedAtSave(status: number, url: string, diagnostic: BrowserRequestDiagnostic | undefined): Draft {
  return {
    title: "The video's playlist no longer answers",
    body: "This video's playlist answered when savemedia found it, but the server refused it when the save started.",
    hint: "Play the video on the page again, then save.",
    rows: [row("HTTP status", status), row("Server", hostOf(url)), row("Request", "Playlist, read again as the save started")],
    diagnostic,
  };
}

function accessDenied(status: 401 | 402 | 403 | 451, explanation: string): Pick<Draft, "title" | "body" | "hint"> {
  const signedIn = "If you have access, play the video on the page while signed in, then try again.";
  if (status === 451 || explanation === "legal-restriction") {
    return { title: "Blocked for legal reasons", body: "The server or your network says this video is unavailable for legal reasons.",
      hint: "Read the notice on the page, or ask your network provider." };
  }
  if (status === 402 || explanation === "payment-or-entitlement") {
    return { title: "The server refused access", body: "The server says this file needs an account or a purchase.", hint: signedIn };
  }
  if (explanation === "login-or-cookie") {
    return { title: "The server refused access", body: "The server did not accept your session for this file.", hint: signedIn };
  }
  return { title: "The server refused access", body: "The server refused this file. Its link may have expired.", hint: RELOAD_AND_PLAY };
}

function transferFailure(reason: TransferFailureReason, received: number | null, total: number | null): Pick<Draft, "title" | "body" | "hint" | "toastHint" | "retry"> {
  const stopped = received !== null ? `The server stopped after ${progressText(received, total)}` : "The server stopped early";
  // The hint names the popup's button, so the button is offered. The toast says the same without it.
  const fromStart = { hint: "Retry save starts the file again from the beginning.", toastHint: "Save again to start the file from the beginning.", retry: true };
  switch (reason) {
    case "ended-early":
      return { title: "The download stopped early", body: `${stopped} and did not let savemedia continue.`, hint: "Try again later." };
    case "resume-refused":
      return { title: "The download can't continue", body: `${stopped} and won't send the rest.`, ...fromStart };
    case "resume-unverifiable":
      return { title: "The download can't continue safely",
        body: `${stopped} and gives no way to check that the rest belongs to the same file.`, ...fromStart };
    case "file-changed":
    case "content-mismatch":
      return { title: "The file changed on the server",
        body: "The file was replaced while savemedia was saving it, so its parts don't belong together.", hint: "Save again to get the current version." };
    case "link-changed":
      return { title: "The link now leads to a different file", body: "The video's link changed while it was being saved.",
        hint: "Reload the page, then save again." };
    case "range-mismatch":
    case "range-length":
    case "range-slices":
    case "range-encoded":
    case "body-long":
      return { title: "The server's answer can't be used",
        body: "The server sent parts of the file that don't fit together, so nothing was saved.", hint: "Try again later." };
  }
}

/** The host (with a port that is not the default) of an address. A path or query never leaves this module. */
function hostOf(url: string): string | null {
  try { return new URL(url).host || null; } catch { return null; }
}

function progressText(received: number, total: number | null): string {
  return total ? `${formatBytes(received)} of ${formatBytes(total)}` : formatBytes(received);
}

function bytesOf(received: number, total: number | null): string {
  return total ? `${received} of ${total} bytes` : `${received} bytes`;
}

/** Technical text for a details row: one line, bounded, and an address reduced to its host. */
export function technicalText(text: string | null | undefined): string | null {
  return plainDetail(text);
}

function plainDetail(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, address => hostOf(address) ?? "address").replace(/\s+/g, " ").trim();
  return line ? line.slice(0, 300) : null;
}
