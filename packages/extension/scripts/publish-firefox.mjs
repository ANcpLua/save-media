#!/usr/bin/env node
/**
 * Publish a savemedia build to Firefox Add-ons (AMO) via the addons.mozilla.org API v5.
 *
 * The add-on must already exist on AMO (first submission by hand or via `web-ext sign`).
 * After that, this script uploads a new version zip, waits for validation, and creates
 * the version on the listed channel. AMO review then happens server-side; the previous
 * version stays live until the new one is approved.
 *
 * Credentials (env, never commit these):
 *   AMO_JWT_ISSUER   API key   (addons.mozilla.org/developers/addon/api/key/ — "JWT issuer", user:xxxxx:xxx)
 *   AMO_JWT_SECRET   API secret (same page — "JWT secret")
 *
 * Usage:
 *   node scripts/publish-firefox.mjs upload  [--zip PATH] [--channel listed|unlisted]
 *   node scripts/publish-firefox.mjs release [--zip PATH] [--channel listed] [--notes "text"] [--source PATH]
 *       (release = upload zip, wait for validation, create the version; --source
 *        attaches a source-code zip, required by AMO for minified/bundled builds)
 *   node scripts/publish-firefox.mjs status
 *       (show current versions of the add-on)
 *
 * Docs: https://mozilla.github.io/addons-server/topics/api/addons.html
 */
import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_ROOT = "https://addons.mozilla.org/api/v5";
const ADDON_ID = "savemedia@ancplua.dev";
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

main().catch((err) => {
  console.error(`\n✘ ${err.message}`);
  process.exit(1);
});

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || flags.help) return usage();

  const zipPath = resolve(root, flags.zip ?? defaultZip());
  const channel = flags.channel ?? "listed";

  switch (command) {
    case "upload": {
      const upload = await uploadZip(zipPath, channel);
      console.log(`✓ upload validated (uuid ${upload.uuid})`);
      break;
    }
    case "release": {
      const upload = await uploadZip(zipPath, channel);
      await createVersion(upload.uuid, flags);
      break;
    }
    case "status": {
      const versions = await api(`/addons/addon/${ADDON_ID}/versions/?filter=all_with_unlisted`);
      for (const v of versions.results ?? []) {
        console.log(`  ${v.version}  channel=${v.channel}  status=${v.file?.status ?? "?"}`);
      }
      break;
    }
    default:
      return usage(`unknown command: ${command}`);
  }
}

async function uploadZip(zipPath, channel) {
  if (!existsSync(zipPath)) throw new Error(`zip not found: ${zipPath}`);
  const form = new FormData();
  form.append("upload", new Blob([readFileSync(zipPath)], { type: "application/zip" }), basename(zipPath));
  form.append("channel", channel);
  const created = await api("/addons/upload/", { method: "POST", body: form });
  console.log(`→ upload accepted (uuid ${created.uuid}), waiting for validation…`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const upload = await api(`/addons/upload/${created.uuid}/`);
    if (upload.processed) {
      if (!upload.valid) {
        const msgs = (upload.validation?.messages ?? [])
          .filter((m) => m.type === "error")
          .map((m) => m.message)
          .join("; ");
        throw new Error(`validation failed: ${msgs || "see validation report"}`);
      }
      return upload;
    }
    if (Date.now() > deadline) throw new Error("validation timed out");
    process.stdout.write("  validating…\r");
    await sleep(POLL_INTERVAL_MS);
  }
}

async function createVersion(uploadUuid, flags) {
  const payload = { upload: uploadUuid };
  if (flags.notes) payload.release_notes = { "en-US": flags.notes };
  const version = await api(`/addons/addon/${ADDON_ID}/versions/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  console.log(`✓ version ${version.version} submitted for review (channel ${version.channel})`);
  if (flags.source) {
    const srcPath = resolve(root, flags.source);
    if (!existsSync(srcPath)) throw new Error(`source zip not found: ${srcPath}`);
    const form = new FormData();
    form.append("source", new Blob([readFileSync(srcPath)], { type: "application/zip" }), basename(srcPath));
    await api(`/addons/addon/${ADDON_ID}/versions/${version.id}/`, { method: "PATCH", body: form });
    console.log(`✓ source code attached (${basename(srcPath)})`);
  }
  return version;
}

async function api(path, init = {}) {
  const res = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: { Authorization: `JWT ${jwt()}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/** Minimal HS256 JWT — AMO requires exp ≤ 5 minutes after iat. */
function jwt() {
  const issuer = required("AMO_JWT_ISSUER");
  const secret = required("AMO_JWT_SECRET");
  const now = Math.floor(Date.now() / 1000);
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    iss: issuer,
    jti: randomUUID(),
    iat: now - 5,
    exp: now + 240,
  })}`;
  const sig = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${sig}`;
}

function defaultZip() {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  return `savemedia-firefox-${pkg.version}.zip`;
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
  console.log(`Firefox Add-ons (AMO) publisher — updates an existing listing

  node scripts/publish-firefox.mjs upload  [--zip PATH] [--channel listed|unlisted]
  node scripts/publish-firefox.mjs release [--zip PATH] [--notes "text"] [--source PATH]
  node scripts/publish-firefox.mjs status

Env: AMO_JWT_ISSUER AMO_JWT_SECRET`);
  process.exit(msg ? 1 : 0);
}
