declare module "mpd-parser" {
  /** An element of the parsed MPD document. */
  export interface MpdElement {
    readonly tagName?: string;
    readonly childNodes?: { readonly length: number; readonly [index: number]: MpdElement };
  }
  /** One representation after inheritance, per base address, before its segments are built. */
  export interface RepresentationInfo {
    readonly attributes: Record<string, unknown>;
    readonly segmentInfo: {
      readonly template?: Record<string, unknown>;
      readonly base?: Record<string, unknown>;
      readonly list?: Record<string, unknown>;
      readonly segmentTimeline?: readonly Record<string, unknown>[];
    };
  }
  export function stringToMpdXml(manifestText: string): MpdElement;
  export function inheritAttributes(mpd: MpdElement, options: { manifestUri: string; NOW?: number }): {
    readonly representationInfo: readonly RepresentationInfo[];
    readonly locations?: unknown;
    readonly contentSteeringInfo?: unknown;
    readonly eventStream?: unknown;
  };
  export function toPlaylists(representations: readonly RepresentationInfo[]): unknown[];
  export function toM3u8(input: { dashPlaylists: unknown[]; locations?: unknown; contentSteering?: unknown; eventStream?: unknown }): MpdManifest;
  export function parse(manifestText: string, options: { manifestUri: string }): MpdManifest;
  export interface MpdManifest {
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
      /** SegmentBase with an index range: the representation's one file, with the ranges of its index and header. */
      sidx?: {
        resolvedUri: string;
        duration: number;
        byterange?: { length: number; offset: number };
        map?: { resolvedUri?: string; byterange?: { length: number; offset: number } };
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
          sidx?: {
            resolvedUri: string;
            duration: number;
            byterange?: { length: number; offset: number };
            map?: { resolvedUri?: string; byterange?: { length: number; offset: number } };
          };
        }>;
      }>>;
    };
  }
}
