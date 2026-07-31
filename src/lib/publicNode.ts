// PublicNode gates its RPC endpoints behind an API key, supplied as the last path
// segment (`https://ethereum-rpc.publicnode.com/<key>`).
//
// The key is never stored in a chain config: BUILTIN_CHAINS, tokenData.ts and the
// backend's chains.json all keep the bare host, and Settings renders that host —
// the key is appended at the request site instead, so it can't leak into a config
// file or the UI. The Rust side does the same in `apply_public_node_key`; keep the
// two in step.
//
// `__PUBLIC_NODE_KEY__` is injected by vite only under `vite dev` (see
// vite.config.ts): in the packaged app every read goes through the Rust `node_rpc`
// command, so this module's only caller is the browser-preview fetch fallback in
// rpc.ts. Production bundles therefore ship an empty string and this is a no-op.

/** Pure form — the key is a parameter so the URL rules are testable outside vite. */
export function applyPublicNodeKey(url: string, key: string): string {
  if (!key) return url;

  const rest = url.replace(/^https?:\/\//, "");
  if (rest === url) return url; // not an http(s) URL

  // Match on the host alone, so a path like `https://evil.example/publicnode.com`
  // can't attract the key.
  const cut = rest.search(/[/?#]/);
  const host = cut < 0 ? rest : rest.slice(0, cut);
  const path = cut < 0 ? "" : rest.slice(cut);
  if (host !== "publicnode.com" && !host.endsWith(".publicnode.com")) return url;

  // Already carries a path (someone pasted their own keyed endpoint) — leave it.
  if (path !== "" && path !== "/") return url;

  return `${url.replace(/\/+$/, "")}/${key}`;
}

export function withPublicNodeKey(url: string): string {
  // The `typeof` guard is for `bun test`, which imports this module without vite's
  // compile-time define in place.
  const key = typeof __PUBLIC_NODE_KEY__ === "string" ? __PUBLIC_NODE_KEY__ : "";
  return applyPublicNodeKey(url, key);
}
