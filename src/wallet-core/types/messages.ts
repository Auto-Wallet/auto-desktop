// Wire message vocabulary for provider/backend transports.

export const MSG_SOURCE = 'auto-wallet' as const;

export interface BaseMessage {
  source: typeof MSG_SOURCE;
  id: string;
  type: string;
}

export interface RpcRequest extends BaseMessage {
  type: 'rpc_request';
  method: string;
  params?: unknown[];
  origin: string;
}

export interface RpcResponse extends BaseMessage {
  type: 'rpc_response';
  requestId: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface EventMessage extends BaseMessage {
  type: 'event';
  eventName: string;
  payload: unknown;
}

export type Message = RpcRequest | RpcResponse | EventMessage;

/**
 * Generate a unique request id. `crypto.randomUUID` is only available in secure
 * contexts (HTTPS / localhost); the provider runs in the page's MAIN world, so on
 * a dApp served over plain http://<LAN-IP> it throws. Fall back to a manual UUID
 * v4 built from `crypto.getRandomValues`, which IS available in insecure contexts.
 */
export function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') +
    '-' +
    hex.slice(4, 6).join('') +
    '-' +
    hex.slice(6, 8).join('') +
    '-' +
    hex.slice(8, 10).join('') +
    '-' +
    hex.slice(10, 16).join('')
  );
}
