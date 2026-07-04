declare module "m3u8-parser" {
  export class Parser {
    manifest: {
      playlists?: ReadonlyArray<{
        uri: string;
        attributes?: {
          BANDWIDTH?: number;
          "FRAME-RATE"?: number;
          RESOLUTION?: { width: number; height: number };
          CODECS?: string;
          /** GROUP-ID of the EXT-X-MEDIA audio group linked via AUDIO= */
          AUDIO?: string;
        };
      }>;
      mediaGroups?: {
        /** groupId → rendition NAME → rendition attributes */
        AUDIO?: Record<string, Record<string, {
          default?: boolean;
          autoselect?: boolean;
          language?: string;
          /** Absent when the rendition's audio is muxed into the variant stream */
          uri?: string;
        }>>;
      };
      segments?: ReadonlyArray<{
        uri: string;
        duration: number;
        key?: { method: string; uri: string; iv?: Uint8Array };
        map?: { uri: string; byterange?: { length: number; offset: number } };
        byterange?: { length: number; offset: number };
      }>;
      endList?: boolean;
      /** Populated for DRM schemes (SAMPLE-AES / FairPlay / Widevine) */
      contentProtection?: Record<
        string,
        {
          attributes: {
            METHOD: string;
            URI: string;
            KEYFORMAT?: string;
            [key: string]: string | undefined;
          };
        }
      >;
    };
    push(chunk: string): void;
    end(): void;
  }
}
