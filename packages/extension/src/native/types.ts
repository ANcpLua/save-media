/**
 * Wire-protocol types for the savemedia native messaging host.
 *
 * Mirrored from docs/design.md § 5.3 and native-host/savemedia_host/schema.py.
 * Updating any field requires touching all three places.
 */

export type ProgressPhase = "fetching" | "downloading" | "writing" | "muxing" | "finalizing";

export type HostCapability = "sink" | "ytdlp" | "probe";

export type HostErrorCode =
  | "native_host_dependency"
  | "native_host_timeout"
  | "native_host_protocol"
  | "native_sink_io_error";

export type HostRequest =
  | { readonly type: "ping"; readonly nonce: string; readonly version: string }
  | { readonly type: "download.ytdlp"; readonly nonce: string; readonly url: string; readonly quality: string; readonly outputDir: string }
  | { readonly type: "sink.open"; readonly nonce: string; readonly filename: string; readonly expectedSize: number | null }
  | { readonly type: "sink.chunk"; readonly nonce: string; readonly sinkId: string; readonly dataB64: string; readonly offset: number }
  | { readonly type: "sink.close"; readonly nonce: string; readonly sinkId: string; readonly finalChecksum: string }
  | { readonly type: "sink.abort"; readonly nonce: string; readonly sinkId: string }
  | { readonly type: "probe"; readonly nonce: string; readonly url: string };

export type HostResponse =
  | { readonly type: "pong"; readonly nonce: string; readonly host: string; readonly version: string; readonly capabilities: readonly HostCapability[] }
  | { readonly type: "progress"; readonly nonce: string; readonly bytesWritten: number; readonly bytesTotal: number | null; readonly phase: ProgressPhase }
  | { readonly type: "complete"; readonly nonce: string; readonly outputPath: string; readonly bytesWritten: number; readonly checksum: string }
  | { readonly type: "sink.opened"; readonly nonce: string; readonly sinkId: string }
  | { readonly type: "sink.ack"; readonly nonce: string; readonly sinkId: string; readonly bytesAcked: number }
  | { readonly type: "sink.aborted"; readonly nonce: string; readonly sinkId: string; readonly partialBytesDiscarded: number }
  | { readonly type: "probe.result"; readonly nonce: string; readonly data: unknown }
  | { readonly type: "error"; readonly nonce: string; readonly code: HostErrorCode; readonly detail: string };

export const NATIVE_HOST_NAME = "com.savemedia.host" as const;
export const NATIVE_SINK_CHUNK_BYTES = 1024 * 1024; // 1 MB per design §5.3
export const NATIVE_RESPONSE_MAX_BYTES = 1024 * 1024; // host → browser cap
