declare const __RELAY_URL__: string;
export const relayUrl = typeof __RELAY_URL__ === "string" ? __RELAY_URL__ : "";
export const relayHost = relayUrl ? new URL(relayUrl).host : "";
