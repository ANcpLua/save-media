#!/usr/bin/env node
/**
 * Publish a savemedia build to Microsoft Edge Add-ons via the Update REST API v1.1.
 *
 * IMPORTANT: This API only UPDATES an existing product. The first-ever
 * submission must be done by hand in Partner Center (Create new extension →
 * upload zip → fill listing/privacy → submit). After that first publish you can
 * enable the Publish API in Partner Center and use this script for every later
 * release.
 *
 * Credentials (env, never commit these):
 *   EDGE_PRODUCT_ID   Product GUID from Partner Center
 *   EDGE_API_KEY      API key   (Partner Center → Publish API)
 *   EDGE_CLIENT_ID    Client id (Partner Center → Publish API)
 *
 * Usage:
 *   node scripts/publish-edge.mjs update  [--zip PATH]
 *   node scripts/publish-edge.mjs publish [--notes "text"]
 *   node scripts/publish-edge.mjs release [--zip PATH] [--notes "text"]
 *       (release = upload package, wait, then publish)
 *
 * Docs: https://learn.microsoft.com/microsoft-edge/extensions/update/api/using-addons-api
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_ROOT = "https://api.addons.microsoftedge.microsoft.com";
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

main().catch((err) => {
  console.error(`\n✘ ${err.message}`);
  process.exit(1);
});

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || flags.help) return usage();

  const productId = required("EDGE_PRODUCT_ID");
  const headers = {
    Authorization: `ApiKey ${required("EDGE_API_KEY")}`,
    "X-ClientID": required("EDGE_CLIENT_ID"),
  };
  const base = `${API_ROOT}/v1/products/${productId}`;
  const zipPath = resolve(root, flags.zip ?? defaultZip());
  const notes = flags.notes ?? "Automated release via Edge Add-ons API.";

  switch (command) {
    case "update":
      await uploadPackage(base, headers, zipPath);
      break;
    case "publish":
      await publishSubmission(base, headers, notes);
      break;
    case "release":
      await uploadPackage(base, headers, zipPath);
      await publishSubmission(base, headers, notes);
      break;
    default:
      return usage(`unknown command: ${command}`);
  }
}

async function uploadPackage(base, headers, zipPath) {
  if (!existsSync(zipPath)) throw new Error(`zip not found: ${zipPath}`);
  const bytes = readFileSync(zipPath);
  const res = await fetch(`${base}/submissions/draft/package`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/zip" },
    body: bytes,
  });
  if (res.status !== 202) {
    throw new Error(`package upload failed (${res.status}): ${await res.text()}`);
  }
  const operationId = res.headers.get("Location");
  console.log(`→ package upload accepted (operation ${operationId})`);
  await poll(`${base}/submissions/draft/package/operations/${operationId}`, headers, "upload");
  console.log("✓ package uploaded and validated");
}

async function publishSubmission(base, headers, notes) {
  const res = await fetch(`${base}/submissions`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ notes }),
  });
  if (res.status !== 202) {
    throw new Error(`publish failed (${res.status}): ${await res.text()}`);
  }
  const operationId = res.headers.get("Location");
  console.log(`→ publish accepted (operation ${operationId})`);
  await poll(`${base}/submissions/operations/${operationId}`, headers, "publish");
  console.log("✓ submission sent for certification");
}

async function poll(url, headers, label) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const res = await fetch(url, { headers });
    const json = await res.json().catch(() => ({}));
    const status = json.status ?? "Unknown";
    if (status === "Succeeded") return json;
    if (status === "Failed") {
      const errs = (json.errors ?? []).map((e) => e.message ?? JSON.stringify(e)).join("; ");
      throw new Error(`${label} failed: ${errs || json.message || "unknown error"}`);
    }
    if (Date.now() > deadline) throw new Error(`${label} timed out while ${status}`);
    process.stdout.write(`  ${label}: ${status}…\r`);
    await sleep(POLL_INTERVAL_MS);
  }
}

function defaultZip() {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  return `savemedia-edge-${pkg.version}.zip`;
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  console.log(`Edge Add-ons publisher (updates only — first listing is manual in Partner Center)

  node scripts/publish-edge.mjs update  [--zip PATH]
  node scripts/publish-edge.mjs publish [--notes "text"]
  node scripts/publish-edge.mjs release [--zip PATH] [--notes "text"]

Env: EDGE_PRODUCT_ID EDGE_API_KEY EDGE_CLIENT_ID`);
  process.exit(msg ? 1 : 0);
}
