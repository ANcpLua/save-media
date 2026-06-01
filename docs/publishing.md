# Publishing savemedia to Chrome Web Store and Edge Add-ons

Firefox/AMO is already live. This runbook covers the **first** Chrome and Edge
submissions and every later release. Read the API reality first — it determines
who clicks what.

## API reality (why the first release is mostly manual)

| Store | Create new listing | Upload new version | Publish |
| --- | --- | --- | --- |
| Chrome Web Store | `items.insert` uploads the package and returns an item id, **but** the item cannot be published until Store listing + Privacy tabs are filled once in the dashboard. | `items.update` (API) | `items.publish` (API) — only after listing/privacy complete. |
| Edge Add-ons | **No API.** Must use Partner Center (Create new extension). | `submissions/draft/package` (API) — only after the listing exists and Publish API is enabled. | `submissions` (API). |

Net: for the **first** release, do listing setup by hand in both dashboards.
From the **second** release onward, both stores are fully scriptable with
`pnpm --filter @savemedia/extension publish:chrome` / `publish:edge`.

## Artifacts to submit (v0.0.4)

- Chrome: `packages/extension/savemedia-chrome-0.0.4.zip`
- Edge:   `packages/extension/savemedia-edge-0.0.4.zip` (byte-identical to Chrome — Edge ships the Chromium build verbatim)
- Store logo: `packages/extension/store-assets/store-logo-300.png` (300×300, 1:1)
- Screenshots: `packages/extension/store-assets/screenshots/01-direct-video.png`, `02-hls-vod.png`, `03-refusal-safety.png` (real popup render, regenerate with `pnpm --filter @savemedia/extension screenshots`)
- Optional promo tile: `packages/extension/store-assets/promo-440x280.png`
- Privacy policy: `docs/privacy-policy.md` (host at a public URL; both stores require a link)

Validated for this commit: well-formed MV3, version 0.0.4, permissions limited to
`downloads`, `tabs`, `offscreen`, `webRequest` + `host_permissions: <all_urls>`,
`LICENSE`/`NOTICE` bundled, no `.pem`/secrets in the package.

Listing copy, permission justifications, and the privacy summary are drafted in
[`docs/store-submission.md`](./store-submission.md) — copy them into the forms.

---

## Chrome Web Store — first submission

1. **Developer account.** Register at
   https://chrome.google.com/webstore/devconsole (one-time US$5 fee).
2. **Create item.** New item → upload `savemedia-chrome-0.0.4.zip`.
   (Or script it: `pnpm --filter @savemedia/extension publish:chrome insert`,
   then note the returned item id.)
3. **Store listing tab.** Name `savemedia`, short + long description and category
   from `docs/store-submission.md`, upload the three screenshots, set an icon.
4. **Privacy tab.** Single purpose statement; justify each permission (table in
   `store-submission.md`); declare **no** remote code; certify data-use:
   no collection, no sale, no telemetry; paste the privacy-policy URL.
5. **Submit for review.** Save draft → Submit for review.

After this first publish, capture the item id for CI: `CWS_ITEM_ID`.

## Edge Add-ons — first submission

1. **Developer account.** Register at
   https://partner.microsoft.com/dashboard/microsoftedge (free).
2. **Create new extension** → upload `savemedia-edge-0.0.4.zip`.
3. **Availability / Properties / Privacy / Listing.** Fill from
   `store-submission.md` — same copy, screenshots, permission justifications,
   privacy policy URL. Declare no data collection and no remote code.
4. **Submit** with certification notes (reviewer build steps are in
   `store-submission.md`).
5. After it passes, capture the **product GUID** → `EDGE_PRODUCT_ID`.

---

## Later releases (fully scripted)

Bump the version, rebuild, then push.

```sh
# rebuild release zips for the new version
pnpm --filter @savemedia/extension zip

# Chrome: upload new version + publish in one step
CWS_CLIENT_ID=... CWS_CLIENT_SECRET=... CWS_REFRESH_TOKEN=... CWS_ITEM_ID=... \
  pnpm --filter @savemedia/extension publish:chrome release

# Edge: upload new version + publish in one step
EDGE_PRODUCT_ID=... EDGE_API_KEY=... EDGE_CLIENT_ID=... \
  pnpm --filter @savemedia/extension publish:edge release
```

Sub-commands if you want to stage them: `insert` / `update` / `publish` /
`release` (Chrome); `update` / `publish` / `release` (Edge).

## Getting API credentials

**Chrome (OAuth, for `publish:chrome`):**
1. Google Cloud console → create project → enable the *Chrome Web Store API*.
2. Create an OAuth client (type: Desktop). Note client id + secret.
3. Run the one-time OAuth consent flow with scope
   `https://www.googleapis.com/auth/chromewebstore` to obtain a **refresh token**.
4. Export `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`, `CWS_ITEM_ID`.
   Reference: https://developer.chrome.com/docs/webstore/using-api

**Edge (API key, for `publish:edge`):**
1. Partner Center → Microsoft Edge program → **Publish API** → Enable.
2. **Create API credentials** → copy the **Client ID** and **API key**
   (key expires — rotate before expiry).
3. Export `EDGE_PRODUCT_ID` (the product GUID), `EDGE_API_KEY`, `EDGE_CLIENT_ID`.
   Reference: https://learn.microsoft.com/microsoft-edge/extensions/update/api/using-addons-api

## Secrets handling

Never commit credentials. Keep them in your shell env locally and in GitHub
Actions secrets for CI. The old committed Chrome `.pem` is treated as exposed and
must not be reused for store identity (see `store-submission.md`).
