import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// When the user's network blocks a server, savemedia explains it and stops.
// It never reaches the server another way: no name lookups of its own, no
// proxy switched off, no certificate check skipped. This test reads the
// source of every package and fails on the mechanisms that would do so.

const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap(name => {
    if (name === "node_modules" || name === "__pycache__" || name.startsWith("dist")) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path, pattern) : pattern.test(name) ? [path] : [];
  });
}

const sources = [
  ...files(join(PACKAGES, "core/src"), /\.tsx?$/),
  ...files(join(PACKAGES, "extension/src"), /\.tsx?$/),
  ...files(join(PACKAGES, "native-host"), /\.(?:py|sh)$/).filter(path => !/test_/.test(path)),
].map(path => ({ name: relative(PACKAGES, path), text: readFileSync(path, "utf8") }));

const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ["DNS over HTTPS requests of its own", /dns-query|application\/dns-(?:message|json)|cloudflare-dns|dns\.google|dns\.quad9|doh\b/i],
  ["a resolver address built in", /\b(?:1\.1\.1\.1|1\.0\.0\.1|8\.8\.8\.8|8\.8\.4\.4|9\.9\.9\.9)\b/],
  ["a proxy switched off or replaced", /--noproxy|--no-proxy|--proxy[ =]|NO_PROXY|ProxyHandler\s*\(\s*\{\s*\}\s*\)|chrome\.proxy|trust_env\s*=\s*False/],
  ["a certificate check skipped", /ignore-certificate|--no-check-certificates?|nocheckcertificate|--insecure\b|CERT_NONE|verify\s*=\s*False|_create_unverified_context|rejectUnauthorized\s*:\s*false/i],
  ["a browser setting changed", /chrome\.privacy|chrome\.dns|chrome\.webRequest\.handlerBehaviorChanged|secureDnsMode|chrome\.settingsPrivate/],
  ["a request rewritten on its way (the blocking form of request events)", /["'`]blocking["'`]|["'`]asyncBlocking["'`]|webRequestBlocking/],
  ["another address tried for the same server", /--force-ipv[46]|--source-address|--geo-bypass|geo_bypass|--geo-verification-proxy|--xff\b/],
];

describe("a blocked server is explained, never reached another way", () => {
  it("reads the source of all three packages", () => {
    expect(sources.length).toBeGreaterThan(150);
    for (const name of ["core/src/errors/network-block.ts", "extension/src/background/request-outcomes.ts", "native-host/host.py"]) {
      expect(sources.map(source => source.name)).toContain(name);
    }
  });

  it.each(FORBIDDEN)("has no %s", (_what, pattern) => {
    const hits = sources.flatMap(source => source.text.split("\n").flatMap((line, index) =>
      pattern.test(line) ? [`${source.name}:${index + 1}: ${line.trim().slice(0, 140)}`] : []));
    expect(hits).toEqual([]);
  });

  it("the module that explains a block and the one that observes requests import nothing that could make a request", () => {
    const block = sources.find(source => source.name === "core/src/errors/network-block.ts")!.text;
    const observer = sources.find(source => source.name === "extension/src/background/request-outcomes.ts")!.text;
    for (const text of [block, observer]) {
      expect(text).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|chrome\.(?!webRequest)\w+\.\w+\(/);
    }
    // The observer registers listeners and nothing else on the request API.
    expect(observer.match(/events\.\w+\??\.addListener/g)?.length).toBe(5);
    expect(observer).not.toMatch(/extraInfoSpec|\["blocking"\]|redirectUrl\s*:|cancel\s*:\s*true/);
  });
});
