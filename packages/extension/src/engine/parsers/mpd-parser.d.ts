declare module "mpd-parser" {
  export interface ParsedSegment {
    uri: string;
    timeline?: number;
    duration?: number;
    map?: { uri: string };
    number?: number;
    presentationTime?: number;
  }
  export interface ParsedPlaylist {
    uri: string;
    attributes?: {
      RESOLUTION?: { width: number; height: number };
      BANDWIDTH?: number;
      CODECS?: string;
      NAME?: string;
      "FRAME-RATE"?: number;
    };
    segments?: ReadonlyArray<ParsedSegment>;
    sidx?: { uri: string };
  }
  export interface ParsedMpd {
    playlists?: ReadonlyArray<ParsedPlaylist>;
    mediaGroups?: {
      AUDIO?: Record<string, Record<string, {
        playlists?: ReadonlyArray<ParsedPlaylist>;
      }>>;
    };
  }
  export function parse(manifestXml: string, options: { manifestUri: string }): ParsedMpd;
}
