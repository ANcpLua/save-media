# Boundary rules

What this project may do under US and EU law, written as rules an engineer
applies before writing code. Applies to the extension, the local downloader
host in `packages/native-host`, and any wrapper around yt-dlp or ffmpeg.

This is an engineering summary, not legal advice. The two hard limits are the
same everywhere: do not circumvent technical protection, and do not build or
market for infringing use.

## The one principle

**Observe, do not defeat.** The tool may capture, parse, and save anything the
browser is already given in the clear to play the video. It may not compute,
extract, or reconstruct anything the site deliberately withholds from the
player's normal operation.

- Manifest, segments, and an AES-128 key fetched over plain HTTP: observed. Allowed.
- Key delivered through a CDM (Widevine, PlayReady, FairPlay): never reached the page. Extracting it is defeating. Never.
- Final URL produced by obfuscated player JavaScript and visible on the network: capturing that request is observed. Re-implementing the obfuscated algorithm so the page is not needed is defeating.

## Rules

Tiers: **G** allowed in any build. **A** allowed only in personal or unlisted
builds, or with conditions. **R** never.

| Id | Rule |
| --- | --- |
| G1 | Progressive files and plain manifests (MP4, WebM, HLS, DASH) without encryption or with AES-128 keys fetched in the clear. Remux and merge with ffmpeg. |
| G2 | Network observation: webRequest, fetch/XHR hooks, MSE capture of what the player already receives, with the same Referer, Origin, and User-Agent the browser sent. |
| G3 | Follow HTTP redirects, meta refresh, and JavaScript redirects the page performs by itself. Forwarding chains are transport, not protection. |
| G4 | Use the user's own session cookies. The tool adds no access. |
| G5 | Delegate to yt-dlp or ffmpeg the user installed. Never bundle or auto-install them. |
| G6 | Read the page's own API responses in the MAIN world. Do not call undocumented endpoints with tokens the page did not issue. |
| G7 | Refuse loudly: detect EME and any non-AES-128 key method and stop with visible feedback. Keep the refusal tests. |
| A1 | Site adapters for platforms whose terms forbid downloading: legal in principle, but store policies are stricter. Keep such adapters in unlisted builds. No platform names in listings or the README. |
| A2 | Solving signature or "n" ciphers in your own code: contested in the US, treated as circumvention by a German court in 2023. Red for EU distribution. |
| A3 | Static deobfuscation of player JavaScript to find a hidden URL: if the URL reaches the network during playback, capture it there instead. |
| A4 | Low-level parsers for unusual containers are fine unless the format's difficulty is itself the protection. Test: could ffmpeg play this from the same inputs? |
| A5 | Nominative use of brand names is legal but triggers automated enforcement. Zero brand names in the extension name, listing, screenshots, or public README. |
| R1 | DRM in any form: no CDM key extraction, no third-party decryptors, no PSSH handling that leads to decryption. |
| R2 | Bypassing authentication, paywalls, or geo restrictions. This reaches computer-misuse law, not only copyright. |
| R3 | Pre-wiring the tool to unlicensed sources. A curated site list or special handling for unlicensed streaming hosts makes the maker liable (CJEU Filmspeler). |
| R4 | Marketing for infringement: no "any site", no site lists, no "bypass" wording, no examples showing protected content. |
| R5 | Hosting or redistributing downloaded content. Saves to the user's disk only. |

## Policy decisions

| Id | Decision |
| --- | --- |
| P1 | A site works hard to make downloading difficult: effort is evidence of an intended protection measure. Difficulty triggers refusal, not escalation. If the media URL is not observable on the network during normal playback, stop. |
| P2 | The site is itself unlicensed, or charges for stolen content: this gives the user no rights. EU law excludes unlawful sources from private copying (ACI Adam) and makes a tool aimed at them the maker's liability (Filmspeler). Do not target such sources. |
| P3 | Mixed-licensing or user-upload hosts as test targets: never in tests, fixtures, CI, screenshots, commits, or docs. Use local fixtures under `tests/`, Creative Commons assets such as the Blender Foundation films, and your own uploads on lawful platforms. |

## Legal basis

United States: 17 U.S.C. 1201(a)(1) and (a)(2)/(b); Sony v. Universal (1984);
MGM v. Grokster (2005); 18 U.S.C. 1030 with Van Buren (2021) and hiQ v.
LinkedIn (2022); the 2020 youtube-dl DMCA notice and its withdrawal; Lanham
Act nominative fair use.

European Union and Austria: Directive 2001/29 Art. 6(1), 6(2), 5(1), 5(2)(b);
CJEU C-355/12 Nintendo v. PC Box; C-435/12 ACI Adam; C-527/15 Stichting Brein
v. Wullems (Filmspeler); LG Hamburg 2023 (youtube-dl hosting); Directive
2013/40; Austria UrhG 42 and 90c, StGB 118a; Directive (EU) 2015/2436 Art. 14.

## How the rules map to the code

| Component | Rules | Status |
| --- | --- | --- |
| `packages/core` HLS parser and dispatch | G1, G7 | Refuses every EXT-X-KEY method except AES-128. |
| `background/network-capture.ts` | G2 | Passive webRequest observation of manifests. |
| `content/sites/*` | G6, A1 | Reads the page's own API responses. Names stay out of public text. |
| `native/local-downloader.ts` | G5, P1 | Delegates page URLs to a user-installed host. `DELEGABLE_ERROR_CODES` is an allowlist that excludes every protected-media code. |
| `packages/native-host` | G4, G5, R1 | Runs the user's yt-dlp with the user's cookies, reports DRM as `drm_protected`, never installs tools. |
| Store listing, README, screenshots | A5, R4 | Protocol names only. |

## Before adding a site or format

- Does the final media URL appear on the network when the page plays normally? If yes, capture it there. If no, stop (P1).
- Is any key delivered through a CDM or a license server? If yes, refuse.
- Would the download work for a logged-out user, or only with the user's own existing session? Either is fine. Credentials the user does not have are out.
- Is the site a licensed platform? If it is a known unlicensed host, do not add an adapter.
- Could ffmpeg or yt-dlp already do this from the same inputs? If yes, delegate rather than reimplement.
- Does the change require a brand name anywhere public? Rename it to the protocol or the pattern.
- Does the commit message, docs, or listing describe it as "bypass", "unlock", or "circumvent"? Rewrite.
