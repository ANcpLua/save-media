export type {
  StreamDescriptor, StreamId, ProtocolFamily, Container, OutputContainer,
  Confidence, ConfidenceLevel, OutputCapabilities,
  DrmStatus, DrmReason, DrmSignalSource, StreamSource, Presentation,
} from "./types/stream";
export type {
  VideoCodec, AudioCodec, VideoCodecFamily, AudioCodecFamily,
  CodecSet, SubtitleTrack, Variant, VariantId, AudioRenditionId,
  SegmentRef, ByteRange, HlsEncryption, HlsSegmentKey,
} from "./types/codec";
export type {
  JobPlan, JobStep, DirectPlan, HlsPlainPlan, AvMergePlan, MergeTrack,
  OutputMode, UserChoice, DispatchRefusal, DispatchRefusalReason,
  VerifyCheckKind,
} from "./types/job";
export type { BrowserRequestDiagnostic, JobError, JobErrorCode, JobErrorSeverity, TransferFailureReason } from "./errors/taxonomy";
export type { UserMessage, ActionKind, MessageTone, TechnicalDetail } from "./errors/messages";
export type { NetworkBlock, NetworkBlockKind, NetworkBlockText } from "./errors/network-block";
export type { AddressScope } from "./net/address";
export type { VerifiedOutput, UnverifiedOutput, VerifyCheck, VerifyResult } from "./engine/verify";
export type { ClassifyInput } from "./classifier/classify";
export type { RetryClass } from "./coordinator/retry";
export type { HlsKeyDeclaration, HlsKeyPlan } from "./parser/hls/keys";

export { classify } from "./classifier/classify";
export { addressBudget, checkManifestSize, hlsSegmentLines, isoDurationSeconds, manifestTooLarge,
  MAX_DASH_BASE_URL_COMBINATIONS, MAX_MANIFEST_ADDRESS_BYTES, MAX_MANIFEST_BYTES, MAX_SEGMENTS_PER_MANIFEST, MAX_SEGMENTS_PER_TRACK } from "./parser/limits";
export { dashSegmentEstimate } from "./parser/dash/bounded";
export { parseDash } from "./parser/dash/adapter";
export { coveredFileEnd, coveredFileWithGaps } from "./parser/byte-ranges";
export type { FileRange } from "./parser/byte-ranges";
export type { DashParseResult } from "./parser/dash/adapter";
export { dispatch, compareVideoQuality, pickVariant, pickHlsAudioRendition, hasPendingHlsPair } from "./engine/dispatch";
export { verify } from "./engine/verify";
export { userMessage, toastDetail, technicalText } from "./errors/messages";
export { BROWSER_ERROR_CODE, isCertificateError, networkBlock, networkBlockText } from "./errors/network-block";
export { addressScope, isLocalHostName, isLocalScope, isPublicHostName, SCOPE_LABEL } from "./net/address";
export { formatBytes } from "./format/bytes";
export { errorFacts } from "./errors/facts";
export type { ErrorFacts, FactValue } from "./errors/facts";
export { isJobError } from "./errors/taxonomy";
export { computeBackoffMs, isRetryableStatus, retryAfterMs, MAX_AUTOMATIC_WAIT_MS, RETRY_POLICY } from "./coordinator/retry";
export { parseVideoCodec, parseAudioCodec, friendlyVideoCodec, friendlyAudioCodec } from "./classifier/codec-registry";
export { detectContainerFromBytes, detectContainerFromMime } from "./classifier/container-registry";
export { findMp4Protection } from "./classifier/protected-mp4";
export type { Mp4Protection } from "./classifier/protected-mp4";
export { beginsWholeMediaFile } from "./classifier/whole-file";
export { hasMatroskaEncryption, readEbmlHeader, MATROSKA_CLUSTER, MATROSKA_SEGMENT, MATROSKA_TRACKS } from "./classifier/protected-matroska";
export type { EbmlElementHeader } from "./classifier/protected-matroska";
export { probeInitSegment } from "./parser/init-segment/probe";
export {
  AES_128_KEY_BYTES,
  declarationOf,
  hlsEncryptionOf,
  hlsKeyDrm,
  isClearAes128,
  isDecryptableLength,
  parseHlsKeyDeclarations,
  parseHlsSessionKeys,
  planHlsKeys,
  segmentIv,
} from "./parser/hls/keys";
