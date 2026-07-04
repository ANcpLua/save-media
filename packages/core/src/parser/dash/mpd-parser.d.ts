declare module "mpd-parser" {
  export function parse(
    manifestText: string,
    options: { manifestUri: string }
  ): {
    playlists?: ReadonlyArray<{
      attributes?: Record<string, unknown> & {
        BANDWIDTH?: number;
        CODECS?: string;
        RESOLUTION?: { width: number; height: number };
        "FRAME-RATE"?: number;
        NAME?: string;
      };
      /** true iff MPD@type is static (mpd-parser defaults a missing type to static) */
      endList?: boolean;
      /** SegmentTemplate/SegmentList fully expanded by mpd-parser */
      segments?: ReadonlyArray<{
        resolvedUri: string;
        duration: number;
        map?: {
          resolvedUri?: string;
          byterange?: { length: number; offset: number };
        };
        /** Present for SegmentBase/sidx byte-range addressing */
        byterange?: { length: number; offset: number };
      }>;
      /** Keys are resolved key-system strings e.g. "com.widevine.alpha" */
      contentProtection?: Record<string, {
        attributes?: { schemeIdUri?: string; value?: string };
      }>;
    }>;
    mediaGroups?: {
      AUDIO?: Record<string, Record<string, {
        language?: string;
        autoselect?: boolean;
        default?: boolean;
        playlists?: ReadonlyArray<{
          attributes?: Record<string, unknown> & {
            BANDWIDTH?: number;
            CODECS?: string;
            NAME?: string;
          };
          /** true iff MPD@type is static (mpd-parser defaults a missing type to static) */
          endList?: boolean;
          segments?: ReadonlyArray<{
            resolvedUri: string;
            duration: number;
            map?: {
              resolvedUri?: string;
              byterange?: { length: number; offset: number };
            };
            byterange?: { length: number; offset: number };
          }>;
        }>;
      }>>;
    };
  };
}
