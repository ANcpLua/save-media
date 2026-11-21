import { relayHost } from "../engine/relay-config";
import { userMessage, type JobError } from "@savemedia/core";
import type { FileSaveProblem } from "../types/messages";

export function describeFileSaveProblem(
  filename: string, stage: FileSaveProblem["stage"], error?: JobError,
): FileSaveProblem {
  if (!error) {
    const linkUnavailable = stage === "download link";
    return {
      filename, stage,
      code: linkUnavailable ? "download_link_unavailable" : "download_could_not_start",
      title: linkUnavailable ? "Couldn’t get a download link" : "Couldn’t start the download",
      body: "Reload the file page and try again.",
    };
  }

  if (stage === "file connection" && error.code === "tls_certificate_rejected") {
    return { filename, stage, code: error.code,
      title: "Couldn’t verify the last connection",
      body: relayHost ? `Try the secure relay for this site until Chrome closes. ${relayHost} sees your IP and server names. The link and video stay encrypted, and SaveMedia checks the file server’s certificate.` : "The browser couldn’t verify the file server on that attempt. Continue only if you trust the source. Download anyway retries the site’s download link with certificate checks on." };
  }

  const { title, body } = userMessage(error);
  return { filename, stage, code: error.code, title, body };
}
