import { createNativeBridge, type ConnectNative, type NativeBridge } from "./bridge";
import type { HostCapability } from "./types";

export interface NativeStatus {
  readonly available: boolean;
  readonly version?: string;
  readonly host?: string;
  readonly capabilities?: readonly HostCapability[];
  readonly lastError?: string;
  readonly checkedAt: number;
}

let cached: NativeStatus | null = null;

/** Returns the most recent ping result, or null if probe hasn't run yet. */
export function lastKnownStatus(): NativeStatus | null {
  return cached;
}

export async function probeNativeHost(connect?: ConnectNative): Promise<NativeStatus> {
  const bridge: NativeBridge = createNativeBridge(connect);
  try {
    const response = await bridge.request({ type: "ping", version: "extension" });
    if (response.type !== "pong") {
      throw new Error(`unexpected response: ${response.type}`);
    }
    cached = {
      available: true,
      version: response.version,
      host: response.host,
      capabilities: response.capabilities,
      checkedAt: Date.now(),
    };
    return cached;
  } catch (err) {
    cached = {
      available: false,
      lastError: err instanceof Error ? err.message : String(err),
      checkedAt: Date.now(),
    };
    return cached;
  } finally {
    bridge.disconnect();
  }
}
