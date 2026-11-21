const EXPIRING_PARAMETER = /^(token|sig|signature|exp|ex|expires?|expiry|expiration|x-amz-signature|x-amz-date|x-amz-expires|x-goog-signature|x-goog-date|x-goog-expires)$/i;

export function renewableResource(url: string): string | null {
  const parsed = new URL(url);
  parsed.hash = "";
  const renewalKeys = [...parsed.searchParams.keys()].filter(key => EXPIRING_PARAMETER.test(key));
  if (!renewalKeys.length) return null;
  for (const key of renewalKeys) parsed.searchParams.delete(key);
  // Preserve the pathname and every unrelated parameter, including file IDs.
  return parsed.href;
}

export function stableAddress(value: string): string {
  try {
    const url = new URL(renewableResource(value) ?? value);
    url.hash = "";
    url.searchParams.sort();
    return url.href;
  } catch { return value; }
}
