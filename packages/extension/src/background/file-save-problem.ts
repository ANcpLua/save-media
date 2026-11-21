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

  const { title, body, technicalDetails } = userMessage(error);
  return {
    filename, stage, code: error.code, title, body,
    ...(technicalDetails ? { technicalDetails } : {}),
  };
}
