# savemedia

Video downloader for verified direct files and plain HLS streams. It saves browser-visible video only when it can prove the bytes are a complete, playable file — direct MP4 / WebM / MKV, and plain HLS VOD remuxed locally to one MP4.

<p align="center">
  <a href="https://chromewebstore.google.com/detail/savemedia/negbodmpgjhkacmdkbfdpocjanaklifn"><img alt="Get savemedia for Chrome" src="https://img.shields.io/badge/Chrome-Add%20to%20Chrome-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white"></a>
  &nbsp;
  <a href="https://addons.mozilla.org/en-US/firefox/addon/save-media/"><img alt="Get savemedia for Firefox" src="https://img.shields.io/badge/Firefox-Get%20the%20Add--on-FF7139?style=for-the-badge&logo=firefoxbrowser&logoColor=white"></a>
  &nbsp;
  <img alt="Edge Add-ons — coming soon" src="https://img.shields.io/badge/Edge-coming%20soon-6E6E6E?style=for-the-badge&logo=microsoftedge&logoColor=white">
</p>

> **Verified files only.** savemedia is not a DRM bypass tool. It refuses DRM, encrypted or live HLS, DASH, and URL-only guesses rather than saving a broken file. Use it only for media you have the right to save.

Full support contract: [`docs/design.md`](docs/design.md) · Privacy policy: [`docs/privacy-policy.md`](docs/privacy-policy.md) · Engineering boundary rules: [`docs/boundary-rules.md`](docs/boundary-rules.md)

## Optional local downloader

For pages the in-browser engine cannot save (DASH, browser memory limits, unusual containers), savemedia can hand the page address to yt-dlp and ffmpeg that you install yourself. It is off by default, asks for the `nativeMessaging` permission only when you switch it on, and refuses protected media exactly like the browser engine does. Setup and the wire protocol are in [`packages/native-host/README.md`](packages/native-host/README.md).

## License

[Apache-2.0](LICENSE)
