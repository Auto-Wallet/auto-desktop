// Which tab webviews have finished loading once, so switching back to a tab
// does not replay the loading animation over a page that is already there.
//
// Closing a tab destroys its webview (Rust `close_dapp`), so its entry must go
// with it — otherwise the next open reloads the page from scratch with the
// animation suppressed, and the user stares at a blank rectangle.

const loaded = new Set<string>();

export function markDappLoaded(label: string) {
  loaded.add(label);
}

export function hasDappLoaded(label: string): boolean {
  return loaded.has(label);
}

export function forgetDappLoad(label: string) {
  loaded.delete(label);
}
