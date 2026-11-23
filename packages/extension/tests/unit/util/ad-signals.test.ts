import { describe, expect, it } from "vitest";
import { assetListUris, hlsInterstitials, vastMediaFiles } from "../../../src/util/ad-signals";

const xml = (text: string) => new DOMParser().parseFromString(text, "text/xml");

describe("ad-signals", () => {
  it("reads MediaFile and Mezzanine addresses from inline VAST 3 and 4, CDATA included", () => {
    const vast = xml(`<VAST version="4.2"><Ad><InLine><Creatives><Creative><Linear><MediaFiles>
      <Mezzanine><![CDATA[ https://ads.test/mezz.mov ]]></Mezzanine>
      <MediaFile type="video/mp4"><![CDATA[https://ads.test/creative.mp4#t]]></MediaFile>
      <MediaFile type="video/webm">/relative/creative.webm</MediaFile>
      </MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>`);
    expect(vastMediaFiles(vast, "https://page.test/ads/vast.xml")).toEqual({ via: "vast",
      urls: ["https://ads.test/mezz.mov", "https://ads.test/creative.mp4", "https://page.test/relative/creative.webm"] });
    expect(vastMediaFiles(xml(`<VAST version="3.0"><Ad><InLine><MediaFile>https://ads.test/three.mp4</MediaFile></InLine></Ad></VAST>`), "https://p.test/"))
      .toEqual({ via: "vast", urls: ["https://ads.test/three.mp4"] });
  });

  it("gives no address for a wrapper and never reads its tag address", () => {
    const wrapper = xml(`<VAST version="4.0"><Ad><Wrapper><VASTAdTagURI><![CDATA[https://ads.test/next.xml]]></VASTAdTagURI></Wrapper></Ad></VAST>`);
    expect(vastMediaFiles(wrapper, "https://p.test/")).toEqual({ via: "vast", urls: [] });
  });

  it("reads inline VAST inside VMAP and ignores other XML", () => {
    const vmap = xml(`<vmap:VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap" version="1.0"><vmap:AdBreak><vmap:AdSource>
      <vmap:VASTAdData><VAST version="3.0"><Ad><InLine><MediaFile>https://ads.test/break.mp4</MediaFile></InLine></Ad></VAST></vmap:VASTAdData>
      </vmap:AdSource></vmap:AdBreak><vmap:AdBreak><vmap:AdSource><vmap:AdTagURI>https://ads.test/tag</vmap:AdTagURI></vmap:AdSource></vmap:AdBreak></vmap:VMAP>`);
    expect(vastMediaFiles(vmap, "https://p.test/")).toEqual({ via: "vmap", urls: ["https://ads.test/break.mp4"] });
    expect(vastMediaFiles(xml(`<rss><channel><item><enclosure url="https://a.test/a.mp4"/></item></channel></rss>`), "https://p.test/")).toBeNull();
  });

  it("reads interstitial assets and asset lists from DATERANGE tags, with quoted commas", () => {
    const playlist = `#EXTM3U
#EXT-X-DATERANGE:ID="ad1",CLASS="com.apple.hls.interstitial",START-DATE="2026-01-01T00:00:00Z",X-ASSET-URI="https://ads.test/a,b/ad.m3u8",X-RESUME-OFFSET=0
#EXT-X-DATERANGE:ID="ad2",CLASS="com.apple.hls.interstitial",START-DATE="2026-01-01T00:01:00Z",X-ASSET-LIST="lists/assets.json"
#EXT-X-DATERANGE:ID="chapter",CLASS="com.example.chapter",X-ASSET-URI="https://ads.test/not-an-ad.m3u8"
#EXTINF:4,
seg.ts`;
    expect(hlsInterstitials(playlist, "https://cdn.test/v/media.m3u8")).toEqual({
      assetUris: ["https://ads.test/a,b/ad.m3u8"], assetLists: ["https://cdn.test/v/lists/assets.json"] });
    expect(hlsInterstitials("#EXTM3U\n#EXTINF:4,\nseg.ts", "https://cdn.test/v/media.m3u8")).toEqual({ assetUris: [], assetLists: [] });
  });

  it("reads asset list JSON and ignores other shapes", () => {
    expect(assetListUris(JSON.stringify({ ASSETS: [{ URI: "ad1.m3u8", DURATION: 15 }, { URI: "https://ads.test/ad2.m3u8" }, { DURATION: 3 }] }),
      "https://cdn.test/lists/assets.json")).toEqual(["https://cdn.test/lists/ad1.m3u8", "https://ads.test/ad2.m3u8"]);
    expect(assetListUris("{\"ASSETS\":3}", "https://cdn.test/")).toEqual([]);
    expect(assetListUris("not json", "https://cdn.test/")).toEqual([]);
  });
});
