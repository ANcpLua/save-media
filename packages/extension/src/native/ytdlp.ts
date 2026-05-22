import type { NativeBridge } from "./bridge";

/**
 * Escalate to the native host's yt-dlp for cookie-bound CDNs or sites that
 * the in-browser engine cannot handle. The host runs yt-dlp with explicit
 * argv; output goes to the host's resolved downloads directory.
 */
export interface YtdlpRequest {
  readonly url: string;
  readonly quality: "best" | "2160p" | "1440p" | "1080p" | "720p";
  readonly outputDir: string;
}

export interface YtdlpResult {
  readonly outputPath: string;
  readonly bytesWritten: number;
  readonly checksum: string;
}

export async function escalateToYtdlp(
  bridge: NativeBridge,
  req: YtdlpRequest,
): Promise<YtdlpResult> {
  const response = await bridge.request({
    type: "download.ytdlp",
    url: req.url,
    quality: req.quality,
    outputDir: req.outputDir,
  });
  if (response.type !== "complete") {
    throw new Error(`yt-dlp escalation failed: ${response.type}`);
  }
  return {
    outputPath: response.outputPath,
    bytesWritten: response.bytesWritten,
    checksum: response.checksum,
  };
}
