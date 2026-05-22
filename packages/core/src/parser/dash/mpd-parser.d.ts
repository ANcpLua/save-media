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
        }>;
      }>>;
    };
  };
}
