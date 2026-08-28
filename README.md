# Save Media v1.1.0 (native-host variant)

Archived snapshot of the earlier Save Media architecture. The extension itself is a
thin trigger: Alt+S / Ctrl+S on a hovered `<img>` or `<video>` element. Plain media
URLs go through `chrome.downloads`; MSE/HLS players (blob: sources) send the page URL
to a Native Messaging host that delegates to yt-dlp and ffmpeg.

Layout:

- `manifest.json`, `content.js`, `background.js`, `popup.*` - extension (MV3)
- `native-host/host.py` - stdio native messaging host, runs yt-dlp
- `native-host/install.sh` - registers the host for Microsoft Edge

Requirements: `yt-dlp` and `ffmpeg` at `/opt/homebrew/bin`. The host uses the
browser's cookie store so downloads run under the current session. Widevine DRM
content is detected and refused.

This variant depends on `nativeMessaging` and a locally installed host, so it is not
store-distributable. The `main` branch is the self-contained rewrite.
