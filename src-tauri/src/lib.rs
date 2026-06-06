use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
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
use zeroize::Zeroizing;

// Encrypted HD key vault (BIP-39/44 + Argon2id/AES-GCM). Pure crypto core; the
// in-memory unlocked state + file I/O + Tauri commands live below in this file.
mod vault;
// EIP-1559 transaction encoding + signing (pure). eth_sendTransaction fills the
// fields from the node in lib.rs, then builds + signs here.
mod eth_tx;
// EIP-712 typed-data hashing (pure) for eth_signTypedData_v4.
mod eip712;
// Ledger hardware wallet over USB-HID (framing + Ethereum APDUs + hidapi I/O).
mod ledger;

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
// Key vault (in-memory unlocked state).
//
// Private keys live ONLY in Rust and ONLY while the wallet is unlocked. The
// encrypted mnemonic at rest is handled by `mod vault` (Argon2id + AES-256-GCM);
// here we hold the decrypted, HD-derived accounts for the session. No key material
// ever crosses into any webview. There is NO hardcoded dev key anymore — a locked
// wallet refuses to sign (密钥安全: fail loud, never fall back to a default key).
// ---------------------------------------------------------------------------

/// How an account signs. A software account holds the secp256k1 key in process; a
/// Ledger account holds no key — it signs on the device over USB-HID at its path.
enum Signer {
    Local(SigningKey),
    Ledger { path: String },
}

/// One unlocked account. Software accounts are derived at `m/44'/60'/0'/0/index`;
/// Ledger accounts carry their own derivation path inside `Signer::Ledger`.
struct UnlockedAccount {
    index: u32,
    address: String,
    signer: Signer,
}

/// What kind of secret backs this vault — decides whether more accounts can be
/// derived. An imported single private key has no mnemonic to walk.
enum VaultSecret {
    /// BIP-39 root mnemonic — kept to derive further HD accounts on demand;
    /// zeroized on drop.
    Mnemonic(Zeroizing<String>),
    /// A single imported private key — the key lives in its `UnlockedAccount`;
    /// there is nothing to derive from, so `add_account` is refused.
    PrivateKey,
    /// A Ledger device — no in-process secret at all; signing goes to the device.
    Ledger,
}

/// The active account's signing capability, snapshotted out of the vault lock.
enum ActiveKind {
    /// Software key — sign in-process via `with_active_key`.
    Local,
    /// Ledger account at this derivation path — sign on the device (no lock held).
    Ledger(String),
}

/// The decrypted vault for this session.
struct UnlockedVault {
    secret: VaultSecret,
    accounts: Vec<UnlockedAccount>,
    active: usize,
}

fn vault_state() -> &'static Mutex<Option<UnlockedVault>> {
    static V: OnceLock<Mutex<Option<UnlockedVault>>> = OnceLock::new();
    V.get_or_init(|| Mutex::new(None))
}

/// The active account's address, or `None` when the wallet is locked / empty.
fn active_account_address() -> Option<String> {
    let guard = vault_state().lock().unwrap();
    let v = guard.as_ref()?;
    v.accounts.get(v.active).map(|a| a.address.clone())
}

/// Run `f` with the active account's *software* signing key. Errors clearly when
/// locked or when the active account is a Ledger (use the device path instead),
/// rather than silently falling back to any default key.
fn with_active_key<T>(f: impl FnOnce(&SigningKey) -> T) -> Result<T, String> {
    let guard = vault_state().lock().unwrap();
    let v = guard.as_ref().ok_or("wallet is locked")?;
    let acct = v.accounts.get(v.active).ok_or("no active account")?;
    match &acct.signer {
        Signer::Local(key) => Ok(f(key)),
        Signer::Ledger { .. } => {
            Err("active account is a Ledger — sign on the device".to_string())
        }
    }
}

/// Snapshot the active account's signing kind (and Ledger path) without holding the
/// vault lock during the (slow) device round-trip.
fn active_signer_kind() -> Result<ActiveKind, String> {
    let guard = vault_state().lock().unwrap();
    let v = guard.as_ref().ok_or("wallet is locked")?;
    let acct = v.accounts.get(v.active).ok_or("no active account")?;
    Ok(match &acct.signer {
        Signer::Local(_) => ActiveKind::Local,
        Signer::Ledger { path } => ActiveKind::Ledger(path.clone()),
    })
}

/// Derive `count` (≥1) accounts from `mnemonic` and install them as THE unlocked
/// vault, active = account 0. Shared by create/import/unlock and the e2e tests.
/// Returns the public account metadata (for sealing into the keystore).
fn install_unlocked_vault(mnemonic: &str, count: u32) -> Result<Vec<vault::AccountMeta>, String> {
    let count = count.max(1);
    let mut accounts = Vec::with_capacity(count as usize);
    let mut metas = Vec::with_capacity(count as usize);
    for index in 0..count {
        let (key, address) = vault::derive_account(mnemonic, index)?;
        metas.push(vault::AccountMeta { index, address: address.clone() });
        accounts.push(UnlockedAccount { index, address, signer: Signer::Local(key) });
    }
    *vault_state().lock().unwrap() = Some(UnlockedVault {
        secret: VaultSecret::Mnemonic(Zeroizing::new(mnemonic.to_string())),
        accounts,
        active: 0,
    });
    Ok(metas)
}

/// Install a single imported private key as THE unlocked vault. There is no
/// mnemonic, so no further accounts can be derived (`add_account` refuses).
/// Returns the single account's public metadata (for sealing into the keystore).
fn install_privkey_vault(privkey_hex: &str) -> Result<Vec<vault::AccountMeta>, String> {
    let key = vault::parse_private_key(privkey_hex)?;
    let address = address_from_verifying_key(key.verifying_key());
    let metas = vec![vault::AccountMeta { index: 0, address: address.clone() }];
    *vault_state().lock().unwrap() = Some(UnlockedVault {
        secret: VaultSecret::PrivateKey,
        accounts: vec![UnlockedAccount { index: 0, address, signer: Signer::Local(key) }],
        active: 0,
    });
    Ok(metas)
}

/// Restore a Ledger vault from its on-disk keystore (no password / no device). The
/// path + address are public, so this just records the active account. Returns the
/// active address.
fn install_ledger_vault_from_keystore(ks: &vault::Keystore) -> Result<String, String> {
    let path = ks.path.as_deref().ok_or("ledger keystore missing derivation path")?;
    let address = ks
        .accounts
        .first()
        .map(|a| a.address.clone())
        .ok_or("ledger keystore has no account")?;
    install_ledger_vault(path, &address)?;
    Ok(address)
}

/// Install a Ledger account (derivation path + its address) as THE unlocked vault.
/// No in-process key: signing goes to the device. The address is public, so this
/// needs neither a password nor the device to be present — it just records that the
/// active wallet is the Ledger at `path`.
fn install_ledger_vault(path: &str, address: &str) -> Result<Vec<vault::AccountMeta>, String> {
    let metas = vec![vault::AccountMeta { index: 0, address: address.to_string() }];
    *vault_state().lock().unwrap() = Some(UnlockedVault {
        secret: VaultSecret::Ledger,
        accounts: vec![UnlockedAccount {
            index: 0,
            address: address.to_string(),
            signer: Signer::Ledger { path: path.to_string() },
        }],
        active: 0,
    });
    Ok(metas)
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

/// EIP-191 `personal_sign`. A software account signs keccak256("\x19Ethereum
/// Signed Message:\n" || len || msg) locally; a Ledger applies the EIP-191 prefix
/// itself, so it gets the raw message. Returns 65-byte r‖s‖v hex (v = 27/28).
fn personal_sign(message: &[u8]) -> Result<Value, String> {
    let sig = match active_signer_kind()? {
        ActiveKind::Local => {
            let mut preimage =
                format!("\x19Ethereum Signed Message:\n{}", message.len()).into_bytes();
            preimage.extend_from_slice(message);
            let digest = Keccak256::digest(&preimage);
            let (signature, recovery_id) =
                with_active_key(|k| k.sign_prehash_recoverable(&digest))?
                    .map_err(|e| format!("personal_sign: signing failed: {e}"))?;
            let mut sig = signature.to_bytes().to_vec(); // 64 bytes: r ‖ s
            sig.push(27 + recovery_id.to_byte()); // v
            sig
        }
        ActiveKind::Ledger(path) => ledger::sign_personal_message(&path, message)?.to_vec(),
    };
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

/// Anvil/Hardhat account #0 — the address the well-known test mnemonic derives at
/// `m/44'/60'/0'/0/0`. Test-only fixture (the unlocked test vault uses that
/// mnemonic), so production builds don't reference it.
#[cfg(test)]
const SPIKE_ACCOUNT: &str = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

/// A supported EVM chain. `rpc` is the public node we forward read-only JSON-RPC
/// to. Users can add custom chains and edit existing params from Settings; the
/// effective list lives in `chains_state()` and is persisted to chains.json.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct ChainCfg {
    /// EIP-155 chain id as a 0x-hex string (what dApps see via `eth_chainId`).
    id: String,
    name: String,
    symbol: String,
    rpc: String,
    decimals: u32,
    /// Brand color for the chain dot (frontend display).
    color: String,
    /// Built-in chains can be edited (rpc/name/symbol) but not removed.
    builtin: bool,
}

fn builtin_chains() -> Vec<ChainCfg> {
    fn c(id: &str, name: &str, symbol: &str, rpc: &str, color: &str) -> ChainCfg {
        ChainCfg { id: id.into(), name: name.into(), symbol: symbol.into(), rpc: rpc.into(), decimals: 18, color: color.into(), builtin: true }
    }
    vec![
        c("0x1",    "Ethereum",     "ETH", "https://ethereum-rpc.publicnode.com",    "#627EEA"),
        c("0x2105", "Base",         "ETH", "https://base-rpc.publicnode.com",        "#0052FF"),
        c("0xa",    "OP Mainnet",   "ETH", "https://optimism-rpc.publicnode.com",    "#FF0420"),
        c("0xa4b1", "Arbitrum One", "ETH", "https://arbitrum-one-rpc.publicnode.com", "#28A0F0"),
        c("0x89",   "Polygon",      "POL", "https://polygon-bor-rpc.publicnode.com", "#8247E5"),
    ]
}

/// The effective chain registry (built-ins + user edits/additions). Initialized to
/// the built-ins; `load_chains` merges the persisted user file at startup.
fn chains_state() -> &'static Mutex<Vec<ChainCfg>> {
    static C: OnceLock<Mutex<Vec<ChainCfg>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(builtin_chains()))
}

fn find_chain(id: &str) -> Option<ChainCfg> {
    chains_state().lock().unwrap().iter().find(|c| c.id.eq_ignore_ascii_case(id)).cloned()
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

/// Handle a wallet-namespaced method against the given `current` chain id and the
/// active account (`None` when the wallet is locked). Pure: reads no globals, does
/// no I/O — the caller supplies chain + account so this stays unit-testable.
fn handle_wallet_method(
    method: &str,
    params: &[Value],
    current: &str,
    account: Option<&str>,
) -> Result<WalletOutcome, String> {
    let chain_id_param = || -> Result<&str, String> {
        params
            .first()
            .and_then(|p| p.get("chainId"))
            .and_then(|c| c.as_str())
            .ok_or_else(|| format!("{method}: missing chainId param"))
    };

    match method {
        // EIP-1193: an unlocked wallet reports its active account; a locked one
        // reports none (the dApp shows a "connect" prompt). We never expose a key
        // here — only the public address.
        "eth_accounts" | "eth_requestAccounts" => Ok(WalletOutcome::Reply(
            account.map(|a| json!([a])).unwrap_or_else(|| json!([])),
        )),
        "eth_coinbase" => Ok(WalletOutcome::Reply(
            account.map(|a| json!(a)).unwrap_or(Value::Null),
        )),
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
        .post(chain.rpc.as_str())
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

/// Drive a signing method through the approval flow. `personal_sign` and
/// `eth_sendTransaction` are wired; other signing methods are rejected up-front
/// (no point opening an approval window for something we can't yet fulfill).
async fn handle_signing<R: Runtime>(
    app: &AppHandle<R>,
    method: &str,
    params: &[Value],
    origin: &str,
) -> Result<Value, String> {
    // Refuse before opening an approval window if there's no key to sign with —
    // otherwise the user would approve a request we can't fulfill.
    if active_account_address().is_none() {
        return Err("wallet is locked".to_string());
    }

    match method {
        "personal_sign" => {
            let message =
                decode_message_param(params.first().ok_or("personal_sign: missing message param")?)?;
            let req = PendingRequest {
                id: next_request_id(),
                method: method.to_string(),
                origin: origin.to_string(),
                summary: preview_message(&message),
            };
            if request_approval(app, req).await {
                personal_sign(&message)
            } else {
                Err("User rejected the request (4001)".to_string())
            }
        }
        "eth_sendTransaction" => {
            let tx = params
                .first()
                .ok_or("eth_sendTransaction: missing transaction param")?
                .clone();
            let req = PendingRequest {
                id: next_request_id(),
                method: method.to_string(),
                origin: origin.to_string(),
                summary: preview_tx(&tx),
            };
            if request_approval(app, req).await {
                build_send_transaction(&tx).await
            } else {
                Err("User rejected the request (4001)".to_string())
            }
        }
        "eth_signTypedData_v4" => {
            // Params are [address, typedData]; the typed data is usually a JSON
            // string, occasionally an object.
            let raw = params
                .get(1)
                .ok_or("eth_signTypedData_v4: missing typed-data param")?;
            let typed: Value = match raw {
                Value::String(s) => serde_json::from_str(s)
                    .map_err(|e| format!("eth_signTypedData_v4: invalid typed-data JSON: {e}"))?,
                other => other.clone(),
            };
            // Surface obvious structural errors BEFORE prompting (e.g. unknown type).
            eip712::signing_hash(&typed)?;
            let req = PendingRequest {
                id: next_request_id(),
                method: method.to_string(),
                origin: origin.to_string(),
                summary: preview_typed_data(&typed),
            };
            if request_approval(app, req).await {
                sign_typed_data(&typed)
            } else {
                Err("User rejected the request (4001)".to_string())
            }
        }
        other => Err(format!(
            "{other} not implemented yet (signing lands incrementally)"
        )),
    }
}

/// Sign EIP-712 typed data → 65-byte r‖s‖v hex. A software account signs the
/// 0x1901 digest locally; a Ledger is sent the domain separator + message hash and
/// signs on the device.
fn sign_typed_data(typed: &Value) -> Result<Value, String> {
    let sig = match active_signer_kind()? {
        ActiveKind::Local => {
            let digest = eip712::signing_hash(typed)?;
            let (signature, recovery_id) =
                with_active_key(|k| k.sign_prehash_recoverable(&digest))?
                    .map_err(|e| format!("eth_signTypedData_v4: signing failed: {e}"))?;
            let mut sig = signature.to_bytes().to_vec(); // 64 bytes: r ‖ s
            sig.push(27 + recovery_id.to_byte()); // v
            sig
        }
        ActiveKind::Ledger(path) => {
            let (domain_separator, message_hash) = eip712::domain_and_message_hash(typed)?;
            ledger::sign_eip712(&path, &domain_separator, &message_hash)?.to_vec()
        }
    };
    Ok(json!(format!("0x{}", hex::encode(sig))))
}

/// A human-readable summary of typed data for the approval window.
fn preview_typed_data(typed: &Value) -> String {
    let primary = typed.get("primaryType").and_then(|v| v.as_str()).unwrap_or("typed data");
    let domain = typed
        .get("domain")
        .and_then(|d| d.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if domain.is_empty() {
        format!("Sign typed data ({primary})")
    } else {
        format!("Sign {primary} for {domain}")
    }
}

/// Pull a string field from the dApp's transaction object.
fn tx_field<'a>(tx: &'a Value, key: &str) -> Option<&'a str> {
    tx.get(key).and_then(|v| v.as_str())
}

/// Parse a 0x-hex quantity to u128 (used only for the fee arithmetic + summary).
fn hex_to_u128(hex: &str) -> Result<u128, String> {
    let s = hex.strip_prefix("0x").unwrap_or(hex);
    u128::from_str_radix(if s.is_empty() { "0" } else { s }, 16)
        .map_err(|e| format!("bad quantity {hex}: {e}"))
}

/// A human-readable summary of a transaction for the approval window. Display
/// only — `build_send_transaction` re-parses and validates the real fields.
fn preview_tx(tx: &Value) -> String {
    let to = tx_field(tx, "to").unwrap_or("new contract");
    let short_to = if to.len() > 12 { format!("{}…{}", &to[..6], &to[to.len() - 4..]) } else { to.to_string() };
    let eth = hex_to_u128(tx_field(tx, "value").unwrap_or("0x0")).unwrap_or(0) as f64 / 1e18;
    let has_data = tx_field(tx, "data").or_else(|| tx_field(tx, "input")).map_or(false, |d| d.len() > 2);
    if has_data {
        format!("Contract interaction → {short_to} ({eth:.4} ETH)")
    } else {
        format!("Send {eth:.4} ETH → {short_to}")
    }
}

/// Resolve the EIP-1559 fee fields: use the dApp's if both are given, else suggest
/// `maxPriorityFeePerGas` from the node (1 gwei fallback) and
/// `maxFeePerGas = 2*baseFee + priority` from the pending block's base fee.
async fn resolve_fees(tx: &Value) -> Result<(String, String), String> {
    if let (Some(prio), Some(max)) =
        (tx_field(tx, "maxPriorityFeePerGas"), tx_field(tx, "maxFeePerGas"))
    {
        return Ok((prio.to_string(), max.to_string()));
    }
    let priority = match forward_to_node("eth_maxPriorityFeePerGas", &[]).await {
        Ok(v) => v.as_str().map(str::to_string).unwrap_or_else(|| "0x3b9aca00".into()),
        Err(_) => "0x3b9aca00".to_string(), // 1 gwei
    };
    let priority_wei = hex_to_u128(&priority)?;
    let block = forward_to_node("eth_getBlockByNumber", &[json!("pending"), json!(false)]).await?;
    let base_wei = block
        .get("baseFeePerGas")
        .and_then(|v| v.as_str())
        .ok_or("chain has no baseFeePerGas (pre-EIP-1559 chain not supported)")?;
    let base_wei = hex_to_u128(base_wei)?;
    let max_fee = base_wei.saturating_mul(2).saturating_add(priority_wei);
    Ok((format!("0x{priority_wei:x}"), format!("0x{max_fee:x}")))
}

/// Build, sign (Rust-side, with the active vault key), and broadcast an EIP-1559
/// transaction. Missing fields (nonce/gas/fees) are filled from the chain node.
/// Returns the broadcast tx hash from `eth_sendRawTransaction`.
async fn build_send_transaction(tx: &Value) -> Result<Value, String> {
    use eth_tx::{parse_address, parse_data, parse_quantity, Eip1559Tx};

    let from = active_account_address().ok_or("wallet is locked")?;
    if let Some(req_from) = tx_field(tx, "from") {
        if !req_from.eq_ignore_ascii_case(&from) {
            return Err(format!(
                "transaction 'from' {req_from} is not the active account {from}"
            ));
        }
    }

    let chain_id_hex = current_chain().lock().unwrap().clone();
    let to_hex = tx_field(tx, "to").unwrap_or("");
    let value_hex = tx_field(tx, "value").unwrap_or("0x0");
    let data_hex = tx_field(tx, "data").or_else(|| tx_field(tx, "input")).unwrap_or("0x");

    let nonce_hex = match tx_field(tx, "nonce") {
        Some(n) => n.to_string(),
        None => forward_to_node("eth_getTransactionCount", &[json!(from), json!("pending")])
            .await?
            .as_str()
            .ok_or("node returned a non-string nonce")?
            .to_string(),
    };

    let gas_hex = match tx_field(tx, "gas") {
        Some(g) => g.to_string(),
        None => {
            let call = json!({ "from": from, "to": to_hex, "value": value_hex, "data": data_hex });
            forward_to_node("eth_estimateGas", &[call])
                .await?
                .as_str()
                .ok_or("node returned a non-string gas estimate")?
                .to_string()
        }
    };

    let (priority_hex, max_fee_hex) = resolve_fees(tx).await?;

    let tx1559 = Eip1559Tx {
        chain_id: parse_quantity(&chain_id_hex)?,
        nonce: parse_quantity(&nonce_hex)?,
        max_priority_fee_per_gas: parse_quantity(&priority_hex)?,
        max_fee_per_gas: parse_quantity(&max_fee_hex)?,
        gas_limit: parse_quantity(&gas_hex)?,
        to: parse_address(to_hex)?,
        value: parse_quantity(value_hex)?,
        data: parse_data(data_hex)?,
    };

    // Sign Rust-side (software) or on the device (Ledger) — never in a webview.
    let (raw_tx, _local_hash) = match active_signer_kind()? {
        ActiveKind::Local => with_active_key(|k| tx1559.sign(k))??,
        ActiveKind::Ledger(path) => {
            let (r, s, y_parity) = ledger::sign_transaction(&path, &tx1559.unsigned_payload())?;
            tx1559.into_signed(&r, &s, y_parity)
        }
    };
    // Broadcast; the node echoes the canonical transaction hash.
    forward_to_node("eth_sendRawTransaction", &[json!(raw_tx)]).await
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
            let account = active_account_address();
            match handle_wallet_method(method, params, &current, account.as_deref())? {
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
    *current_chain().lock().unwrap() = chain.id.clone();
    push_chain_changed(&app, &chain.id);
    Ok(())
}

/// The active wallet network as a 0x-hex chain id (for the shell's chain selector).
#[tauri::command]
fn get_active_chain() -> String {
    current_chain().lock().unwrap().clone()
}

// ---------------------------------------------------------------------------
// Chain registry CRUD (Settings → manage networks). Shell-only. Built-in chains
// can be edited (rpc/name/symbol) but not removed; user chains are full CRUD. The
// effective list is persisted (non-sensitive) to chains.json in the app-data dir.
// ---------------------------------------------------------------------------

const CHAINS_FILE: &str = "chains.json";

fn chains_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(CHAINS_FILE))
}

/// Load the persisted chain list (built-ins + user edits) at startup, if present.
fn load_chains<R: Runtime>(app: &AppHandle<R>) {
    let Ok(path) = chains_path(app) else { return };
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(list) = serde_json::from_slice::<Vec<ChainCfg>>(&bytes) {
            if !list.is_empty() {
                *chains_state().lock().unwrap() = list;
            }
        }
    }
}

fn save_chains<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let path = chains_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let list = chains_state().lock().unwrap().clone();
    let json = serde_json::to_vec_pretty(&list).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("writing chains: {e}"))
}

/// Normalize a chain id (accept "0x.." or decimal) to canonical lowercase 0x-hex.
fn normalize_chain_id(id: &str) -> Result<String, String> {
    let s = id.trim();
    let value = match s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        Some(h) => u64::from_str_radix(h, 16).map_err(|_| format!("invalid chain id '{id}'"))?,
        None => s.parse::<u64>().map_err(|_| format!("invalid chain id '{id}'"))?,
    };
    if value == 0 {
        return Err("chain id must be non-zero".to_string());
    }
    Ok(format!("0x{value:x}"))
}

fn validate_rpc(rpc: &str) -> Result<(), String> {
    if rpc.starts_with("http://") || rpc.starts_with("https://") {
        Ok(())
    } else {
        Err("RPC URL must start with http:// or https://".to_string())
    }
}

/// The full effective chain registry (for the shell's network list + selectors).
#[tauri::command]
fn get_chains() -> Vec<ChainCfg> {
    chains_state().lock().unwrap().clone()
}

/// Add a custom network. Validates id/RPC, rejects duplicates, persists.
#[tauri::command]
fn add_chain<R: Runtime>(app: AppHandle<R>, mut chain: ChainCfg) -> Result<Vec<ChainCfg>, String> {
    chain.id = normalize_chain_id(&chain.id)?;
    if chain.name.trim().is_empty() {
        return Err("network name is required".to_string());
    }
    validate_rpc(&chain.rpc)?;
    chain.builtin = false;
    if chain.decimals == 0 {
        chain.decimals = 18;
    }
    if chain.symbol.trim().is_empty() {
        chain.symbol = "ETH".to_string();
    }
    if chain.color.trim().is_empty() {
        chain.color = "#6b7280".to_string();
    }
    {
        let mut chains = chains_state().lock().unwrap();
        if chains.iter().any(|c| c.id.eq_ignore_ascii_case(&chain.id)) {
            return Err(format!("network {} already exists", chain.id));
        }
        chains.push(chain);
    }
    save_chains(&app)?;
    Ok(chains_state().lock().unwrap().clone())
}

/// Edit an existing network's params (id + builtin flag are preserved).
#[tauri::command]
fn update_chain<R: Runtime>(app: AppHandle<R>, chain: ChainCfg) -> Result<Vec<ChainCfg>, String> {
    let id = normalize_chain_id(&chain.id)?;
    if chain.name.trim().is_empty() {
        return Err("network name is required".to_string());
    }
    validate_rpc(&chain.rpc)?;
    {
        let mut chains = chains_state().lock().unwrap();
        let existing = chains
            .iter_mut()
            .find(|c| c.id.eq_ignore_ascii_case(&id))
            .ok_or_else(|| format!("network {id} not found"))?;
        existing.name = chain.name;
        existing.rpc = chain.rpc;
        existing.decimals = if chain.decimals == 0 { 18 } else { chain.decimals };
        if !chain.symbol.trim().is_empty() {
            existing.symbol = chain.symbol;
        }
        if !chain.color.trim().is_empty() {
            existing.color = chain.color;
        }
    }
    save_chains(&app)?;
    Ok(chains_state().lock().unwrap().clone())
}

/// Remove a user-added network (built-ins can't be removed). Falls the active
/// chain back to the first network if the removed one was active.
#[tauri::command]
fn remove_chain<R: Runtime>(app: AppHandle<R>, id: String) -> Result<Vec<ChainCfg>, String> {
    let id = normalize_chain_id(&id)?;
    {
        let mut chains = chains_state().lock().unwrap();
        let target = chains
            .iter()
            .find(|c| c.id.eq_ignore_ascii_case(&id))
            .ok_or_else(|| format!("network {id} not found"))?;
        if target.builtin {
            return Err("built-in networks can't be removed".to_string());
        }
        chains.retain(|c| !c.id.eq_ignore_ascii_case(&id));
    }
    let fallback = chains_state().lock().unwrap().first().map(|c| c.id.clone());
    {
        let mut cur = current_chain().lock().unwrap();
        if cur.eq_ignore_ascii_case(&id) {
            if let Some(f) = fallback {
                *cur = f;
            }
        }
    }
    save_chains(&app)?;
    Ok(chains_state().lock().unwrap().clone())
}

// ---------------------------------------------------------------------------
// Vault commands (shell-only).
//
// These take the user's password (typed into the TRUSTED shell UI) and manage the
// encrypted keystore. They are granted ONLY to the shell webview (default.json +
// permissions/vault.toml) — a dApp can never reach them, so a page can't create,
// unlock, or read the wallet. The keystore file lives in the OS app-data dir,
// NEVER in the repo (密钥安全).
// ---------------------------------------------------------------------------

const KEYSTORE_FILE: &str = "vault.json";

fn keystore_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(KEYSTORE_FILE))
}

fn read_keystore(path: &Path) -> Result<Option<vault::Keystore>, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(
            serde_json::from_slice(&bytes).map_err(|e| format!("corrupt keystore: {e}"))?,
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("reading keystore: {e}")),
    }
}

fn write_keystore(path: &Path, ks: &vault::Keystore) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("creating app dir: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(ks).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("writing keystore: {e}"))
}

#[derive(Serialize)]
struct VaultStatus {
    /// A keystore file exists on disk.
    exists: bool,
    /// The wallet is unlocked in memory this session.
    unlocked: bool,
    /// The active address (when unlocked) or the first stored address (when locked,
    /// for display), if any.
    address: Option<String>,
    /// All unlocked account addresses (empty when locked).
    accounts: Vec<String>,
    /// Index of the active account among `accounts`.
    active: usize,
    /// Secret kind of the on-disk wallet: "hd" | "privkey" | "ledger" (None if absent).
    /// The shell uses this to skip the password unlock for a Ledger wallet.
    kind: Option<String>,
}

/// Newly created wallet — returns the mnemonic ONCE so the trusted shell can show
/// the backup screen. (The dApp boundary never sees this; vault commands are
/// shell-only.)
#[derive(Serialize)]
struct NewVault {
    address: String,
    mnemonic: String,
}

/// Whether a vault exists / is unlocked, plus the visible address(es).
#[tauri::command]
fn vault_status<R: Runtime>(app: AppHandle<R>) -> Result<VaultStatus, String> {
    let on_disk = read_keystore(&keystore_path(&app)?)?;
    let guard = vault_state().lock().unwrap();
    let unlocked = guard.as_ref();
    let address = unlocked
        .and_then(|v| v.accounts.get(v.active))
        .map(|a| a.address.clone())
        .or_else(|| {
            on_disk
                .as_ref()
                .and_then(|k| k.accounts.first())
                .map(|a| a.address.clone())
        });
    Ok(VaultStatus {
        exists: on_disk.is_some(),
        unlocked: unlocked.is_some(),
        address,
        accounts: unlocked
            .map(|v| v.accounts.iter().map(|a| a.address.clone()).collect())
            .unwrap_or_default(),
        active: unlocked.map(|v| v.active).unwrap_or(0),
        kind: on_disk.as_ref().map(|k| k.kind.clone()),
    })
}

/// Create a brand-new wallet: generate a mnemonic, seal it under `password`, write
/// the keystore, and unlock it in memory. Refuses to overwrite an existing vault.
/// Returns the mnemonic for the one-time backup screen.
#[tauri::command]
fn create_vault<R: Runtime>(app: AppHandle<R>, password: String) -> Result<NewVault, String> {
    if password.len() < 8 {
        return Err("password must be at least 8 characters".to_string());
    }
    let path = keystore_path(&app)?;
    if read_keystore(&path)?.is_some() {
        return Err("a wallet already exists".to_string());
    }
    let mnemonic = vault::generate_mnemonic()?;
    let metas = install_unlocked_vault(&mnemonic, 1)?;
    let ks = vault::seal(&password, &mnemonic, "hd", metas)?;
    write_keystore(&path, &ks)?;
    let address = active_account_address().ok_or("vault install failed")?;
    Ok(NewVault { address, mnemonic })
}

/// Import an existing wallet from a recovery phrase, seal it under `password`, and
/// unlock it. Refuses to overwrite an existing vault. Returns the active address.
#[tauri::command]
fn import_vault<R: Runtime>(
    app: AppHandle<R>,
    password: String,
    mnemonic: String,
) -> Result<String, String> {
    if password.len() < 8 {
        return Err("password must be at least 8 characters".to_string());
    }
    vault::validate_mnemonic(&mnemonic)?;
    let path = keystore_path(&app)?;
    if read_keystore(&path)?.is_some() {
        return Err("a wallet already exists".to_string());
    }
    let metas = install_unlocked_vault(&mnemonic, 1)?;
    let ks = vault::seal(&password, &mnemonic, "hd", metas)?;
    write_keystore(&path, &ks)?;
    active_account_address().ok_or_else(|| "vault install failed".to_string())
}

/// Import an existing wallet from a single raw private key (the "导入私钥"
/// onboarding path), seal it under `password`, and unlock it. Refuses to overwrite
/// an existing vault. Returns the active address. The resulting vault is single-
/// account (no mnemonic to derive from).
#[tauri::command]
fn import_private_key<R: Runtime>(
    app: AppHandle<R>,
    password: String,
    private_key: String,
) -> Result<String, String> {
    if password.len() < 8 {
        return Err("password must be at least 8 characters".to_string());
    }
    // Validate + canonicalize to 0x-lowercase-hex before sealing, so unlock
    // re-derives the same address deterministically.
    let key = vault::parse_private_key(&private_key)?;
    let key_hex = Zeroizing::new(format!("0x{}", hex::encode(key.to_bytes())));
    let path = keystore_path(&app)?;
    if read_keystore(&path)?.is_some() {
        return Err("a wallet already exists".to_string());
    }
    let metas = install_privkey_vault(&key_hex)?;
    let ks = vault::seal(&password, &key_hex, "privkey", metas)?;
    write_keystore(&path, &ks)?;
    active_account_address().ok_or_else(|| "vault install failed".to_string())
}

/// Unlock the on-disk vault with `password`. A wrong password fails the AEAD tag
/// check and surfaces as "incorrect password". Returns the active address. A Ledger
/// keystore has no secret, so it "unlocks" with no password — its addresses are
/// public; signing still requires the device.
#[tauri::command]
fn unlock_vault<R: Runtime>(app: AppHandle<R>, password: String) -> Result<String, String> {
    let ks = read_keystore(&keystore_path(&app)?)?.ok_or("no wallet to unlock")?;
    if ks.kind == "ledger" {
        return install_ledger_vault_from_keystore(&ks);
    }
    let secret = vault::open(&password, &ks)?;
    // "privkey" vaults install the single imported key; everything else (incl.
    // legacy keystores with no `kind`, defaulted to "hd") walks the HD path.
    let metas = if ks.kind == "privkey" {
        install_privkey_vault(&secret)?
    } else {
        install_unlocked_vault(&secret, ks.accounts.len().max(1) as u32)?
    };
    // Integrity: the addresses we just derived must match what the keystore recorded.
    for (got, want) in metas.iter().zip(ks.accounts.iter()) {
        if got.address != want.address {
            *vault_state().lock().unwrap() = None;
            return Err("keystore integrity check failed".to_string());
        }
    }
    active_account_address().ok_or_else(|| "unlock failed".to_string())
}

/// Lock the wallet: drop all decrypted key material from memory.
#[tauri::command]
fn lock_vault() {
    *vault_state().lock().unwrap() = None;
}

/// Reset the wallet: drop in-memory keys AND delete the on-disk keystore, so the
/// app returns to first-run onboarding. This is the "忘记密码" escape hatch — it is
/// IRREVERSIBLE and destroys the only copy of the encrypted secret, so the UI must
/// gate it behind an explicit, clearly-worded confirmation (funds are unrecoverable
/// without the user's own mnemonic/key backup).
#[tauri::command]
fn reset_vault<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    *vault_state().lock().unwrap() = None;
    let path = keystore_path(&app)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("removing keystore: {e}")),
    }
}

/// One Ledger account candidate for the onboarding picker.
#[derive(Serialize)]
struct LedgerAccount {
    index: u32,
    path: String,
    address: String,
}

/// List addresses from a connected Ledger (Ledger Live path `m/44'/60'/index'/0/0`)
/// for `count` accounts starting at `start`. Requires the device unlocked with the
/// Ethereum app open. No on-device confirmation (read-only address query).
#[tauri::command]
fn ledger_addresses(start: u32, count: u32) -> Result<Vec<LedgerAccount>, String> {
    let count = count.clamp(1, 10);
    let indices: Vec<u32> = (start..start.saturating_add(count)).collect();
    let rows = ledger::get_addresses(&indices)?;
    Ok(rows
        .into_iter()
        .map(|(index, path, address)| LedgerAccount { index, path, address })
        .collect())
}

/// Connect a Ledger account at `path` as THE wallet: re-read its address from the
/// device, install it as the (no-password) unlocked vault, and persist a Ledger
/// keystore (path + address; no secret at rest). Refuses to overwrite an existing
/// wallet. Returns the address.
#[tauri::command]
fn connect_ledger<R: Runtime>(app: AppHandle<R>, path: String) -> Result<String, String> {
    let kpath = keystore_path(&app)?;
    if read_keystore(&kpath)?.is_some() {
        return Err("a wallet already exists".to_string());
    }
    let address = ledger::get_address(&path)?;
    let metas = install_ledger_vault(&path, &address)?;
    let ks = vault::ledger_keystore(&path, metas);
    write_keystore(&kpath, &ks)?;
    Ok(address)
}

/// Switch the active account (feature ①: 切换钱包地址). Pushes EIP-1193
/// `accountsChanged` to open dApps. Returns the new active address.
#[tauri::command]
fn select_account<R: Runtime>(app: AppHandle<R>, index: usize) -> Result<String, String> {
    let address = {
        let mut guard = vault_state().lock().unwrap();
        let v = guard.as_mut().ok_or("wallet is locked")?;
        if index >= v.accounts.len() {
            return Err(format!("account index {index} out of range"));
        }
        v.active = index;
        v.accounts[index].address.clone()
    };
    push_accounts_changed(&app, Some(&address));
    Ok(address)
}

/// Derive the next HD account, persist it to the keystore's (plaintext) account
/// list, and return its address. The encrypted mnemonic is unchanged, so no
/// password is needed to add an account.
#[tauri::command]
fn add_account<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let (address, metas) = {
        let mut guard = vault_state().lock().unwrap();
        let v = guard.as_mut().ok_or("wallet is locked")?;
        let mnemonic = match &v.secret {
            VaultSecret::Mnemonic(m) => m.clone(),
            VaultSecret::PrivateKey => {
                return Err("imported private-key wallets can't derive more accounts".to_string())
            }
            VaultSecret::Ledger => {
                return Err("Ledger accounts are added by connecting the device".to_string())
            }
        };
        let next_index = v.accounts.iter().map(|a| a.index).max().map_or(0, |m| m + 1);
        let (key, address) = vault::derive_account(&mnemonic, next_index)?;
        v.accounts.push(UnlockedAccount {
            index: next_index,
            address: address.clone(),
            signer: Signer::Local(key),
        });
        let metas = v
            .accounts
            .iter()
            .map(|a| vault::AccountMeta { index: a.index, address: a.address.clone() })
            .collect::<Vec<_>>();
        (address, metas)
    };
    // Persist the grown account list (public metadata only — ciphertext untouched).
    let path = keystore_path(&app)?;
    if let Some(mut ks) = read_keystore(&path)? {
        ks.accounts = metas;
        write_keystore(&path, &ks)?;
    }
    Ok(address)
}

/// Push an EIP-1193 `accountsChanged` to every open dApp tab (same eval-push
/// mechanism as `chainChanged`, so dApps keep ONLY allow-wallet-request).
fn push_accounts_changed<R: Runtime>(app: &AppHandle<R>, address: Option<&str>) {
    let accounts = address.map(|a| vec![a]).unwrap_or_default();
    let payload = serde_json::to_string(&accounts).unwrap_or_else(|_| "[]".into());
    let js = format!("window.__autoWalletPush && window.__autoWalletPush('accountsChanged', {payload});");
    for (label, webview) in app.webviews() {
        if label.starts_with("dapp-") {
            let _ = webview.eval(js.clone());
        }
    }
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
            get_active_chain,
            get_chains,
            add_chain,
            update_chain,
            remove_chain,
            vault_status,
            create_vault,
            import_vault,
            import_private_key,
            unlock_vault,
            lock_vault,
            reset_vault,
            ledger_addresses,
            connect_ledger,
            select_account,
            add_account
        ])
        .setup(|app| {
            // Load any persisted custom networks / RPC overrides before the UI asks.
            load_chains(app.handle());
            // A Ledger wallet has no secret at rest, so unlock it on boot (path +
            // address are public) — it boots straight to the wallet, no password.
            if let Ok(Some(ks)) = keystore_path(app.handle()).and_then(|p| read_keystore(&p)) {
                if ks.kind == "ledger" {
                    if let Err(e) = install_ledger_vault_from_keystore(&ks) {
                        println!("[AutoDesktop] warn: could not restore Ledger vault: {e}");
                    }
                }
            }
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
        let chains = builtin_chains();
        for c in &chains {
            assert!(c.rpc.starts_with("https://"), "{} has no https rpc", c.name);
            assert_eq!(chains.iter().filter(|x| x.id == c.id).count(), 1);
            assert!(c.builtin);
        }
    }

    #[test]
    fn normalize_chain_id_accepts_hex_and_decimal() {
        assert_eq!(normalize_chain_id("0x1").unwrap(), "0x1");
        assert_eq!(normalize_chain_id("0xA4B1").unwrap(), "0xa4b1"); // lowercased
        assert_eq!(normalize_chain_id("137").unwrap(), "0x89"); // decimal → hex
        assert_eq!(normalize_chain_id("  0x2105 ").unwrap(), "0x2105"); // trimmed
        assert!(normalize_chain_id("0x0").is_err()); // zero rejected
        assert!(normalize_chain_id("xyz").is_err());
    }

    #[test]
    fn validate_rpc_requires_http_scheme() {
        assert!(validate_rpc("https://rpc.example.com").is_ok());
        assert!(validate_rpc("http://localhost:8545").is_ok());
        assert!(validate_rpc("ftp://nope").is_err());
        assert!(validate_rpc("rpc.example.com").is_err());
    }

    #[test]
    fn wallet_accounts_reflect_unlock_state() {
        // Unlocked: report the active account.
        assert_eq!(
            handle_wallet_method("eth_accounts", &[], "0x1", Some(SPIKE_ACCOUNT)).unwrap(),
            WalletOutcome::Reply(json!([SPIKE_ACCOUNT]))
        );
        assert_eq!(
            handle_wallet_method("eth_coinbase", &[], "0x1", Some(SPIKE_ACCOUNT)).unwrap(),
            WalletOutcome::Reply(json!(SPIKE_ACCOUNT))
        );
        // Locked: no account is exposed (dApp shows a connect prompt).
        assert_eq!(
            handle_wallet_method("eth_accounts", &[], "0x1", None).unwrap(),
            WalletOutcome::Reply(json!([]))
        );
        assert_eq!(
            handle_wallet_method("eth_coinbase", &[], "0x1", None).unwrap(),
            WalletOutcome::Reply(Value::Null)
        );
    }

    #[test]
    fn wallet_chain_id_reflects_current() {
        // eth_chainId / net_version reflect the passed-in current chain (account irrelevant).
        assert_eq!(
            handle_wallet_method("eth_chainId", &[], "0x2105", None).unwrap(),
            WalletOutcome::Reply(json!("0x2105"))
        );
        assert_eq!(
            handle_wallet_method("net_version", &[], "0x2105", None).unwrap(),
            WalletOutcome::Reply(json!("8453")) // 0x2105 == 8453
        );
        assert_eq!(
            handle_wallet_method("net_version", &[], "0x89", None).unwrap(),
            WalletOutcome::Reply(json!("137")) // 0x89 == 137
        );
    }

    #[test]
    fn preview_tx_summarizes() {
        // A value transfer reads as "Send N ETH → 0x…", shortening the address.
        let send = json!({
            "to": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
            "value": "0xde0b6b3a7640000" // 1e18 wei = 1 ETH
        });
        let s = preview_tx(&send);
        assert!(s.contains("Send"), "got: {s}");
        assert!(s.contains("1.0000 ETH"), "got: {s}");
        assert!(s.contains("0x7099…79c8"), "got: {s}");

        // A call with data reads as a contract interaction.
        let call = json!({
            "to": "0x1111111111111111111111111111111111111111",
            "data": "0xa9059cbb"
        });
        assert!(preview_tx(&call).contains("Contract interaction"));
    }

    #[test]
    fn switch_known_chain_yields_directive_unknown_errors() {
        let out = handle_wallet_method(
            "wallet_switchEthereumChain",
            &[json!({ "chainId": "0xa4b1" })],
            "0x1",
            None,
        )
        .unwrap();
        assert_eq!(out, WalletOutcome::SwitchChain("0xa4b1".to_string()));

        // unknown target chain is rejected (EIP-3326 4902 territory)
        assert!(handle_wallet_method(
            "wallet_switchEthereumChain",
            &[json!({ "chainId": "0xdead" })],
            "0x1",
            None,
        )
        .is_err());

        // missing chainId param is a hard error, not a silent default
        assert!(handle_wallet_method("wallet_switchEthereumChain", &[], "0x1", None).is_err());
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

    /// Anvil/Hardhat's well-known dev mnemonic — its m/44'/60'/0'/0/0 account is
    /// SPIKE_ACCOUNT (the publicly-known Anvil #0). NOT a real secret. The
    /// `wallet_guard` unlocks the test vault with it so account/signing tests sign
    /// with a deterministic, recoverable key.
    const TEST_MNEMONIC: &str = "test test test test test test test test test test test junk";

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
                get_active_chain,
                get_chains,
                add_chain,
                update_chain,
                remove_chain,
                vault_status,
                create_vault,
                import_vault,
                import_private_key,
                unlock_vault,
                lock_vault,
                reset_vault,
                ledger_addresses,
                connect_ledger,
                select_account,
                add_account
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

    /// Serialize every test that touches process-global wallet state and reset to a
    /// known baseline: pending registry cleared, chain = Ethereum, and the vault
    /// unlocked with the Anvil dev mnemonic (2 derived accounts). Returning the guard
    /// keeps these tests from racing on the shared statics.
    fn wallet_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        let g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        pending().lock().unwrap().clear();
        *current_chain().lock().unwrap() = "0x1".into();
        super::install_unlocked_vault(TEST_MNEMONIC, 2).expect("unlock test vault");
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
        let _guard = wallet_guard(); // unlocked vault + chain=0x1, serialized
        let wv = dapp_webview(build_app());

        // Wallet-routed reads come back through the full invoke→command→handler path.
        // eth_accounts now returns the UNLOCKED vault's active account (Anvil #0).
        assert_eq!(call(&wv, "eth_accounts", json!([])).unwrap(), json!([SPIKE_ACCOUNT]));
        assert_eq!(call(&wv, "eth_chainId", json!([])).unwrap(), json!("0x1"));
        assert_eq!(call(&wv, "net_version", json!([])).unwrap(), json!("1"));

        // A still-unimplemented signing method (eth_signTypedData_v3) is rejected
        // up-front (no approval window, returns immediately). personal_sign,
        // eth_sendTransaction and eth_signTypedData_v4 (which DO prompt) are covered
        // separately.
        let err = call(&wv, "eth_signTypedData_v3", json!([SPIKE_ACCOUNT, "{}"])).unwrap_err();
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
    }

    /// A LOCKED wallet exposes no account and refuses to sign UP-FRONT — no approval
    /// window opens, so the call returns immediately. Guarded so it can lock the
    /// shared vault without racing other state-touching tests.
    #[test]
    fn e2e_locked_wallet_has_no_account_and_refuses_signing() {
        let _guard = wallet_guard();
        super::lock_vault(); // drop all decrypted keys from memory
        let wv = dapp_webview(build_app());

        // No account is exposed to dApps when locked.
        assert_eq!(call(&wv, "eth_accounts", json!([])).unwrap(), json!([]));
        assert_eq!(call(&wv, "eth_coinbase", json!([])).unwrap(), Value::Null);

        // personal_sign is rejected immediately with a "locked" error — BEFORE any
        // approval, so no worker thread / approval webview is needed here.
        let err = call(&wv, "personal_sign", json!(["0x48656c6c6f", SPIKE_ACCOUNT])).unwrap_err();
        assert!(
            err.as_str().unwrap_or_default().contains("locked"),
            "expected a locked error, got: {err}"
        );
    }

    /// An imported single private key behaves as a one-account wallet that exposes
    /// exactly that address — and refuses `add_account` loudly (no mnemonic to walk,
    /// so deriving a "next" account would be meaningless). Pure in-memory: never
    /// touches the on-disk keystore (which resolves to the real user dir).
    #[test]
    fn e2e_privkey_vault_is_single_account_and_refuses_add() {
        let _guard = wallet_guard();
        // Anvil #0's well-known key → Anvil #0's address (SPIKE_ACCOUNT). NOT a secret.
        super::install_privkey_vault(
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        )
        .expect("install privkey vault");

        let app = build_app();
        let wv = dapp_webview(app);
        assert_eq!(call(&wv, "eth_accounts", json!([])).unwrap(), json!([SPIKE_ACCOUNT]));

        // add_account returns its refusal BEFORE any keystore I/O, so this stays
        // disk-free. The error must name the real cause, not a silent no-op.
        let err = super::add_account(app.handle().clone()).unwrap_err();
        assert!(
            err.contains("can't derive"),
            "expected a 'can't derive more accounts' refusal, got: {err}"
        );
    }

    /// A Ledger account exposes its address to dApps WITHOUT any in-process key, and
    /// the software-signing path refuses it (signing must go to the device). Pure
    /// in-memory: no device, no disk. Asserts the account is wired but unsignable
    /// locally — proving the dispatch, not faking a hardware signature.
    #[test]
    fn e2e_ledger_vault_exposes_address_but_has_no_local_key() {
        let _guard = wallet_guard();
        let ledger_addr = "0x1111111111111111111111111111111111111111";
        super::install_ledger_vault("m/44'/60'/0'/0/0", ledger_addr).expect("install ledger vault");

        let wv = dapp_webview(build_app());
        // The device address is exposed to dApps exactly like a software account.
        assert_eq!(call(&wv, "eth_accounts", json!([])).unwrap(), json!([ledger_addr]));

        // There is NO in-process key: the software-signing path must refuse loudly
        // (the real signing path routes to the device, which needs hardware).
        let err = super::with_active_key(|_| ()).unwrap_err();
        assert!(
            err.contains("Ledger"),
            "expected a 'sign on the device' refusal, got: {err}"
        );

        // And the active-signer snapshot reports the Ledger path for the device path.
        match super::active_signer_kind().unwrap() {
            super::ActiveKind::Ledger(path) => assert_eq!(path, "m/44'/60'/0'/0/0"),
            super::ActiveKind::Local => panic!("expected a Ledger active signer"),
        }
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
        let _guard = wallet_guard();
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
        let _guard = wallet_guard();
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

    /// eth_signTypedData_v4 end-to-end through the approval flow (OFFLINE — EIP-712
    /// is pure). The returned signature must recover, over the EIP-712 digest, to the
    /// unlocked signer — proving the typed-data hashing + approve→sign path.
    #[test]
    fn e2e_sign_typed_data_v4_approve() {
        let _guard = wallet_guard();
        let app = build_app();
        let dapp = dapp_webview(app);
        let approval = approval_webview(app);

        let typed = json!({
            "types": {
                "EIP712Domain": [
                    {"name": "name", "type": "string"},
                    {"name": "version", "type": "string"},
                    {"name": "chainId", "type": "uint256"},
                    {"name": "verifyingContract", "type": "address"}
                ],
                "Person": [
                    {"name": "name", "type": "string"},
                    {"name": "wallet", "type": "address"}
                ],
                "Mail": [
                    {"name": "from", "type": "Person"},
                    {"name": "to", "type": "Person"},
                    {"name": "contents", "type": "string"}
                ]
            },
            "primaryType": "Mail",
            "domain": {
                "name": "Ether Mail", "version": "1", "chainId": 1,
                "verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
            },
            "message": {
                "from": {"name": "Cow", "wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"},
                "to": {"name": "Bob", "wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"},
                "contents": "Hello, Bob!"
            }
        });
        let typed_str = serde_json::to_string(&typed).unwrap();

        let dapp_for_thread = dapp.clone();
        let signer = std::thread::spawn(move || {
            call(&dapp_for_thread, "eth_signTypedData_v4", json!([SPIKE_ACCOUNT, typed_str]))
        });

        let id = wait_for_pending_id();
        // The approval window shows a typed-data summary.
        let pending = invoke(&approval, "get_pending_requests", json!({})).unwrap();
        assert_eq!(pending[0]["summary"], json!("Sign Mail for Ether Mail"));
        invoke(&approval, "approve_request", json!({ "id": id })).expect("approve ok");

        let sig = signer.join().unwrap().expect("signature returned");
        let raw = hex::decode(sig.as_str().unwrap().trim_start_matches("0x")).unwrap();
        assert_eq!(raw.len(), 65, "EIP-712 signature must be 65 bytes");

        // Recover over the EIP-712 digest → must be the unlocked signer (Anvil #0).
        let digest = eip712::signing_hash(&typed).unwrap();
        let signature = k256::ecdsa::Signature::from_slice(&raw[..64]).unwrap();
        let recid = k256::ecdsa::RecoveryId::from_byte(raw[64] - 27).unwrap();
        let vk = VerifyingKey::recover_from_prehash(&digest, &signature, recid).unwrap();
        assert_eq!(
            address_from_verifying_key(&vk).to_lowercase(),
            SPIKE_ACCOUNT.to_lowercase()
        );
    }

    /// eth_sendTransaction end-to-end against a LIVE node. All fields are supplied
    /// (with a deliberately low nonce so the node rejects WITHOUT broadcasting), so
    /// only eth_sendRawTransaction hits the node — exactly the path that proves our
    /// RLP + signature are valid on-chain. A "nonce too low" / "insufficient funds"
    /// rejection happens only AFTER the node decoded the tx and recovered the
    /// sender from the signature, so it proves correctness; a decode/RLP/sender
    /// error never gets that far.
    #[test]
    #[ignore = "broadcasts to a live public RPC node; run with `cargo test -- --ignored`"]
    fn e2e_send_transaction_live() {
        let _guard = wallet_guard(); // unlocked Anvil vault, chain 0x1
        let app = build_app();
        let dapp = dapp_webview(app);
        let approval = approval_webview(app);

        let tx = json!([{
            "from": SPIKE_ACCOUNT,
            "to": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
            "value": "0x0",
            "gas": "0x5208",
            "maxPriorityFeePerGas": "0x3b9aca00", // 1 gwei
            "maxFeePerGas": "0x77359400",         // 2 gwei
            "nonce": "0x0"
        }]);

        let dapp_for_thread = dapp.clone();
        let sender = std::thread::spawn(move || call(&dapp_for_thread, "eth_sendTransaction", tx));

        let id = wait_for_pending_id();
        invoke(&approval, "approve_request", json!({ "id": id })).expect("approve ok");

        match sender.join().unwrap() {
            // A funded sender at the right nonce would actually broadcast → tx hash.
            Ok(hash) => assert!(hash.as_str().unwrap_or("").starts_with("0x")),
            Err(e) => {
                let msg = e.as_str().unwrap_or("").to_lowercase();
                // These all occur AFTER the node decoded the tx and recovered the
                // sender (nonce / funds / fee checks) — they prove valid encoding.
                let post_decode = msg.contains("nonce")
                    || msg.contains("insufficient funds")
                    || msg.contains("balance")
                    || msg.contains("fee")
                    || msg.contains("underpriced");
                // A decode/signature failure would surface as one of these instead.
                let encoding_error = msg.contains("rlp")
                    || msg.contains("decode")
                    || msg.contains("invalid sender")
                    || msg.contains("typed transaction")
                    || msg.contains("malformed");
                assert!(
                    post_decode && !encoding_error,
                    "node rejected for an ENCODING reason, not a post-decode check: {msg}"
                );
            }
        }
    }

    /// SECURITY: the dapp webview must NOT be able to approve requests — the ACL
    /// grants approve_request only to the "approval" webview. A page calling it
    /// (e.g. to self-approve) is denied by Tauri before reaching our handler.
    #[test]
    fn e2e_dapp_cannot_approve() {
        let _guard = wallet_guard();
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
