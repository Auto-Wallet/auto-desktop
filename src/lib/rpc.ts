// Read-only JSON-RPC client for the TRUSTED shell UI.
//
// The shell is our own local React code, so it may talk to public RPC nodes
// directly (unlike the untrusted dApp webview, whose reads are forced through
// the Rust `wallet_request` bridge). Direct fetch works identically in the
// Chrome dev-preview and in WKWebView because tauri.conf.json sets csp: null.
//
// Errors are NOT swallowed: a non-200 response or a JSON-RPC `error` object
// throws, so the calling component can show a real failure instead of a fake
// zero.

import { findChain } from "./chains";

let nextId = 1;

export async function rpc<T = unknown>(
  chainId: string,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const chain = findChain(chainId);
  if (!chain) throw new Error(`rpc: unknown chain ${chainId}`);

  const res = await fetch(chain.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  if (!res.ok) {
    throw new Error(`rpc: ${chain.name} ${method} -> HTTP ${res.status}`);
  }
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) {
    throw new Error(`rpc: ${chain.name} ${method} -> ${body.error.message ?? "node error"}`);
  }
  return body.result as T;
}

/** Native gas-token balance (wei) for `address` on `chainId`. */
export function getBalance(chainId: string, address: string): Promise<string> {
  return rpc<string>(chainId, "eth_getBalance", [address, "latest"]);
}
