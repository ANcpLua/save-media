/** Reserve red for an unusable file. A connection failure reports availability. */
export function downloadIssueText(issue: { code: string }): string {
  return issue.code === "unexpected_media_response" || issue.code.startsWith("verification_")
    ? "text-red-300" : "text-orange-300";
}
