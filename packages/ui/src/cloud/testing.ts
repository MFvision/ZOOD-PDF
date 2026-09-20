import type { CloudRequest, CloudResponse, Transport } from './http';
import type { AccessToken, TokenBroker } from './oauth';

/** For the cloud tests: answers and what was asked. */

export function reply(status: number, body: unknown = '', headers: Record<string, string> = {}): CloudResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const bytes = body instanceof ArrayBuffer ? body : (new TextEncoder().encode(text).buffer as ArrayBuffer);
  return { status, headers, body: bytes };
}

export interface Recorded extends CloudRequest {
  provider: string;
}

/** A transport that answers with `handle` and keeps each request. */
export function recording(handle: (request: CloudRequest, seen: Recorded[]) => CloudResponse | Promise<CloudResponse>): {
  transport: Transport;
  seen: Recorded[];
} {
  const seen: Recorded[] = [];
  return {
    seen,
    transport: async (provider, request) => {
      seen.push({ ...request, provider });
      return handle(request, seen);
    },
  };
}

/** A broker that hands out `token-1`, `token-2`… on each refresh. */
export function countingBroker(): TokenBroker & { refreshes: number } {
  const broker = {
    refreshes: 0,
    redeem: async (): Promise<AccessToken> => ({ token: 'token-0', expiresAt: Date.now() + 3_600_000 }),
    refresh: async (): Promise<AccessToken> => {
      broker.refreshes += 1;
      return { token: `token-${broker.refreshes}`, expiresAt: Date.now() + 3_600_000 };
    },
    forget: async () => false,
    kept: async () => true,
  };
  return broker;
}

export function bytesOf(length: number, fill = 0x25): ArrayBuffer {
  return new Uint8Array(length).fill(fill).buffer;
}
