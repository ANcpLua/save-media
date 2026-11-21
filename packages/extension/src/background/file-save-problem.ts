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
      title: "The last download attempt stopped",
      body: "The browser couldn’t verify the file server on that attempt. If you continue, SaveMedia will try the site’s Download button again with certificate checks on." };
  }

  const { title, body } = userMessage(error);
  return { filename, stage, code: error.code, title, body };
}
