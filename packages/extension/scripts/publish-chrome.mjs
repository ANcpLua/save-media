#!/usr/bin/env node
/**
 * Publish a savemedia build to the Chrome Web Store via the Web Store API v2.
 * (v1.1 is deprecated and supported only until 2026-10-15.)
 *
 * The item must already exist in the developer dashboard (first submission,
 * listing, and privacy tabs are manual). After that this script handles every
 * later release. Items publish with their existing visibility settings.
 *
 * Credentials (env, never commit these):
 *   CWS_CLIENT_ID       OAuth client id      (Google Cloud console)
 *   CWS_CLIENT_SECRET   OAuth client secret
 *   CWS_REFRESH_TOKEN   OAuth refresh token  (scope: chromewebstore)
 *   CWS_PUBLISHER_ID    Publisher id         (dashboard → Publisher → Settings)
 *   CWS_ITEM_ID         Extension item id
 *
 * Usage:
 *   node scripts/publish-chrome.mjs update  [--zip path]
 *   node scripts/publish-chrome.mjs publish
 *   node scripts/publish-chrome.mjs status
 *   node scripts/publish-chrome.mjs release [--zip path]
 *       (release = update then publish)
 *
 * Docs: https://developer.chrome.com/docs/webstore/using-api
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_ROOT = "https://chromewebstore.googleapis.com";

main().catch((err) => {
  console.error(`\n✘ ${err.message}`);
  process.exit(1);
});

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || flags.help) return usage();

  const zipPath = resolve(root, flags.zip ?? defaultZip());
  const publisherId = required("CWS_PUBLISHER_ID");
  const itemId = flags.item ?? required("CWS_ITEM_ID");
  const itemBase = `publishers/${publisherId}/items/${itemId}`;
  const token = await accessToken();

  switch (command) {
    case "update":
      await uploadPackage(token, itemBase, zipPath);
      break;
    case "publish":
      await publishItem(token, itemBase);
      break;
    case "status": {
      const status = await api(token, `/v2/${itemBase}:fetchStatus`, { method: "GET" });
      console.log(JSON.stringify(status, null, 2));
      break;
    }
    case "release":
      await uploadPackage(token, itemBase, zipPath);
      await publishItem(token, itemBase);
      break;
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

async function uploadPackage(token, itemBase, zipPath) {
  if (!existsSync(zipPath)) throw new Error(`zip not found: ${zipPath}`);
  const json = await api(token, `/upload/v2/${itemBase}:upload`, {
    method: "POST",
    body: readFileSync(zipPath),
  });
  console.log(`✓ uploaded ${zipPath.split("/").pop()}${json.name ? ` (${json.name})` : ""}`);
  return json;
}

async function publishItem(token, itemBase) {
  const json = await api(token, `/v2/${itemBase}:publish`, { method: "POST" });
  console.log("✓ publish requested (submitted for review with existing visibility)");
  return json;
}

async function api(token, path, init) {
  const res = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.error?.message ?? JSON.stringify(json);
    throw new Error(`${init.method} ${path} failed (${res.status}): ${msg}`);
  }
  return json;
}

function defaultZip() {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  return `savemedia-chrome-${pkg.version}.zip`;
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
  console.log(`Chrome Web Store publisher (API v2)

  node scripts/publish-chrome.mjs update  [--zip PATH] [--item ID]
  node scripts/publish-chrome.mjs publish [--item ID]
  node scripts/publish-chrome.mjs status  [--item ID]
  node scripts/publish-chrome.mjs release [--zip PATH] [--item ID]

Env: CWS_CLIENT_ID CWS_CLIENT_SECRET CWS_REFRESH_TOKEN CWS_PUBLISHER_ID CWS_ITEM_ID`);
  process.exit(msg ? 1 : 0);
}
