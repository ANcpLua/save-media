import type { VideoCodec, AudioCodec, VideoCodecFamily, AudioCodecFamily } from "../types/codec";

interface VideoEntry {
  readonly prefix: string;
  readonly family: VideoCodecFamily;
  readonly friendlyPrefix: string;
  readonly parse: (rfc6381: string) => { profile: string | null; level: string | null };
}

const H264_PROFILES: Record<string, string> = {
  "42": "Baseline", "4d": "Main", "58": "Extended", "64": "High",
  "6e": "High 10", "7a": "High 4:2:2", "f4": "High 4:4:4",
};

function parseH264(rfc6381: string): { profile: string | null; level: string | null } {
  const m = /^avc[13]\.([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(rfc6381);
  if (!m) return { profile: null, level: null };
  const profile = H264_PROFILES[m[1]!.toLowerCase()] ?? null;
  const levelByte = parseInt(m[3]!, 16);
  const level = `${Math.floor(levelByte / 10)}.${levelByte % 10}`;
  return { profile, level };
}

function parseH265(rfc6381: string): { profile: string | null; level: string | null } {
  const m = /^h[ev]c1\.(\d+)\.\d+\.L(\d+)\.B\d+$/i.exec(rfc6381);
  if (!m) return { profile: null, level: null };
  const profileId = m[1]!;
  const profile = profileId === "1" ? "Main" : profileId === "2" ? "Main 10" : `Profile ${profileId}`;
  const levelNum = parseInt(m[2]!, 10);
  // HEVC level = L / 30, e.g. L150 → 5.0
  const major = Math.floor(levelNum / 30);
  const minor = Math.floor((levelNum % 30) / 3);
  const level = `${major}.${minor}`;
  return { profile, level };
}

function parseVp9(rfc6381: string): { profile: string | null; level: string | null } {
  const m = /^vp09\.(\d{2})\.(\d{2})\.(\d{2})$/.exec(rfc6381);
  if (!m) return { profile: null, level: null };
  return { profile: `Profile ${parseInt(m[1]!, 10)}`, level: `Lvl ${parseInt(m[2]!, 10) / 10} ${parseInt(m[3]!, 10)}-bit` };
}

function parseAv1(rfc6381: string): { profile: string | null; level: string | null } {
  const m = /^av01\.(\d)\.(\d{2})M\.(\d{2})$/.exec(rfc6381);
  if (!m) return { profile: null, level: null };
  const profileName = m[1] === "0" ? "Main" : m[1] === "1" ? "High" : "Professional";
  return { profile: profileName, level: `${parseInt(m[2]!, 10) / 10} ${parseInt(m[3]!, 10)}-bit` };
}

const noDetails = (): { profile: null; level: null } => ({ profile: null, level: null });

const VIDEO_REGISTRY: readonly VideoEntry[] = [
  { prefix: "avc1.", family: "h264", friendlyPrefix: "H.264", parse: parseH264 },
  { prefix: "avc3.", family: "h264", friendlyPrefix: "H.264", parse: parseH264 },
  { prefix: "hvc1.", family: "h265", friendlyPrefix: "H.265", parse: parseH265 },
  { prefix: "hev1.", family: "h265", friendlyPrefix: "H.265", parse: parseH265 },
  { prefix: "vp09.", family: "vp9",  friendlyPrefix: "VP9",   parse: parseVp9 },
  { prefix: "vp08",  family: "vp8",  friendlyPrefix: "VP8",   parse: noDetails },
  { prefix: "av01.", family: "av1",  friendlyPrefix: "AV1",   parse: parseAv1 },
];

export function parseVideoCodec(rfc6381: string): VideoCodec | null {
  const lower = rfc6381.toLowerCase();
  for (const entry of VIDEO_REGISTRY) {
    if (lower.startsWith(entry.prefix)) {
      const { profile, level } = entry.parse(rfc6381);
      return { rfc6381, family: entry.family, profile, level };
    }
  }
  return null;
}

export function friendlyVideoCodec(codec: VideoCodec): string {
  const lower = codec.rfc6381.toLowerCase();
  const entry = VIDEO_REGISTRY.find(e => lower.startsWith(e.prefix));
  if (!entry) return codec.rfc6381;
  const parts = [entry.friendlyPrefix];
  if (codec.profile) parts.push(codec.profile);
  if (codec.level) parts.push(`@ ${codec.level}`);
  return parts.join(" ");
}

interface AudioEntry {
  readonly match: (rfc6381: string) => boolean;
  readonly family: AudioCodecFamily;
  readonly friendly: (rfc6381: string) => string;
}

const AUDIO_REGISTRY: readonly AudioEntry[] = [
  { match: r => r === "mp4a.40.2",      family: "aac",    friendly: () => "AAC-LC" },
  { match: r => r === "mp4a.40.5",      family: "aac",    friendly: () => "HE-AAC" },
  { match: r => r.startsWith("mp4a.40."), family: "aac",   friendly: () => "AAC" },
  { match: r => r === "mp4a.6b" || r === "mp3", family: "mp3", friendly: () => "MP3" },
  { match: r => r === "opus",           family: "opus",   friendly: () => "Opus" },
  { match: r => r === "vorbis",         family: "vorbis", friendly: () => "Vorbis" },
  { match: r => r === "flac",           family: "flac",   friendly: () => "FLAC" },
  { match: r => r === "ac-3",           family: "ac3",    friendly: () => "AC-3" },
  { match: r => r === "ec-3",           family: "eac3",   friendly: () => "E-AC-3" },
  { match: r => r === "alac",           family: "alac",   friendly: () => "ALAC" },
];

export function parseAudioCodec(rfc6381: string): AudioCodec | null {
  const lower = rfc6381.toLowerCase();
  const entry = AUDIO_REGISTRY.find(e => e.match(lower));
  if (!entry) return null;
  return { rfc6381, family: entry.family, channels: null, sampleRate: null };
}

export function friendlyAudioCodec(codec: AudioCodec): string {
  if (codec.rfc6381 === null) return codec.family.toUpperCase();
  const lower = codec.rfc6381.toLowerCase();
  const entry = AUDIO_REGISTRY.find(e => e.match(lower));
  return entry ? entry.friendly(codec.rfc6381) : codec.rfc6381;
}
