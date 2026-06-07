// Read-only JSON-RPC client for the TRUSTED shell UI.
//
// In the Tauri app, reads go through the Rust `node_rpc` command (server-side
// reqwest). That matters because many public RPCs send NO CORS headers, so a
// browser `fetch` to them would fail — routing through Rust bypasses CORS and
// lets every registered chain's balances load. In the browser dev-preview (no
// Tauri) we fall back to a direct fetch, which only reaches CORS-friendly nodes.
//
// Errors are NOT swallowed: a non-200 response or a JSON-RPC `error` object
// throws, so the calling component can show a real failure instead of a fake
// zero.

import { invoke } from "@tauri-apps/api/core";
import { findChain } from "./chains";
import { isTauri } from "./platform";

let nextId = 1;

export async function rpc<T = unknown>(
  chainId: string,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  if (isTauri()) {
    return invoke<T>("node_rpc", { chainId, method, params });
  }

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
