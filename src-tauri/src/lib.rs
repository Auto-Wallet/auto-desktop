use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::webview::WebviewBuilder;
use tauri::window::WindowBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl};

// ---------------------------------------------------------------------------
// Crypto helpers.
// ---------------------------------------------------------------------------
use k256::ecdsa::{SigningKey, VerifyingKey};
use rand_core::OsRng;
use sha3::{Digest, Keccak256};

#[derive(Serialize)]
struct Wallet {
    address: String,
    private_key: String,
    public_key: String,
}

/// EVM address for a public key: "0x" || last 20 bytes of
/// keccak256(uncompressed_pubkey[1..]) (drops the 0x04 prefix byte).
fn address_from_verifying_key(verifying_key: &VerifyingKey) -> String {
    let encoded = verifying_key.to_encoded_point(false);
    let hash = Keccak256::digest(&encoded.as_bytes()[1..]);
    format!("0x{}", hex::encode(&hash[12..]))
}

/// Derive an EVM wallet from a secp256k1 key.
fn derive_wallet(signing_key: &SigningKey) -> Wallet {
    let verifying_key = signing_key.verifying_key();
    let encoded = verifying_key.to_encoded_point(false);
    Wallet {
        address: address_from_verifying_key(verifying_key),
        private_key: format!("0x{}", hex::encode(signing_key.to_bytes())),
        public_key: format!("0x{}", hex::encode(encoded.as_bytes())),
    }
}

#[allow(dead_code)]
fn generate_wallet() -> Wallet {
    derive_wallet(&SigningKey::random(&mut OsRng))
}

// ---------------------------------------------------------------------------
// Active signing key.
//
// ⚠️ DEV ONLY: this is the *publicly known* Anvil/Hardhat account #0 private key
// (it is in every Foundry/Hardhat install and already used in our test vectors),
// matching SPIKE_ACCOUNT. It is a deliberate scaffold so the approval+signing
// vertical works and is E2E-testable now. The NEXT slice replaces this with an
// encrypted, password-unlocked key vault — no real key is ever hardcoded.
// ---------------------------------------------------------------------------
const DEV_PRIVKEY_HEX: &str = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

fn active_signing_key() -> &'static SigningKey {
    static KEY: OnceLock<SigningKey> = OnceLock::new();
    KEY.get_or_init(|| {
        let bytes = hex::decode(DEV_PRIVKEY_HEX).expect("DEV_PRIVKEY_HEX is valid hex");
        SigningKey::from_bytes(bytes.as_slice().into()).expect("DEV_PRIVKEY_HEX is a valid key")
    })
}

/// Decode a `personal_sign` message param. dApps usually send 0x-hex; some send a
/// raw UTF-8 string. EIP-191 hashes the *bytes*, so we just need the byte form.
fn decode_message_param(param: &Value) -> Result<Vec<u8>, String> {
    let s = param.as_str().ok_or("personal_sign: message param must be a string")?;
    match s.strip_prefix("0x") {
        Some(hex_body) => hex::decode(hex_body)
            .map_err(|e| format!("personal_sign: message is not valid hex: {e}")),
        None => Ok(s.as_bytes().to_vec()),
    }
}

/// EIP-191 `personal_sign`: sign keccak256("\x19Ethereum Signed Message:\n" ||
/// len(msg) || msg) with the active key. Returns 65-byte r‖s‖v hex (v = 27/28).
fn personal_sign(message: &[u8]) -> Result<Value, String> {
    let mut preimage = format!("\x19Ethereum Signed Message:\n{}", message.len()).into_bytes();
    preimage.extend_from_slice(message);
    let digest = Keccak256::digest(&preimage);

    let (signature, recovery_id) = active_signing_key()
        .sign_prehash_recoverable(&digest)
        .map_err(|e| format!("personal_sign: signing failed: {e}"))?;

    let mut sig = signature.to_bytes().to_vec(); // 64 bytes: r ‖ s
    sig.push(27 + recovery_id.to_byte()); // v
    Ok(json!(format!("0x{}", hex::encode(sig))))
}

// ---------------------------------------------------------------------------
// Wallet backend.
//
// Methods split three ways (see `route_method`):
//   * Wallet  — answered from local wallet state (accounts, selected chain).
//   * Signing — need the private key + user approval; not wired yet.
//   * Forward — read-only, proxied to the selected chain's public RPC node.
//
// The signing path + an encrypted key vault land next; for now dApps can read
// real chain state through the wallet and switch between built-in chains.
// ---------------------------------------------------------------------------

/// A throwaway demo account so dApps see a stable address until the real key
/// vault lands. (Anvil/Hardhat account #0.)
const SPIKE_ACCOUNT: &str = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

/// A supported EVM chain. `rpc` is the default public node we forward read-only
/// JSON-RPC to. Users will be able to add/override these from Settings later;
/// for now it is a built-in list.
struct Chain {
    /// EIP-155 chain id as a 0x-hex string (what dApps see via `eth_chainId`).
    id: &'static str,
    name: &'static str,
    rpc: &'static str,
}

const CHAINS: &[Chain] = &[
    Chain { id: "0x1",    name: "Ethereum",     rpc: "https://ethereum-rpc.publicnode.com" },
    Chain { id: "0x2105", name: "Base",         rpc: "https://base-rpc.publicnode.com" },
    Chain { id: "0xa",    name: "OP Mainnet",   rpc: "https://optimism-rpc.publicnode.com" },
    Chain { id: "0xa4b1", name: "Arbitrum One", rpc: "https://arbitrum-one-rpc.publicnode.com" },
    Chain { id: "0x89",   name: "Polygon",      rpc: "https://polygon-bor-rpc.publicnode.com" },
];

fn find_chain(id: &str) -> Option<&'static Chain> {
    CHAINS.iter().find(|c| c.id.eq_ignore_ascii_case(id))
}

/// The wallet's currently selected chain (EIP-155 hex). dApps read it via
/// `eth_chainId`; read-only RPC is forwarded to this chain's node. Mutable so
/// `wallet_switchEthereumChain` works. Defaults to Ethereum mainnet.
fn current_chain() -> &'static Mutex<String> {
    static CURRENT: OnceLock<Mutex<String>> = OnceLock::new();
    CURRENT.get_or_init(|| Mutex::new("0x1".to_string()))
}

/// A pooled HTTP client (keeps connections warm across RPC calls).
fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[derive(Debug, PartialEq)]
enum Route {
    /// Answered locally from wallet state.
    Wallet,
    /// Needs the private key + user approval (see the approval flow).
    Signing,
    /// Read-only; forwarded to the selected chain's node.
    Forward,
}

/// Classify an RPC method. Anything not explicitly wallet- or signing-related is
/// treated as a read-only node call (the long tail of `eth_*` getters).
fn route_method(method: &str) -> Route {
    match method {
        "eth_accounts" | "eth_requestAccounts" | "eth_coinbase" | "eth_chainId"
        | "net_version" | "wallet_switchEthereumChain" | "wallet_addEthereumChain"
        | "wallet_requestPermissions" | "wallet_getPermissions"
        | "wallet_revokePermissions" | "wallet_watchAsset" => Route::Wallet,

        "eth_sendTransaction" | "eth_sign" | "personal_sign" | "eth_signTypedData"
        | "eth_signTypedData_v1" | "eth_signTypedData_v3" | "eth_signTypedData_v4" => {
            Route::Signing
        }

        _ => Route::Forward,
    }
}

/// Result of a wallet-method call. `SwitchChain` is a directive the caller
/// applies to the shared `current_chain()` state — keeping this function pure
/// (no global mutation) so it can be unit-tested deterministically.
#[derive(Debug, PartialEq)]
enum WalletOutcome {
    Reply(Value),
    SwitchChain(String),
}

/// Handle a wallet-namespaced method against the given `current` chain id.
/// Pure: reads no globals, performs no I/O.
fn handle_wallet_method(method: &str, params: &[Value], current: &str) -> Result<WalletOutcome, String> {
    let chain_id_param = || -> Result<&str, String> {
        params
            .first()
            .and_then(|p| p.get("chainId"))
            .and_then(|c| c.as_str())
            .ok_or_else(|| format!("{method}: missing chainId param"))
    };

    match method {
        "eth_accounts" | "eth_requestAccounts" => Ok(WalletOutcome::Reply(json!([SPIKE_ACCOUNT]))),
        "eth_coinbase" => Ok(WalletOutcome::Reply(json!(SPIKE_ACCOUNT))),
        "eth_chainId" => Ok(WalletOutcome::Reply(json!(current))),
        "net_version" => {
            // current is always a registry id (valid hex) — surface a real error
            // rather than masking an impossible bad value with a default.
            let dec = u64::from_str_radix(current.trim_start_matches("0x"), 16)
                .map_err(|_| format!("invalid current chain id: {current}"))?;
            Ok(WalletOutcome::Reply(json!(dec.to_string())))
        }
        "wallet_switchEthereumChain" => {
            let target = chain_id_param()?;
            let chain = find_chain(target).ok_or_else(|| {
                format!("Unrecognized chain ID {target}; add it first (EIP-3326 code 4902)")
            })?;
            Ok(WalletOutcome::SwitchChain(chain.id.to_string()))
        }
        "wallet_addEthereumChain" => {
            // TODO: persist user-added chains (Settings → manage Chains). For now
            // only chains already in the built-in registry are accepted.
            let target = chain_id_param()?;
            find_chain(target)
                .map(|_| WalletOutcome::Reply(Value::Null))
                .ok_or_else(|| format!("wallet_addEthereumChain not supported yet for {target}"))
        }
        // Minimal EIP-2255: we only ever grant eth_accounts.
        "wallet_requestPermissions" | "wallet_getPermissions" => {
            Ok(WalletOutcome::Reply(json!([{ "parentCapability": "eth_accounts" }])))
        }
        "wallet_revokePermissions" => Ok(WalletOutcome::Reply(Value::Null)),
        "wallet_watchAsset" => Ok(WalletOutcome::Reply(json!(true))),
        other => Err(format!("wallet method not handled: {other}")),
    }
}

/// Forward a read-only method to the selected chain's node and return its result.
/// Node-side JSON-RPC errors are propagated (not masked).
async fn forward_to_node(method: &str, params: &[Value]) -> Result<Value, String> {
    let chain_id = current_chain().lock().unwrap().clone();
    let chain = find_chain(&chain_id)
        .ok_or_else(|| format!("no RPC configured for chain {chain_id}"))?;

    let payload = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });

    let resp = http()
        .post(chain.rpc)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("RPC request to {} failed: {e}", chain.name))?;
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("RPC response from {} was not JSON: {e}", chain.name))?;

    if let Some(err) = body.get("error") {
        let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown RPC error");
        return Err(format!("{msg} (code {code})"));
    }
    body.get("result")
        .cloned()
        .ok_or_else(|| format!("RPC response from {} had no result", chain.name))
}

// ---------------------------------------------------------------------------
// Approval flow.
//
// A signing method suspends in `request_approval` until the user decides in the
// dedicated approval window (a separate OS window — the dapp webview renders on
// top of the shell, so an in-shell modal can't cover it). The window's
// approve/reject commands resolve a per-request oneshot channel.
//
// SECURITY: approve_request/reject_request are scoped to the trusted "approval"
// webview only (capabilities/approval.json) — the dapp webview can never reach
// them, so a page cannot self-approve its own signing request.
// ---------------------------------------------------------------------------

/// A pending approval, as shown to the user (no key material, no responder).
#[derive(Debug, Clone, Serialize)]
struct PendingRequest {
    id: String,
    method: String,
    origin: String,
    /// Human-readable summary of what is being signed (decoded message text).
    summary: String,
}

struct PendingEntry {
    req: PendingRequest,
    responder: tokio::sync::oneshot::Sender<bool>,
}

fn pending() -> &'static Mutex<HashMap<String, PendingEntry>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PendingEntry>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_request_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    format!("req-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Render a signed message for display: UTF-8 if it's printable text, else hex.
fn preview_message(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) if s.chars().all(|c| !c.is_control() || c == '\n' || c == '\t') => s.to_string(),
        _ => format!("0x{}", hex::encode(bytes)),
    }
}

/// Register a pending request, surface the approval window, and await the user's
/// decision (with a safety timeout). Returns `true` if approved.
async fn request_approval<R: Runtime>(app: &AppHandle<R>, req: PendingRequest) -> bool {
    let id = req.id.clone();
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    pending().lock().unwrap().insert(id.clone(), PendingEntry { req, responder: tx });

    // Best-effort: bring up the approval window. If it can't open we still wait —
    // an already-open window (or, in tests, a direct approve_request) resolves it.
    if let Err(e) = open_approval_window(app) {
        println!("[AutoDesktop] warn: could not open approval window: {e}");
    }

    let decided = tokio::time::timeout(std::time::Duration::from_secs(300), rx).await;
    pending().lock().unwrap().remove(&id); // no-op if already resolved; cleans up on timeout
    matches!(decided, Ok(Ok(true)))
}

/// Open (or focus) the dedicated approval window — a separate top-level window
/// loading the shell UI in approval mode.
fn open_approval_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window("approval") {
        let _ = win.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(app, "approval", WebviewUrl::App("index.html?view=approval".into()))
        .title("Confirm request — AutoDesktop")
        .inner_size(420.0, 600.0)
        .resizable(false)
        .build()?;
    Ok(())
}

/// Resolve a pending request and close the approval window once nothing is left.
fn resolve_request<R: Runtime>(app: &AppHandle<R>, id: &str, approved: bool) -> Result<(), String> {
    let entry = pending()
        .lock()
        .unwrap()
        .remove(id)
        .ok_or_else(|| format!("no pending request {id}"))?;
    let _ = entry.responder.send(approved); // receiver may have timed out; ignore
    if pending().lock().unwrap().is_empty() {
        if let Some(win) = app.get_webview_window("approval") {
            let _ = win.close();
        }
    }
    Ok(())
}

/// Drive a signing method through the approval flow. Only `personal_sign` is
/// wired for now; other signing methods are rejected up-front (no point opening
/// an approval window for something we can't yet fulfill).
async fn handle_signing<R: Runtime>(
    app: &AppHandle<R>,
    method: &str,
    params: &[Value],
    origin: &str,
) -> Result<Value, String> {
    if method != "personal_sign" {
        return Err(format!(
            "{method} not implemented yet (signing lands incrementally; personal_sign first)"
        ));
    }
    let message = decode_message_param(
        params.first().ok_or("personal_sign: missing message param")?,
    )?;
    let req = PendingRequest {
        id: next_request_id(),
        method: method.to_string(),
        origin: origin.to_string(),
        summary: preview_message(&message),
    };
    if request_approval(app, req).await {
        personal_sign(&message)
    } else {
        // EIP-1193 userRejectedRequest.
        Err("User rejected the request (4001)".to_string())
    }
}

/// The single wallet backend entry point. `origin` is the trustworthy caller
/// origin derived from the webview context (see `wallet_request`).
async fn handle_rpc<R: Runtime>(
    app: &AppHandle<R>,
    method: &str,
    params: &[Value],
    origin: &str,
) -> Result<Value, String> {
    println!("[AutoDesktop] rpc  method={method}  origin={origin}");
    match route_method(method) {
        Route::Wallet => {
            let current = current_chain().lock().unwrap().clone();
            match handle_wallet_method(method, params, &current)? {
                WalletOutcome::Reply(v) => Ok(v),
                WalletOutcome::SwitchChain(new_id) => {
                    *current_chain().lock().unwrap() = new_id.clone();
                    println!("[AutoDesktop] switched chain -> {new_id}");
                    Ok(Value::Null) // EIP-3326: null on success
                }
            }
        }
        Route::Signing => handle_signing(app, method, params, origin).await,
        Route::Forward => forward_to_node(method, params).await,
    }
}

/// Approve a pending request. Scoped to the "approval" webview (ACL).
#[tauri::command]
fn approve_request<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    resolve_request(&app, &id, true)
}

/// Reject a pending request. Scoped to the "approval" webview (ACL).
#[tauri::command]
fn reject_request<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    resolve_request(&app, &id, false)
}

/// List requests awaiting approval, for the approval window to render.
#[tauri::command]
fn get_pending_requests() -> Vec<PendingRequest> {
    pending().lock().unwrap().values().map(|e| e.req.clone()).collect()
}

/// Local IPC command — the entire attack surface exposed to untrusted dApps
/// (capabilities/dapp.json grants only this command).
///
/// SECURITY: the caller origin is derived from the `webview` that actually sent
/// the IPC (engine-set, unforgeable), NOT from a JS-supplied parameter. This is
/// the fix for the spike TODO where `handle_rpc` trusted a page-sent origin.
#[tauri::command]
async fn wallet_request<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    method: String,
    params: Option<Vec<Value>>,
) -> Result<Value, String> {
    let origin = match webview.url() {
        Ok(url) => url.origin().ascii_serialization(),
        // No page URL yet — fall back to the (still engine-set) webview label,
        // never to anything the page could control.
        Err(_) => format!("webview://{}", webview.label()),
    };
    let app = webview.app_handle().clone();
    handle_rpc(&app, &method, &params.unwrap_or_default(), &origin).await
}

// ---------------------------------------------------------------------------
// Embedded dApp browser control (VISION feature ③).
//
// The shell drives the native `dapp` child webview: navigate it to the chosen
// dApp and place it over the `.browser-content` rect (measured in JS, sent here).
// These commands are reachable ONLY from the trusted shell — they are app
// commands with no ACL permission entry, and the verified ACL rule is that a
// *remote* webview calling a bare app command is denied ("Plugin not found").
// So an untrusted dApp can never reposition or navigate any webview; the e2e
// tests assert that denial.
// ---------------------------------------------------------------------------

/// A child webview's `set_position` is relative to the window FRAME (includes the
/// macOS title bar), but the rect the shell measures with getBoundingClientRect is
/// relative to the CONTENT area. Bridge the two by adding the title-bar inset
/// (inner_position − outer_position). Without this the dapp webview sits one
/// title-bar too high and clips the browser bar.
fn content_to_frame<R: Runtime>(dapp: &tauri::Webview<R>, x: f64, y: f64) -> (f64, f64) {
    let win = dapp.window();
    let scale = win.scale_factor().unwrap_or(1.0);
    // Title-bar inset, in logical px. The position delta is the principled source
    // but reports 0 for a container Window on macOS here, so fall back to the
    // outer/inner *size* height delta (title bar = the only frame chrome on macOS).
    let dy_pos = match (win.inner_position(), win.outer_position()) {
        (Ok(i), Ok(o)) => (i.y - o.y) as f64 / scale,
        _ => 0.0,
    };
    let dy_size = match (win.inner_size(), win.outer_size()) {
        (Ok(i), Ok(o)) => (o.height as f64 - i.height as f64) / scale,
        _ => 0.0,
    };
    // Under macOS fullSizeContentView the container window reports inner == outer
    // (no inset), yet child-webview set_position renders one title-bar too high.
    // Fall back to the title-bar constant when the dynamic deltas are ~0.
    // 32pt measured empirically via screencapture (the standard 28pt left a 4px
    // gap); make this dynamic via NSWindow.contentLayoutRect if it ever varies.
    const MACOS_TITLEBAR_PT: f64 = 32.0;
    let dy = if dy_pos > 0.5 {
        dy_pos
    } else if dy_size > 0.5 {
        dy_size
    } else {
        MACOS_TITLEBAR_PT
    };
    println!("[AutoDesktop] content_to_frame in=({x:.0},{y:.0}) -> dy={dy:.1}");
    (x, y + dy)
}

/// Each open dApp tab is its own child webview, labeled `dapp-<id>`. The
/// shell-only controls may target ONLY these — a strict label shape stops a shell
/// bug from being turned into hiding/closing the trusted "shell"/"approval"
/// webviews.
fn validate_dapp_label(label: &str) -> Result<(), String> {
    let ok = label.starts_with("dapp-")
        && label.len() > 5
        && label[5..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if ok {
        Ok(())
    } else {
        Err(format!("invalid dapp label: {label:?}"))
    }
}

/// Create a tab webview (remote, untrusted) as a child of the main window, with
/// the EIP-1193 provider injected. capabilities/dapp.json (`webviews: ["dapp-*"]`)
/// grants it ONLY allow-wallet-request.
fn create_dapp_webview<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    url: tauri::Url,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<tauri::Webview<R>, String> {
    let window = app
        .get_window("main")
        .ok_or("create_dapp_webview: main window not found")?;
    let builder = WebviewBuilder::new(label, WebviewUrl::External(url))
        .on_page_load(|_webview, payload| {
            println!(
                "[AutoDesktop] dapp page-load {:?}  url={}",
                payload.event(),
                payload.url()
            );
        })
        .initialization_script(INPAGE_PROVIDER);
    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(w.max(1.0), h.max(1.0)),
        )
        .map_err(|e| e.to_string())
}

/// Open (create-or-show) tab webview `label` over the content rect. Navigates to
/// `url` only on first creation, so re-activating a tab preserves its page.
#[tauri::command]
fn open_dapp<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    validate_dapp_label(&label)?;
    let parsed: tauri::Url = url
        .parse()
        .map_err(|e| format!("open_dapp: invalid url {url}: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("open_dapp: refusing non-http(s) url: {url}"));
    }
    let dapp = match app.get_webview(&label) {
        Some(wv) => wv,
        None => create_dapp_webview(&app, &label, parsed, x, y, w, h)?,
    };
    let (fx, fy) = content_to_frame(&dapp, x, y);
    dapp.set_position(LogicalPosition::new(fx, fy)).map_err(|e| e.to_string())?;
    dapp.set_size(LogicalSize::new(w.max(1.0), h.max(1.0))).map_err(|e| e.to_string())?;
    dapp.show().map_err(|e| e.to_string())?;
    Ok(())
}

/// Reposition/resize the active tab webview to track the content rect (resize).
/// Idempotent: a no-op if the tab webview no longer exists.
#[tauri::command]
fn set_dapp_bounds<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    validate_dapp_label(&label)?;
    if let Some(dapp) = app.get_webview(&label) {
        let (fx, fy) = content_to_frame(&dapp, x, y);
        dapp.set_position(LogicalPosition::new(fx, fy)).map_err(|e| e.to_string())?;
        dapp.set_size(LogicalSize::new(w.max(1.0), h.max(1.0))).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Hide a tab webview (switching to another tab or to Wallet/dApps). Idempotent.
#[tauri::command]
fn hide_dapp<R: Runtime>(app: AppHandle<R>, label: String) -> Result<(), String> {
    validate_dapp_label(&label)?;
    if let Some(dapp) = app.get_webview(&label) {
        dapp.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Close (destroy) a tab webview when its tab is closed. Idempotent.
#[tauri::command]
fn close_dapp<R: Runtime>(app: AppHandle<R>, label: String) -> Result<(), String> {
    validate_dapp_label(&label)?;
    if let Some(dapp) = app.get_webview(&label) {
        dapp.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Active wallet network (the chain dApps see via eth_chainId).
// ---------------------------------------------------------------------------

/// Push an EIP-1193 `chainChanged` to every open dApp tab by eval'ing the
/// provider's `window.__autoWalletPush` (see inpage.tauri.ts). Avoids granting the
/// dapp webviews any event capability — they keep ONLY allow-wallet-request.
fn push_chain_changed<R: Runtime>(app: &AppHandle<R>, chain_id: &str) {
    let payload = serde_json::to_string(chain_id).unwrap_or_else(|_| "\"0x1\"".into());
    let js = format!("window.__autoWalletPush && window.__autoWalletPush('chainChanged', {payload});");
    let mut pushed = 0;
    for (label, webview) in app.webviews() {
        if label.starts_with("dapp-") {
            let _ = webview.eval(js.clone());
            pushed += 1;
        }
    }
    println!("[AutoDesktop] chainChanged -> {pushed} dApp(s), chain={chain_id}");
}

/// Set the active wallet network (shell-only). Updates the chain dApps see via
/// `eth_chainId`/forwarded reads and pushes `chainChanged` to all open dApps.
#[tauri::command]
fn set_active_chain<R: Runtime>(app: AppHandle<R>, chain_id: String) -> Result<(), String> {
    let chain = find_chain(&chain_id).ok_or_else(|| format!("set_active_chain: unknown chain {chain_id}"))?;
    *current_chain().lock().unwrap() = chain.id.to_string();
    push_chain_changed(&app, chain.id);
    Ok(())
}

/// The active wallet network as a 0x-hex chain id (for the shell's chain selector).
#[tauri::command]
fn get_active_chain() -> String {
    current_chain().lock().unwrap().clone()
}

/// The app context (config, assets, baked-in ACL from capabilities/ + permissions/).
/// `generate_context!` defines a one-per-crate `_EMBED_INFO_PLIST` static, so it must
/// be expanded at exactly one call site. Keeping it in this single generic fn lets both
/// `run()` (Wry) and the in-process E2E tests (MockRuntime) share that one expansion.
fn build_context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

// ---------------------------------------------------------------------------
// Window / webview layout.
// ---------------------------------------------------------------------------
const WIN_W: f64 = 1280.0;
const WIN_H: f64 = 720.0;

/// The real EIP-1193/EIP-6963 provider from auto-wallet-core, bundled to a
/// self-contained IIFE by `bun run build:injected` and embedded at compile time.
/// Injected into every dApp webview before page scripts.
const INPAGE_PROVIDER: &str = include_str!("../injected/inpage.js");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Diagnostic beacon endpoint only. The wallet bridge does NOT use this
        // scheme: WebKit blocks cross-origin `fetch()` to custom schemes (one-way
        // subresource loads only), so dApps talk to the `wallet_request` command
        // via `invoke` instead. Kept as a one-way `new Image().src=...` beacon for
        // observing remote-page behaviour during development.
        .register_uri_scheme_protocol("adipc", |_ctx, request| {
            let origin = request
                .headers()
                .get("origin")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("<none>");
            println!("[AutoDesktop] adipc beacon: {}  origin={origin}", request.uri());
            tauri::http::Response::builder()
                .status(200)
                .header("Access-Control-Allow-Origin", "*")
                .header(tauri::http::header::CONTENT_TYPE, "application/json")
                .body(br#"{"ok":true}"#.to_vec())
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![
            wallet_request,
            approve_request,
            reject_request,
            get_pending_requests,
            open_dapp,
            set_dapp_bounds,
            hide_dapp,
            close_dapp,
            set_active_chain,
            get_active_chain
        ])
        .setup(|app| {
            // Container window (no webview of its own).
            let window = WindowBuilder::new(app, "main")
                .title("AutoDesktop")
                .inner_size(WIN_W, WIN_H)
                .min_inner_size(940.0, 600.0)
                .resizable(true)
                .build()?;

            // Shell webview (local, trusted): our React UI, fills the whole window.
            let shell_builder = WebviewBuilder::new("shell", WebviewUrl::App("index.html".into()));
            let shell = window.add_child(
                shell_builder,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(WIN_W, WIN_H),
            )?;

            // dApp tab webviews (remote, untrusted) are created on demand, one per
            // open tab, by `open_dapp` (see create_dapp_webview). Each is labeled
            // `dapp-<id>` and matched by capabilities/dapp.json (`webviews:
            // ["dapp-*"]`), which grants ONLY `allow-wallet-request` (+ remote URL
            // scope) — no core/fs/shell. That single command is the entire attack
            // surface. None exist at startup, so the Wallet page shows uncovered.

            // Child webviews keep fixed bounds, so make the shell fill the window
            // on resize ("可调窗口"). The dapp webview tracks the content rect
            // separately: resizing the shell resizes `.browser-content`, whose
            // ResizeObserver calls set_dapp_bounds from JS.
            let shell_for_resize = shell.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Resized(size) = event {
                    let scale = shell_for_resize
                        .window()
                        .scale_factor()
                        .unwrap_or(1.0);
                    let logical = size.to_logical::<f64>(scale);
                    let _ = shell_for_resize
                        .set_size(LogicalSize::new(logical.width, logical.height));
                }
            });

            Ok(())
        })
        .run(build_context())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Known test vector — the canonical Hardhat/Anvil account #0.
    #[test]
    fn derives_known_evm_address() {
        let priv_bytes =
            hex::decode("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
                .unwrap();
        let signing_key = SigningKey::from_bytes(priv_bytes.as_slice().into()).unwrap();
        let wallet = derive_wallet(&signing_key);
        assert_eq!(wallet.address, "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
        assert_eq!(wallet.public_key.len(), 2 + 130);
    }

    #[test]
    fn random_wallets_are_unique() {
        let a = generate_wallet();
        let b = generate_wallet();
        assert_ne!(a.address, b.address);
        assert_eq!(a.address.len(), 2 + 40);
    }

    #[test]
    fn classifies_methods() {
        // wallet state
        assert_eq!(route_method("eth_accounts"), Route::Wallet);
        assert_eq!(route_method("eth_requestAccounts"), Route::Wallet);
        assert_eq!(route_method("eth_chainId"), Route::Wallet);
        assert_eq!(route_method("wallet_switchEthereumChain"), Route::Wallet);
        // needs the private key + approval
        assert_eq!(route_method("personal_sign"), Route::Signing);
        assert_eq!(route_method("eth_sendTransaction"), Route::Signing);
        assert_eq!(route_method("eth_signTypedData_v4"), Route::Signing);
        // the read-only long tail → forwarded to the node
        assert_eq!(route_method("eth_getBalance"), Route::Forward);
        assert_eq!(route_method("eth_call"), Route::Forward);
        assert_eq!(route_method("eth_blockNumber"), Route::Forward);
        assert_eq!(route_method("eth_getTransactionReceipt"), Route::Forward);
    }

    #[test]
    fn chain_registry_lookup() {
        assert_eq!(find_chain("0x1").unwrap().name, "Ethereum");
        assert_eq!(find_chain("0x2105").unwrap().name, "Base");
        // case-insensitive id match
        assert_eq!(find_chain("0xA4B1").unwrap().name, "Arbitrum One");
        assert!(find_chain("0xdead").is_none());
        // every built-in chain has a https RPC and a unique id
        for c in CHAINS {
            assert!(c.rpc.starts_with("https://"), "{} has no https rpc", c.name);
            assert_eq!(CHAINS.iter().filter(|x| x.id == c.id).count(), 1);
        }
    }

    #[test]
    fn wallet_accounts_and_chain_id() {
        assert_eq!(
            handle_wallet_method("eth_accounts", &[], "0x1").unwrap(),
            WalletOutcome::Reply(json!([SPIKE_ACCOUNT]))
        );
        assert_eq!(
            handle_wallet_method("eth_coinbase", &[], "0x1").unwrap(),
            WalletOutcome::Reply(json!(SPIKE_ACCOUNT))
        );
        // eth_chainId / net_version reflect the passed-in current chain
        assert_eq!(
            handle_wallet_method("eth_chainId", &[], "0x2105").unwrap(),
            WalletOutcome::Reply(json!("0x2105"))
        );
        assert_eq!(
            handle_wallet_method("net_version", &[], "0x2105").unwrap(),
            WalletOutcome::Reply(json!("8453")) // 0x2105 == 8453
        );
        assert_eq!(
            handle_wallet_method("net_version", &[], "0x89").unwrap(),
            WalletOutcome::Reply(json!("137")) // 0x89 == 137
        );
    }

    #[test]
    fn switch_known_chain_yields_directive_unknown_errors() {
        let out = handle_wallet_method(
            "wallet_switchEthereumChain",
            &[json!({ "chainId": "0xa4b1" })],
            "0x1",
        )
        .unwrap();
        assert_eq!(out, WalletOutcome::SwitchChain("0xa4b1".to_string()));

        // unknown target chain is rejected (EIP-3326 4902 territory)
        assert!(handle_wallet_method(
            "wallet_switchEthereumChain",
            &[json!({ "chainId": "0xdead" })],
            "0x1",
        )
        .is_err());

        // missing chainId param is a hard error, not a silent default
        assert!(handle_wallet_method("wallet_switchEthereumChain", &[], "0x1").is_err());
    }
}

// ---------------------------------------------------------------------------
// In-process E2E tests.
//
// These exercise the REAL IPC pipeline — `invoke('wallet_request', …)` →
// `wallet_request(webview, …)` → `handle_rpc` → response — via Tauri's mock
// runtime (`tauri::test`), the only automatable E2E path on macOS. Unlike the
// pure unit tests above, the command's `tauri::Webview` arg and the async path
// are real here.
//
// Only `e2e_pipeline_offline` runs by default (deterministic, no network). The
// live network-forward test is `#[ignore]`d — run it with:
//     cargo test -- --ignored
// Both touch the shared `current_chain()` state, but only one global-touching
// test runs in each pass (default vs --ignored), so there is no race.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod e2e {
    use super::*;
    use serde_json::json;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{WebviewWindow, WebviewWindowBuilder};

    /// Build + leak one mock app with all commands registered. Uses the REAL app
    /// context (generate_context!) so the baked-in capabilities/permissions apply.
    /// A plain `cargo test` is a debug build, so Tauri treats it as dev (devUrl, no
    /// dist needed) — the same reason run() compiles. mock_context()'s empty ACL
    /// would reject every command with "Plugin not found".
    fn build_app() -> &'static tauri::App<MockRuntime> {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                wallet_request,
                approve_request,
                reject_request,
                get_pending_requests,
                open_dapp,
                set_dapp_bounds,
                hide_dapp,
                close_dapp,
                set_active_chain,
                get_active_chain
            ])
            .build(build_context())
            .expect("failed to build mock app");
        Box::leak(Box::new(app))
    }

    fn webview(
        app: &'static tauri::App<MockRuntime>,
        label: &str,
        url: tauri::WebviewUrl,
    ) -> WebviewWindow<MockRuntime> {
        WebviewWindowBuilder::new(app, label, url)
            .build()
            .expect("failed to build mock webview")
    }

    /// A *dapp* tab webview on a remote URL — the security-relevant path: its grant
    /// comes from dapp.json (webviews:["dapp-*"] + remote urls + allow-wallet-request).
    fn dapp_webview(app: &'static tauri::App<MockRuntime>) -> WebviewWindow<MockRuntime> {
        webview(
            app,
            "dapp-0",
            tauri::WebviewUrl::External("https://metamask.github.io/test-dapp/".parse().unwrap()),
        )
    }

    /// The trusted *approval* webview (local) — granted the approve/reject/list
    /// commands by capabilities/approval.json.
    fn approval_webview(app: &'static tauri::App<MockRuntime>) -> WebviewWindow<MockRuntime> {
        webview(app, "approval", tauri::WebviewUrl::App("index.html?view=approval".into()))
    }

    /// Drive any command through the real IPC pipeline from a given webview.
    /// Returns `Ok(result)` or `Err(error_value)` for a rejected promise.
    fn invoke(wv: &WebviewWindow<MockRuntime>, cmd: &str, args: Value) -> Result<Value, Value> {
        // The IPC url must reflect the calling page: the ACL distinguishes local
        // (approval webview) from remote (dapp webview). Deriving it from the
        // webview makes both capability scopes resolve correctly.
        let url = wv.url().expect("mock webview has a url");
        get_ipc_response(
            wv,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url,
                body: InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|b| b.deserialize::<Value>().unwrap())
    }

    /// Convenience for the dApp bridge command specifically.
    fn call(wv: &WebviewWindow<MockRuntime>, method: &str, params: Value) -> Result<Value, Value> {
        invoke(wv, "wallet_request", json!({ "method": method, "params": params }))
    }

    /// Serialize tests that touch the shared `pending()` registry, and clear it so
    /// each starts clean (the registry is a process-global static).
    fn approval_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        let g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        pending().lock().unwrap().clear();
        g
    }

    /// Poll until a request is registered, returning its id.
    fn wait_for_pending_id() -> String {
        for _ in 0..300 {
            if let Some(id) = pending().lock().unwrap().keys().next().cloned() {
                return id;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("no pending approval request appeared within 3s");
    }

    /// Recover the signer address from an EIP-191 personal_sign signature.
    fn recover_personal_sign(message: &[u8], sig65: &[u8]) -> String {
        let mut preimage =
            format!("\x19Ethereum Signed Message:\n{}", message.len()).into_bytes();
        preimage.extend_from_slice(message);
        let digest = Keccak256::digest(&preimage);
        let signature = k256::ecdsa::Signature::from_slice(&sig65[..64]).expect("valid sig");
        let recid = k256::ecdsa::RecoveryId::from_byte(sig65[64] - 27).expect("valid recid");
        let vk = VerifyingKey::recover_from_prehash(&digest, &signature, recid).expect("recover");
        address_from_verifying_key(&vk)
    }

    #[test]
    fn e2e_pipeline_offline() {
        let wv = dapp_webview(build_app());
        *current_chain().lock().unwrap() = "0x1".into();

        // Wallet-routed reads come back through the full invoke→command→handler path.
        assert_eq!(call(&wv, "eth_accounts", json!([])).unwrap(), json!([SPIKE_ACCOUNT]));
        assert_eq!(call(&wv, "eth_chainId", json!([])).unwrap(), json!("0x1"));
        assert_eq!(call(&wv, "net_version", json!([])).unwrap(), json!("1"));

        // A not-yet-implemented signing method is rejected up-front (no approval
        // window, returns immediately). personal_sign (which DOES wait for approval)
        // is covered by the dedicated approval tests below.
        let err = call(&wv, "eth_sendTransaction", json!([{ "to": SPIKE_ACCOUNT }])).unwrap_err();
        assert!(
            err.as_str().unwrap_or_default().contains("not implemented"),
            "expected not-implemented error, got: {err}"
        );

        // Switching chain is reflected by a subsequent eth_chainId — proving the
        // command actually mutated the shared current-chain state.
        assert_eq!(
            call(&wv, "wallet_switchEthereumChain", json!([{ "chainId": "0x2105" }])).unwrap(),
            Value::Null
        );
        assert_eq!(call(&wv, "eth_chainId", json!([])).unwrap(), json!("0x2105"));
        assert_eq!(call(&wv, "net_version", json!([])).unwrap(), json!("8453"));

        // Unknown chain is rejected, current chain unchanged.
        assert!(call(&wv, "wallet_switchEthereumChain", json!([{ "chainId": "0xbadbad" }])).is_err());
        assert_eq!(call(&wv, "eth_chainId", json!([])).unwrap(), json!("0x2105"));

        *current_chain().lock().unwrap() = "0x1".into();
    }

    #[test]
    #[ignore = "hits a live public RPC node; run with `cargo test -- --ignored`"]
    fn e2e_forward_live() {
        let wv = dapp_webview(build_app());
        *current_chain().lock().unwrap() = "0x1".into();

        // eth_blockNumber is forwarded to Ethereum mainnet → a plausible block.
        let bn = call(&wv, "eth_blockNumber", json!([])).unwrap();
        let s = bn.as_str().expect("blockNumber should be a hex string");
        let n = u64::from_str_radix(s.trim_start_matches("0x"), 16).expect("hex");
        assert!(n > 19_000_000, "mainnet block implausibly low: {n} ({s})");

        // eth_getBalance forwarded → a hex quantity.
        let bal = call(
            &wv,
            "eth_getBalance",
            json!(["0x0000000000000000000000000000000000000000", "latest"]),
        )
        .unwrap();
        assert!(bal.as_str().unwrap().starts_with("0x"), "balance not hex: {bal}");

        // Switch to Base, then the SAME method forwards to a DIFFERENT node.
        call(&wv, "wallet_switchEthereumChain", json!([{ "chainId": "0x2105" }])).unwrap();
        let base_bn = call(&wv, "eth_blockNumber", json!([])).unwrap();
        let bs = base_bn.as_str().expect("hex string");
        let bnum = u64::from_str_radix(bs.trim_start_matches("0x"), 16).expect("hex");
        assert!(bnum > 10_000_000, "base block implausibly low: {bnum} ({bs})");

        *current_chain().lock().unwrap() = "0x1".into();
    }

    // --- Approval flow (offline, deterministic) --------------------------------

    /// personal_sign blocks until the user approves; approval comes ONLY from the
    /// trusted "approval" webview. The returned signature must recover to the
    /// signing account — proving the whole approve→sign path end-to-end.
    #[test]
    fn e2e_personal_sign_approve() {
        let _guard = approval_guard();
        let app = build_app();
        let dapp = dapp_webview(app);
        let approval = approval_webview(app); // exists → request_approval reuses it

        let message_text = "Hello from AutoDesktop";
        let message_hex = format!("0x{}", hex::encode(message_text));
        let account = SPIKE_ACCOUNT;

        // personal_sign blocks on approval → run it on a worker thread.
        let dapp_for_thread = dapp.clone();
        let signer = std::thread::spawn(move || {
            call(&dapp_for_thread, "personal_sign", json!([message_hex, account]))
        });

        // Approve from the approval webview once the request is registered.
        let id = wait_for_pending_id();
        // The approval UI first lists pending requests…
        let pending_list = invoke(&approval, "get_pending_requests", json!({})).unwrap();
        assert_eq!(pending_list.as_array().unwrap().len(), 1);
        assert_eq!(pending_list[0]["summary"], json!(message_text)); // decoded for display
        assert_eq!(pending_list[0]["origin"], json!("https://metamask.github.io"));
        // …then approves.
        invoke(&approval, "approve_request", json!({ "id": id })).expect("approve ok");

        let sig = signer.join().unwrap().expect("signature returned");
        let sig_hex = sig.as_str().expect("signature is a hex string");
        let raw = hex::decode(sig_hex.trim_start_matches("0x")).expect("hex sig");
        assert_eq!(raw.len(), 65, "EIP-191 signature must be 65 bytes");
        assert_eq!(
            recover_personal_sign(message_text.as_bytes(), &raw).to_lowercase(),
            account.to_lowercase(),
            "signature must recover to the signing account"
        );
    }

    /// Rejecting yields the EIP-1193 user-rejected (4001) error to the dApp.
    #[test]
    fn e2e_personal_sign_reject() {
        let _guard = approval_guard();
        let app = build_app();
        let dapp = dapp_webview(app);
        let approval = approval_webview(app);

        let dapp_for_thread = dapp.clone();
        let signer = std::thread::spawn(move || {
            call(&dapp_for_thread, "personal_sign", json!(["0x48656c6c6f", SPIKE_ACCOUNT]))
        });

        let id = wait_for_pending_id();
        invoke(&approval, "reject_request", json!({ "id": id })).expect("reject ok");

        let err = signer.join().unwrap().unwrap_err();
        assert!(
            err.as_str().unwrap_or_default().contains("4001"),
            "expected user-rejected (4001), got: {err}"
        );
    }

    /// SECURITY: the dapp webview must NOT be able to approve requests — the ACL
    /// grants approve_request only to the "approval" webview. A page calling it
    /// (e.g. to self-approve) is denied by Tauri before reaching our handler.
    #[test]
    fn e2e_dapp_cannot_approve() {
        let _guard = approval_guard();
        let app = build_app();
        let dapp = dapp_webview(app);

        let err = invoke(&dapp, "approve_request", json!({ "id": "req-1" })).unwrap_err();
        let msg = err.as_str().unwrap_or_default();
        assert!(
            msg.contains("not allowed") || msg.contains("not found"),
            "expected ACL denial for dapp→approve_request, got: {err}"
        );
    }

    /// The trusted *shell* webview (local). As a local webview it may call bare
    /// app commands; the dapp-browser controls (open/close/bounds) are reachable
    /// only this way.
    fn shell_webview(app: &'static tauri::App<MockRuntime>) -> WebviewWindow<MockRuntime> {
        webview(app, "shell", tauri::WebviewUrl::App("index.html".into()))
    }

    /// SECURITY: an untrusted dApp page must NOT be able to drive the embedded
    /// browser — navigating or repositioning a webview is a shell-only power. The
    /// commands have no ACL permission entry, so the remote dapp webview is denied
    /// before reaching the handler. (If these were ever added to dapp.json this
    /// fails.)
    #[test]
    fn e2e_dapp_cannot_control_webviews() {
        let app = build_app();
        let dapp = dapp_webview(app);

        for (cmd, args) in [
            ("open_dapp", json!({ "label": "dapp-9", "url": "https://evil.example", "x": 0.0, "y": 0.0, "w": 10.0, "h": 10.0 })),
            ("set_dapp_bounds", json!({ "label": "dapp-9", "x": 0.0, "y": 0.0, "w": 10.0, "h": 10.0 })),
            ("hide_dapp", json!({ "label": "dapp-9" })),
            ("close_dapp", json!({ "label": "dapp-9" })),
            ("set_active_chain", json!({ "chainId": "0x1" })),
        ] {
            let err = invoke(&dapp, cmd, args).unwrap_err();
            let msg = err.as_str().unwrap_or_default();
            assert!(
                msg.contains("not allowed") || msg.contains("not found"),
                "expected ACL denial for dapp→{cmd}, got: {err}"
            );
        }
    }

    /// open_dapp refuses non-http(s) schemes (e.g. file:/javascript:) — guards
    /// against the shell being tricked into pointing the webview at a local file
    /// or a script URL. Pure command logic: deleting the scheme check fails this.
    #[test]
    fn e2e_open_dapp_rejects_non_http_scheme() {
        let app = build_app();
        let shell = shell_webview(app);

        for bad in ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x"] {
            let err = invoke(
                &shell,
                "open_dapp",
                json!({ "label": "dapp-0", "url": bad, "x": 0.0, "y": 0.0, "w": 100.0, "h": 100.0 }),
            )
            .unwrap_err();
            assert!(
                err.as_str().unwrap_or_default().contains("refusing non-http"),
                "expected scheme rejection for {bad}, got: {err}"
            );
        }
    }

    /// open_dapp / hide_dapp / close_dapp reject labels that aren't `dapp-<id>`,
    /// so these shell commands can never target the trusted shell/approval webviews.
    #[test]
    fn e2e_dapp_controls_reject_foreign_labels() {
        let app = build_app();
        let shell = shell_webview(app);
        for label in ["shell", "approval", "dapp", "../shell", "dapp-bad/slash"] {
            let err = invoke(
                &shell,
                "open_dapp",
                json!({ "label": label, "url": "https://app.uniswap.org", "x": 0.0, "y": 0.0, "w": 10.0, "h": 10.0 }),
            )
            .unwrap_err();
            assert!(
                err.as_str().unwrap_or_default().contains("invalid dapp label"),
                "expected label rejection for {label:?}, got: {err}"
            );
        }
    }

    /// set_active_chain accepts a known chain and rejects an unknown one (real
    /// validation: deleting the find_chain check fails the unknown case). Only ever
    /// sets the default 0x1 so it doesn't race the other chain-reading e2e tests.
    #[test]
    fn e2e_set_active_chain_validates() {
        let app = build_app();
        let shell = shell_webview(app);

        invoke(&shell, "set_active_chain", json!({ "chainId": "0x1" }))
            .expect("known chain should be accepted");

        let err = invoke(&shell, "set_active_chain", json!({ "chainId": "0xdead" })).unwrap_err();
        assert!(
            err.as_str().unwrap_or_default().contains("unknown chain"),
            "expected unknown-chain rejection, got: {err}"
        );
    }

    /// The trusted shell CAN drive a tab webview: open (show), reposition, hide,
    /// and close all succeed against the real dapp-<id> webview.
    #[test]
    fn e2e_shell_controls_embedded_browser() {
        let app = build_app();
        let _dapp = dapp_webview(app); // label "dapp-0" — must exist for the controls
        let shell = shell_webview(app);

        invoke(
            &shell,
            "open_dapp",
            json!({ "label": "dapp-0", "url": "https://app.uniswap.org", "x": 232.0, "y": 52.0, "w": 1048.0, "h": 668.0 }),
        )
        .expect("shell open_dapp should succeed");

        invoke(
            &shell,
            "set_dapp_bounds",
            json!({ "label": "dapp-0", "x": 232.0, "y": 52.0, "w": 1200.0, "h": 800.0 }),
        )
        .expect("shell set_dapp_bounds should succeed");

        invoke(&shell, "hide_dapp", json!({ "label": "dapp-0" }))
            .expect("shell hide_dapp should succeed");

        invoke(&shell, "close_dapp", json!({ "label": "dapp-0" }))
            .expect("shell close_dapp should succeed");
    }
}
