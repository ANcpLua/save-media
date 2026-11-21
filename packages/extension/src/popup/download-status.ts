import { isCertificateError } from "@savemedia/core";

/** Red marks a failed connection or media check. Other observed download obstacles are orange. */
export function downloadIssueText(issue: { code: string; browserDiagnostic?: { code: string } }): string {
  const unverified = issue.code === "tls_certificate_rejected" || issue.code === "secure_retry_failed"
    || issue.code === "https_link_unavailable" || issue.code === "mixed_content_blocked" || issue.code === "insecure_media_redirect"
    || issue.code === "unexpected_media_response" || issue.code.startsWith("verification_")
    || (issue.browserDiagnostic && isCertificateError(issue.browserDiagnostic.code));
  return unverified ? "text-red-300" : "text-orange-300";
}
