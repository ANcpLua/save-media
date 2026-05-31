#!/usr/bin/env node
/**
 * Publish a savemedia build to the Chrome Web Store via the Web Store API v1.1.
 *
 * Capabilities:
 *   - insert  : create a brand-new draft item from a zip (first upload only).
 *               The API uploads the package and returns the new item id, but the
 *               item still cannot be PUBLISHED until the Store listing + Privacy
 *               tabs are completed once in the developer dashboard.
 *   - update  : upload a new version of an existing item (every release after the
 *               first). This is the normal CI path.
 *   - publish : move the current draft to review/published.
 *
 * Credentials (env, never commit these):
 *   CWS_CLIENT_ID       OAuth client id      (Google Cloud console)
 *   CWS_CLIENT_SECRET   OAuth client secret
 *   CWS_REFRESH_TOKEN   OAuth refresh token  (scope: chromewebstore)
 *   CWS_ITEM_ID         Existing item id     (required for update/publish)
 *
 * Usage:
 *   node scripts/publish-chrome.mjs insert  [--zip path]
 *   node scripts/publish-chrome.mjs update  [--zip path] [--item ID]
 *   node scripts/publish-chrome.mjs publish [--item ID] [--target default|trustedTesters]
 *   node scripts/publish-chrome.mjs release [--zip path] [--item ID] [--target default]
 *       (release = update then publish)
 *
 * Docs: https://developer.chrome.com/docs/webstore/using-api
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_BASE = "https://www.googleapis.com/upload/chromewebstore/v1.1/items";
const API_BASE = "https://www.googleapis.com/chromewebstore/v1.1/items";

main().catch((err) => {
  console.error(`\n✘ ${err.message}`);
  process.exit(1);
});

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || flags.help) return usage();

  const zipPath = resolve(root, flags.zip ?? defaultZip());
  const itemId = flags.item ?? process.env.CWS_ITEM_ID;
  const target = flags.target ?? "default";

  const token = await accessToken();

  switch (command) {
    case "insert": {
      const item = await uploadPackage(token, zipPath, null);
      console.log(`✓ inserted new item: ${item.id}`);
      console.log("  Next: open the dashboard, complete Store listing + Privacy,");
      console.log("  then run: publish --item " + item.id);
      break;
    }
    case "update": {
      requireItem(itemId);
      const item = await uploadPackage(token, zipPath, itemId);
      console.log(`✓ uploaded new version to ${itemId} (state: ${item.uploadState})`);
      break;
    }
    case "publish": {
      requireItem(itemId);
      await publishItem(token, itemId, target);
      console.log(`✓ publish requested for ${itemId} (target: ${target})`);
      break;
    }
    case "release": {
      requireItem(itemId);
      const item = await uploadPackage(token, zipPath, itemId);
      console.log(`✓ uploaded new version (state: ${item.uploadState})`);
      await publishItem(token, itemId, target);
      console.log(`✓ publish requested for ${itemId} (target: ${target})`);
      break;
    }
    default:
      return usage(`unknown command: ${command}`);
  }
}

async function accessToken() {
  const client_id = required("CWS_CLIENT_ID");
  const client_secret = required("CWS_CLIENT_SECRET");
  const refresh_token = required("CWS_REFRESH_TOKEN");
  const body = new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: "refresh_token" });
  const res = await fetch(TOKEN_URL, { method: "POST", body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`token refresh failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

async function uploadPackage(token, zipPath, itemId) {
  if (!existsSync(zipPath)) throw new Error(`zip not found: ${zipPath}`);
  const bytes = readFileSync(zipPath);
  const url = itemId ? `${UPLOAD_BASE}/${itemId}` : UPLOAD_BASE;
  const method = itemId ? "PUT" : "POST";
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "x-goog-api-version": "2" },
    body: bytes,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`upload failed (${res.status}): ${JSON.stringify(json)}`);
  if (json.uploadState === "FAILURE") {
    const detail = (json.itemError ?? []).map((e) => e.error_detail).join("; ");
    throw new Error(`upload rejected: ${detail || JSON.stringify(json)}`);
  }
  return json;
}

async function publishItem(token, itemId, target) {
  const res = await fetch(`${API_BASE}/${itemId}/publish`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-goog-api-version": "2",
      "Content-Length": "0",
    },
    body: JSON.stringify({ target }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`publish failed (${res.status}): ${JSON.stringify(json)}`);
  const status = (json.status ?? []).join(", ");
  const detail = (json.statusDetail ?? []).join("; ");
  if (status && !status.includes("OK")) {
    console.warn(`  status: ${status}${detail ? ` — ${detail}` : ""}`);
  }
  return json;
}

function defaultZip() {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  return `savemedia-chrome-${pkg.version}.zip`;
}

function requireItem(itemId) {
  if (!itemId) throw new Error("missing item id: pass --item ID or set CWS_ITEM_ID");
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

function parseArgs(argv) {
  const flags = {};
  let command;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
    } else if (!command) command = a;
  }
  return { command, flags };
}

function usage(msg) {
  if (msg) console.error(`✘ ${msg}\n`);
  console.log(`Chrome Web Store publisher

  node scripts/publish-chrome.mjs insert  [--zip PATH]
  node scripts/publish-chrome.mjs update  [--zip PATH] [--item ID]
  node scripts/publish-chrome.mjs publish [--item ID] [--target default|trustedTesters]
  node scripts/publish-chrome.mjs release [--zip PATH] [--item ID] [--target default]

Env: CWS_CLIENT_ID CWS_CLIENT_SECRET CWS_REFRESH_TOKEN CWS_ITEM_ID`);
  process.exit(msg ? 1 : 0);
}
