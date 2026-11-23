// Which part of the address space an IP address is in, and whether a host
// name is a public one. Pure: nothing here resolves a name or makes a request.

export type AddressScope =
  | "unspecified" | "loopback" | "private" | "link-local" | "unique-local" | "discard"
  | "shared" | "benchmarking" | "documentation" | "multicast" | "reserved" | "public";

/** How a scope is named under Technical details. */
export const SCOPE_LABEL: Readonly<Record<AddressScope, string>> = {
  "unspecified": "no address",
  "loopback": "this computer",
  "private": "local network",
  "unique-local": "local network",
  "link-local": "local link",
  "discard": "discard range",
  "shared": "provider network",
  "benchmarking": "reserved test range",
  "documentation": "documentation range",
  "multicast": "multicast range",
  "reserved": "reserved range",
  "public": "internet",
};

/**
 * The scopes a public server never has. A public name that the browser
 * reached at one of these was pointed there by the user's network.
 * "shared" (carrier-grade NAT and overlay networks) and "benchmarking" (the
 * made-up addresses of local proxies) stay out: behind those sits the real
 * server, and its failure is its own.
 */
const LOCAL_SCOPES: ReadonlySet<AddressScope> = new Set<AddressScope>(
  ["unspecified", "loopback", "private", "link-local", "unique-local", "discard"]);

export function isLocalScope(scope: AddressScope | null): boolean {
  return scope !== null && LOCAL_SCOPES.has(scope);
}

function strip(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  // A zone index names an interface, not another address.
  const zone = value.indexOf("%");
  return zone < 0 ? value : value.slice(0, zone);
}

function parseIpv4(text: string): readonly number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(part => part <= 255) ? parts : null;
}

function ipv4Scope([a, b, c]: readonly number[]): AddressScope {
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 169 && b === 254) return "link-local";
  if (a === 100 && b! >= 64 && b! <= 127) return "shared";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking";
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return "documentation";
  if (a! >= 224 && a! <= 239) return "multicast";
  if (a! >= 240 || (a === 192 && b === 0 && c === 0)) return "reserved";
  return "public";
}

/** The eight 16-bit groups of an IPv6 address, or null when the text is not one. */
function parseIpv6(text: string): readonly number[] | null {
  if (!text.includes(":") || !/^[0-9a-f:.]+$/.test(text)) return null;
  let value = text;
  if (value.includes(".")) {
    // An embedded IPv4 address fills the last two groups.
    const at = value.lastIndexOf(":");
    const v4 = parseIpv4(value.slice(at + 1));
    if (!v4) return null;
    value = `${value.slice(0, at + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const values = part.split(":").map(group => /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN);
    return values.some(Number.isNaN) ? null : values;
  };
  const left = groups(halves[0]!);
  const right = halves.length === 2 ? groups(halves[1]!) : [];
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const known = left.length + right.length;
  if (known > 7) return null;
  return [...left, ...new Array<number>(8 - known).fill(0), ...right];
}

function ipv6Scope(groups: readonly number[]): AddressScope {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  const leadingZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (leadingZero && g5 === 0 && g6 === 0) {
    if (g7 === 0) return "unspecified";
    if (g7 === 1) return "loopback";
  }
  // An IPv4 address written as IPv6 is that IPv4 address.
  if (leadingZero && g5 === 0xffff) return ipv4Scope([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]);
  if ((g0 & 0xfe00) === 0xfc00) return "unique-local";
  if ((g0 & 0xffc0) === 0xfe80) return "link-local";
  // The site-local range of early IPv6 (fec0::/10) was a local network range too.
  if ((g0 & 0xffc0) === 0xfec0) return "unique-local";
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return "discard";
  if (g0 === 0x2001 && g1 === 0x0db8) return "documentation";
  if ((g0 & 0xff00) === 0xff00) return "multicast";
  return "public";
}

/** The scope of an IP address (IPv6 with or without brackets), or null when the text is not an IP address. */
export function addressScope(ip: string | null | undefined): AddressScope | null {
  const text = strip(ip ?? "");
  if (!text) return null;
  const v4 = parseIpv4(text);
  if (v4) return ipv4Scope(v4);
  const v6 = parseIpv6(text);
  return v6 ? ipv6Scope(v6) : null;
}

/**
 * The names that lead only to this computer or into the user's own network,
 * never to a server on the internet: this computer's own name, the names of
 * local discovery, the home-network and private-use names, and (see
 * isLocalHostName) every name of one label, which only a local resolver
 * answers. This is the one list of them: the local-network rule and the
 * network-block explanation both read it.
 */
const LOCAL_ONLY = ["localhost", "local", "home.arpa", "internal"];

/**
 * The other names that never stand for a server on the public internet: the
 * rest of the special-use names IANA registers. They are not public, and
 * they say nothing about the user's network either. No list of public
 * suffixes is needed for this.
 */
const SPECIAL_USE = ["test", "invalid", "example", "onion", "alt", "arpa", "example.com", "example.net", "example.org"];

/** The name without a port and without the dot of a fully qualified name, or null for an IP address or no name at all. */
function bareName(host: string | null | undefined): string | null {
  let name = (host ?? "").trim().toLowerCase();
  if (!name) return null;
  if (name.startsWith("[")) return null;
  // An IPv6 literal without brackets has more than one colon; one colon is a port.
  if (name.split(":").length > 2) return null;
  name = name.replace(/:\d+$/, "");
  if (name.endsWith(".")) name = name.slice(0, -1);
  if (!name || addressScope(name) !== null) return null;
  return /^[a-z0-9._-]+$/.test(name) ? name : null;
}

const under = (name: string, suffixes: readonly string[]): boolean =>
  suffixes.some(suffix => name === suffix || name.endsWith(`.${suffix}`));

/**
 * A host name (a port is ignored) that only resolves on this computer or
 * inside the user's network: a name of one label ("nas"), or one under
 * localhost, local, home.arpa or internal. An IP address is not a name:
 * addressScope reads those.
 */
export function isLocalHostName(host: string | null | undefined): boolean {
  const name = bareName(host);
  return name !== null && (!name.includes(".") || under(name, LOCAL_ONLY));
}

/** A host name (a port is ignored) that is expected to resolve to a public server. */
export function isPublicHostName(host: string | null | undefined): boolean {
  const name = bareName(host);
  if (name === null || name.includes("_") || isLocalHostName(name)) return false;
  return !under(name, SPECIAL_USE);
}
