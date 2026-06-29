use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use tauri::menu::{Menu, SubmenuBuilder};
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::window::WindowBuilder;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl};

// ---------------------------------------------------------------------------
// Crypto helpers.
// ---------------------------------------------------------------------------
use k256::ecdsa::{SigningKey, VerifyingKey};
use rand_core::OsRng;
use sha3::{Digest, Keccak256};
use zeroize::Zeroizing;

// Encrypted HD key vault (BIP-39/44 + Argon2id/AES-GCM). Pure crypto core; the
// in-memory unlocked state + file I/O + Tauri commands live below in this file.
mod smoke;
mod vault;
// EIP-1559 transaction encoding + signing (pure). eth_sendTransaction fills the
// fields from the node in lib.rs, then builds + signs here.
mod eth_tx;
// EIP-712 typed-data hashing (pure) for eth_signTypedData_v4.
mod eip712;
// Ledger hardware wallet over USB-HID (framing + Ethereum APDUs + hidapi I/O).
mod ledger;

const DEFI_PROVIDER_TIMEOUT: Duration = Duration::from_secs(12);
const DEBUG_SHELL_CONSOLE_MENU_ID: &str = "debug-shell-console";
const DEBUG_DAPP_CONSOLE_MENU_ID: &str = "debug-dapp-console";
const DAPP_LAYOUT_INVALIDATED_EVENT: &str = "dapp-layout-invalidated";

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

/// One unlocked wallet — a single keystore's worth of accounts plus its root
/// secret. The app can hold several at once (multiple seeds / private keys /
/// Ledgers side by side), each identified by a stable `id`.
struct UnlockedWallet {
    id: String,
    label: String,
    secret: VaultSecret,
    accounts: Vec<UnlockedAccount>,
}

impl UnlockedWallet {
    /// On-disk kind tag for this wallet's secret.
    fn kind(&self) -> &'static str {
        match self.secret {
            VaultSecret::Mnemonic(_) => "hd",
            VaultSecret::PrivateKey => "privkey",
            VaultSecret::Ledger => "ledger",
        }
    }
}

/// The decrypted multi-wallet store for this session.
///
/// `password` is the single app password, kept in memory (Zeroizing) while
/// unlocked so a NEW software wallet can be sealed without re-prompting. This is
/// no weaker than holding the decrypted mnemonics, which already live here — the
/// password protects the very secrets already in RAM. `None` when no software
/// wallet exists (a Ledger-only setup has no password). `active` is the active
/// account ADDRESS (lowercase 0x), unique across all wallets.
struct WalletStore {
    password: Option<Zeroizing<String>>,
    wallets: Vec<UnlockedWallet>,
    active: String,
}

#[derive(Clone)]
enum ExposedAccount {
    Signer(String),
    WatchOnly(String),
}

fn store_state() -> &'static Mutex<Option<WalletStore>> {
    static V: OnceLock<Mutex<Option<WalletStore>>> = OnceLock::new();
    V.get_or_init(|| Mutex::new(None))
}

fn exposed_account_state() -> &'static Mutex<Option<ExposedAccount>> {
    static V: OnceLock<Mutex<Option<ExposedAccount>>> = OnceLock::new();
    V.get_or_init(|| Mutex::new(None))
}

/// The active account's address, or `None` when the wallet is locked / empty.
fn active_account_address() -> Option<String> {
    let guard = store_state().lock().unwrap();
    let s = guard.as_ref()?;
    s.wallets
        .iter()
        .flat_map(|w| &w.accounts)
        .find(|a| a.address == s.active)
        .map(|a| a.address.clone())
}

fn normalize_evm_address(address: &str) -> Result<String, String> {
    let trimmed = address.trim();
    let body = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .ok_or_else(|| format!("invalid address {trimmed}: expected 0x prefix"))?;
    if body.len() != 40 || !body.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("invalid address {trimmed}"));
    }
    Ok(format!("0x{}", body.to_ascii_lowercase()))
}

/// The public address exposed through EIP-1193 account reads. Signer addresses
/// still require an unlocked vault; watch-only addresses are public viewing
/// targets and may be exposed without any signing key.
fn dapp_account_address() -> Option<String> {
    match exposed_account_state().lock().unwrap().clone() {
        Some(ExposedAccount::WatchOnly(address)) => Some(address),
        Some(ExposedAccount::Signer(address)) => {
            let active = active_account_address()?;
            (active == address).then_some(address)
        }
        None => active_account_address(),
    }
}

/// Run `f` with the active account's *software* signing key. Errors clearly when
/// locked or when the active account is a Ledger (use the device path instead),
/// rather than silently falling back to any default key.
fn with_active_key<T>(f: impl FnOnce(&SigningKey) -> T) -> Result<T, String> {
    let guard = store_state().lock().unwrap();
    let s = guard.as_ref().ok_or("wallet is locked")?;
    let acct = s
        .wallets
        .iter()
        .flat_map(|w| &w.accounts)
        .find(|a| a.address == s.active)
        .ok_or("no active account")?;
    match &acct.signer {
        Signer::Local(key) => Ok(f(key)),
        Signer::Ledger { .. } => Err("active account is a Ledger — sign on the device".to_string()),
    }
}

/// Snapshot the active account's signing kind (and Ledger path) without holding the
/// store lock during the (slow) device round-trip.
fn active_signer_kind() -> Result<ActiveKind, String> {
    let guard = store_state().lock().unwrap();
    let s = guard.as_ref().ok_or("wallet is locked")?;
    let acct = s
        .wallets
        .iter()
        .flat_map(|w| &w.accounts)
        .find(|a| a.address == s.active)
        .ok_or("no active account")?;
    Ok(match &acct.signer {
        Signer::Local(_) => ActiveKind::Local,
        Signer::Ledger { path } => ActiveKind::Ledger(path.clone()),
    })
}

/// Derive `count` (≥1) HD accounts from `mnemonic` into unlocked accounts + their
/// public metadata (for sealing into the keystore). Pure — touches no global state.
fn derive_hd_accounts(
    mnemonic: &str,
    count: u32,
) -> Result<(Vec<UnlockedAccount>, Vec<vault::AccountMeta>), String> {
    let count = count.max(1);
    let mut accounts = Vec::with_capacity(count as usize);
    let mut metas = Vec::with_capacity(count as usize);
    for index in 0..count {
        let (key, address) = vault::derive_account(mnemonic, index)?;
        metas.push(vault::AccountMeta {
            index,
            address: address.clone(),
        });
        accounts.push(UnlockedAccount {
            index,
            address,
            signer: Signer::Local(key),
        });
    }
    Ok((accounts, metas))
}

/// Build an in-memory HD wallet from a keystore's decrypted mnemonic, deriving each
/// RECORDED account index and checking the address matches (integrity). Consumes the
/// `Zeroizing` mnemonic so it lives on inside the wallet (and nowhere else).
fn build_hd_wallet_from_keystore(
    ks: &vault::Keystore,
    mnemonic: Zeroizing<String>,
) -> Result<UnlockedWallet, String> {
    let mut accounts = Vec::new();
    for meta in &ks.accounts {
        let (key, address) = vault::derive_account(&mnemonic, meta.index)?;
        if address != meta.address {
            return Err("keystore integrity check failed".to_string());
        }
        accounts.push(UnlockedAccount {
            index: meta.index,
            address,
            signer: Signer::Local(key),
        });
    }
    if accounts.is_empty() {
        // A legacy keystore may record no accounts — derive the first.
        let (key, address) = vault::derive_account(&mnemonic, 0)?;
        accounts.push(UnlockedAccount {
            index: 0,
            address,
            signer: Signer::Local(key),
        });
    }
    Ok(UnlockedWallet {
        id: ks.id.clone(),
        label: ks.label.clone(),
        secret: VaultSecret::Mnemonic(mnemonic),
        accounts,
    })
}

/// Build an in-memory single-account wallet from a keystore's decrypted private key.
fn build_privkey_wallet_from_keystore(
    ks: &vault::Keystore,
    privkey_hex: &str,
) -> Result<UnlockedWallet, String> {
    let key = vault::parse_private_key(privkey_hex)?;
    let address = address_from_verifying_key(key.verifying_key());
    if let Some(meta) = ks.accounts.first() {
        if meta.address != address {
            return Err("keystore integrity check failed".to_string());
        }
    }
    Ok(UnlockedWallet {
        id: ks.id.clone(),
        label: ks.label.clone(),
        secret: VaultSecret::PrivateKey,
        accounts: vec![UnlockedAccount {
            index: 0,
            address,
            signer: Signer::Local(key),
        }],
    })
}

/// Build an in-memory Ledger wallet from its keystore (path + public address only —
/// no in-process key; signing goes to the device).
fn build_ledger_wallet_from_keystore(ks: &vault::Keystore) -> Result<UnlockedWallet, String> {
    let path = ks
        .path
        .as_deref()
        .ok_or("ledger keystore missing derivation path")?;
    let address = ks
        .accounts
        .first()
        .map(|a| a.address.clone())
        .ok_or("ledger keystore has no account")?;
    Ok(UnlockedWallet {
        id: ks.id.clone(),
        label: ks.label.clone(),
        secret: VaultSecret::Ledger,
        accounts: vec![UnlockedAccount {
            index: 0,
            address,
            signer: Signer::Ledger {
                path: path.to_string(),
            },
        }],
    })
}

/// Push a freshly-built wallet into the session store (creating the store if it was
/// locked/absent), make its first account active, and — when adding the first
/// software wallet — record the app password. Returns the new active address.
fn store_push_wallet(wallet: UnlockedWallet, password: Option<Zeroizing<String>>) -> String {
    let first = wallet
        .accounts
        .first()
        .map(|a| a.address.clone())
        .unwrap_or_default();
    let mut guard = store_state().lock().unwrap();
    match guard.as_mut() {
        Some(store) => {
            if password.is_some() {
                store.password = password;
            }
            store.wallets.push(wallet);
            store.active = first.clone();
        }
        None => {
            *guard = Some(WalletStore {
                password,
                wallets: vec![wallet],
                active: first.clone(),
            });
        }
    }
    if !first.is_empty() {
        *exposed_account_state().lock().unwrap() = Some(ExposedAccount::Signer(first.clone()));
    }
    first
}

/// Install a single freshly-derived HD wallet as THE session store (test helper —
/// resets any existing store; production paths ADD wallets via `store_push_wallet`).
#[cfg(test)]
fn install_unlocked_vault(mnemonic: &str, count: u32) -> Result<Vec<vault::AccountMeta>, String> {
    let (accounts, metas) = derive_hd_accounts(mnemonic, count)?;
    let active = accounts
        .first()
        .map(|a| a.address.clone())
        .unwrap_or_default();
    *store_state().lock().unwrap() = Some(WalletStore {
        password: None,
        wallets: vec![UnlockedWallet {
            id: "w-hd".to_string(),
            label: "Wallet 1".to_string(),
            secret: VaultSecret::Mnemonic(Zeroizing::new(mnemonic.to_string())),
            accounts,
        }],
        active,
    });
    Ok(metas)
}

/// Install a single imported private key as THE session store (test helper).
#[cfg(test)]
fn install_privkey_vault(privkey_hex: &str) -> Result<Vec<vault::AccountMeta>, String> {
    let key = vault::parse_private_key(privkey_hex)?;
    let address = address_from_verifying_key(key.verifying_key());
    let metas = vec![vault::AccountMeta {
        index: 0,
        address: address.clone(),
    }];
    *store_state().lock().unwrap() = Some(WalletStore {
        password: None,
        wallets: vec![UnlockedWallet {
            id: "w-privkey".to_string(),
            label: "Wallet 1".to_string(),
            secret: VaultSecret::PrivateKey,
            accounts: vec![UnlockedAccount {
                index: 0,
                address: address.clone(),
                signer: Signer::Local(key),
            }],
        }],
        active: address,
    });
    Ok(metas)
}

/// Install a single Ledger account as THE session store (test helper).
#[cfg(test)]
fn install_ledger_vault(path: &str, address: &str) -> Result<Vec<vault::AccountMeta>, String> {
    let metas = vec![vault::AccountMeta {
        index: 0,
        address: address.to_string(),
    }];
    *store_state().lock().unwrap() = Some(WalletStore {
        password: None,
        wallets: vec![UnlockedWallet {
            id: "w-ledger".to_string(),
            label: "Wallet 1".to_string(),
            secret: VaultSecret::Ledger,
            accounts: vec![UnlockedAccount {
                index: 0,
                address: address.to_string(),
                signer: Signer::Ledger {
                    path: path.to_string(),
                },
            }],
        }],
        active: address.to_string(),
    });
    Ok(metas)
}

/// Decode a `personal_sign` message param. dApps usually send 0x-hex; some send a
/// raw UTF-8 string. EIP-191 hashes the *bytes*, so we just need the byte form.
fn decode_message_param(param: &Value) -> Result<Vec<u8>, String> {
    let s = param
        .as_str()
        .ok_or("personal_sign: message param must be a string")?;
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct ChainCfg {
    /// EIP-155 chain id as a 0x-hex string (what dApps see via `eth_chainId`).
    id: String,
    name: String,
    symbol: String,
    rpc: String,
    decimals: u32,
    /// Brand color for the chain dot (frontend display).
    color: String,
    #[serde(
        default,
        rename = "explorerUrl",
        skip_serializing_if = "Option::is_none"
    )]
    explorer_url: Option<String>,
    /// Built-in chains can be edited (rpc/name/symbol) but not removed.
    builtin: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivityRecord {
    id: String,
    hash: String,
    chain_id: String,
    chain_name: String,
    symbol: String,
    from: String,
    to: String,
    value: String,
    data: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    gas: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    nonce: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    max_priority_fee_per_gas: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    max_fee_per_gas: String,
    origin: String,
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    counterparty: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    asset_symbol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    asset_decimals: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    amount: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token_address: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    balance_changes: Vec<ActivityBalanceChange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    timestamp: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivityBalanceChange {
    symbol: String,
    formatted_delta: String,
    direction: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortfolioSnapshot {
    address: String,
    total_usd: f64,
    timestamp: u64,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    current_version: String,
    latest_version: String,
    available: bool,
    release_url: String,
    download_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DefiPositionToken {
    symbol: String,
    balance: Option<String>,
    balance_usd: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DefiPosition {
    id: String,
    app_name: String,
    app_image_url: Option<String>,
    app_url: Option<String>,
    network_name: String,
    chain_id: String,
    label: String,
    group_label: Option<String>,
    balance_usd: f64,
    symbols: Vec<String>,
    tokens: Vec<DefiPositionToken>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DefiPositionsResponse {
    source: String,
    positions: Vec<DefiPosition>,
}

fn default_explorer_url(chain_id: &str) -> Option<String> {
    let base = match chain_id.to_lowercase().as_str() {
        "0x1" => "https://etherscan.io/tx/",
        "0x2105" => "https://basescan.org/tx/",
        "0xa" => "https://optimistic.etherscan.io/tx/",
        "0xa4b1" => "https://arbiscan.io/tx/",
        "0x89" => "https://polygonscan.com/tx/",
        "0x38" => "https://bscscan.com/tx/",
        "0xa86a" => "https://snowtrace.io/tx/",
        "0xe708" => "https://lineascan.build/tx/",
        "0x13e31" => "https://blastscan.io/tx/",
        "0x144" => "https://era.zksync.network/tx/",
        "0x44d" => "https://zkevm.polygonscan.com/tx/",
        "0x92" => "https://sonicscan.org/tx/",
        "0xc4" => "https://www.oklink.com/xlayer/tx/",
        "0x1e0" => "https://worldscan.org/tx/",
        "0x250" => "https://astar.subscan.io/evm_transaction/",
        "0x378" => "https://wanscan.org/tx/",
        "0x440" => "https://andromeda-explorer.metis.io/tx/",
        "0xa4ec" => "https://celoscan.io/tx/",
        _ => return None,
    };
    Some(base.to_string())
}

fn hydrate_chain_defaults(chain: &mut ChainCfg) {
    if chain.explorer_url.is_none() {
        chain.explorer_url = default_explorer_url(&chain.id);
    }
}

fn builtin_chains() -> Vec<ChainCfg> {
    fn c(id: &str, name: &str, symbol: &str, rpc: &str, color: &str) -> ChainCfg {
        ChainCfg {
            id: id.into(),
            name: name.into(),
            symbol: symbol.into(),
            rpc: rpc.into(),
            decimals: 18,
            color: color.into(),
            explorer_url: default_explorer_url(id),
            builtin: true,
        }
    }
    vec![
        c(
            "0x1",
            "Ethereum",
            "ETH",
            "https://ethereum-rpc.publicnode.com",
            "#627EEA",
        ),
        c(
            "0x2105",
            "Base",
            "ETH",
            "https://base-rpc.publicnode.com",
            "#0052FF",
        ),
        c(
            "0xa",
            "OP Mainnet",
            "ETH",
            "https://optimism-rpc.publicnode.com",
            "#FF0420",
        ),
        c(
            "0xa4b1",
            "Arbitrum One",
            "ETH",
            "https://arbitrum-one-rpc.publicnode.com",
            "#28A0F0",
        ),
        c(
            "0x89",
            "Polygon",
            "POL",
            "https://polygon-bor-rpc.publicnode.com",
            "#8247E5",
        ),
        // Extended default set (EVM subset of the xflows supported-chains snapshot).
        c(
            "0x38",
            "BNB Chain",
            "BNB",
            "https://bsc-rpc.publicnode.com",
            "#F3BA2F",
        ),
        c(
            "0xa86a",
            "Avalanche",
            "AVAX",
            "https://avalanche-c-chain-rpc.publicnode.com",
            "#E84142",
        ),
        c(
            "0xe708",
            "Linea",
            "ETH",
            "https://linea-rpc.publicnode.com",
            "#61DFFF",
        ),
        c(
            "0x13e31",
            "Blast",
            "ETH",
            "https://blast-rpc.publicnode.com",
            "#FCD000",
        ),
        c(
            "0x144",
            "zkSync Era",
            "ETH",
            "https://mainnet.era.zksync.io",
            "#8C8DFC",
        ),
        c(
            "0x44d",
            "Polygon zkEVM",
            "ETH",
            "https://zkevm-rpc.com",
            "#7B3FE4",
        ),
        c("0x92", "Sonic", "S", "https://rpc.soniclabs.com", "#1969FF"),
        c(
            "0xc4",
            "X Layer",
            "OKB",
            "https://rpc.xlayer.tech",
            "#1A1A1A",
        ),
        c(
            "0x1e0",
            "World Chain",
            "ETH",
            "https://worldchain-mainnet.g.alchemy.com/public",
            "#1A1A1A",
        ),
        c(
            "0x250",
            "Astar",
            "ASTR",
            "https://evm.astar.network",
            "#1B6DC1",
        ),
        c(
            "0x378",
            "Wanchain",
            "WAN",
            "https://gwan-ssl.wandevs.org:56891",
            "#2A6BE9",
        ),
        c(
            "0x440",
            "Metis",
            "METIS",
            "https://andromeda.metis.io/?owner=1088",
            "#00DACC",
        ),
        c(
            "0xa4ec",
            "Celo",
            "CELO",
            "https://forno.celo.org",
            "#FCB728",
        ),
    ]
}

/// The effective chain registry (built-ins + user edits/additions). Initialized to
/// the built-ins; `load_chains` merges the persisted user file at startup.
fn chains_state() -> &'static Mutex<Vec<ChainCfg>> {
    static C: OnceLock<Mutex<Vec<ChainCfg>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(builtin_chains()))
}

fn find_chain(id: &str) -> Option<ChainCfg> {
    chains_state()
        .lock()
        .unwrap()
        .iter()
        .find(|c| c.id.eq_ignore_ascii_case(id))
        .cloned()
}

/// The wallet's currently selected chain (EIP-155 hex). dApps read it via
/// `eth_chainId`; read-only RPC is forwarded to this chain's node. Mutable so
/// `wallet_switchEthereumChain` works. Defaults to Ethereum mainnet.
fn current_chain() -> &'static Mutex<String> {
    static CURRENT: OnceLock<Mutex<String>> = OnceLock::new();
    CURRENT.get_or_init(|| Mutex::new("0x1".to_string()))
}

/// The one dApp tab currently visible in the browser content area. Background
/// webviews stay alive when tabs/pages switch, but they must not be able to pop
/// signing approvals while hidden.
fn active_dapp_label() -> &'static Mutex<Option<String>> {
    static ACTIVE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}

fn set_active_dapp_label(label: String) {
    *active_dapp_label().lock().unwrap() = Some(label);
}

fn clear_active_dapp_label(label: &str) {
    let mut active = active_dapp_label().lock().unwrap();
    if active.as_deref() == Some(label) {
        *active = None;
    }
}

fn toggle_devtools<R: Runtime>(webview: &tauri::Webview<R>) {
    if webview.is_devtools_open() {
        webview.close_devtools();
    } else {
        webview.open_devtools();
    }
}

fn handle_debug_menu_event<R: Runtime + 'static>(app: &AppHandle<R>, menu_id: &str) {
    match menu_id {
        DEBUG_SHELL_CONSOLE_MENU_ID => {
            if let Some(shell) = app.get_webview("shell") {
                toggle_devtools(&shell);
            } else {
                println!("[AutoDesktop] debug menu: shell webview not found");
            }
        }
        DEBUG_DAPP_CONSOLE_MENU_ID => {
            let active = active_dapp_label().lock().unwrap().clone();
            let Some(label) = active else {
                println!("[AutoDesktop] debug menu: no active dApp webview");
                return;
            };
            if let Some(dapp) = app.get_webview(&label) {
                toggle_devtools(&dapp);
                repair_dapp_bounds_after_devtools(app.clone(), label.clone());
                let _ = app.emit(
                    DAPP_LAYOUT_INVALIDATED_EVENT,
                    DappLayoutInvalidatedEvent { label },
                );
            } else {
                println!("[AutoDesktop] debug menu: active dApp webview {label:?} not found");
            }
        }
        _ => {}
    }
}

fn install_debug_menu<R: Runtime + 'static>(app: &tauri::App<R>) -> tauri::Result<()> {
    let menu = Menu::default(app.handle())?;
    let debug_menu = SubmenuBuilder::new(app, "Debug")
        .text(DEBUG_SHELL_CONSOLE_MENU_ID, "Toggle Main Window Console")
        .text(DEBUG_DAPP_CONSOLE_MENU_ID, "Toggle dApp Page Console")
        .build()?;
    menu.append(&debug_menu)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        handle_debug_menu_event(app, event.id().as_ref());
    });
    Ok(())
}

fn ensure_signing_webview_is_active(label: &str) -> Result<(), String> {
    let active = active_dapp_label().lock().unwrap().clone();
    if active.as_deref() == Some(label) {
        Ok(())
    } else {
        Err("Signing request blocked because this dApp is not the active tab".to_string())
    }
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
        "eth_accounts"
        | "eth_requestAccounts"
        | "eth_coinbase"
        | "eth_chainId"
        | "net_version"
        | "wallet_switchEthereumChain"
        | "wallet_addEthereumChain"
        | "wallet_requestPermissions"
        | "wallet_getPermissions"
        | "wallet_revokePermissions"
        | "wallet_watchAsset" => Route::Wallet,

        "eth_sendTransaction"
        | "eth_sign"
        | "personal_sign"
        | "eth_signTypedData"
        | "eth_signTypedData_v1"
        | "eth_signTypedData_v3"
        | "eth_signTypedData_v4" => Route::Signing,

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
    /// EIP-3085: a dApp asked to add a network the registry doesn't have yet. The
    /// caller inserts + persists it, then switches to it.
    AddChain(ChainCfg),
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
                format!("Unrecognized chain ID {target}; add it first with wallet_addEthereumChain (code 4902)")
            })?;
            Ok(WalletOutcome::SwitchChain(chain.id.to_string()))
        }
        "wallet_addEthereumChain" => {
            let target = chain_id_param()?;
            // Already known → switch to OUR configured chain (we keep our own RPC,
            // never adopt the dApp-supplied one for a chain we already trust).
            if let Some(chain) = find_chain(target) {
                return Ok(WalletOutcome::SwitchChain(chain.id));
            }
            // New chain → build a ChainCfg from the EIP-3085 params and add it.
            let p = params
                .first()
                .ok_or_else(|| format!("{method}: missing params"))?;
            let id = normalize_chain_id(target)?;
            let name = p
                .get("chainName")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("{method}: chainName is required"))?;
            let rpc = p
                .get("rpcUrls")
                .and_then(|v| v.as_array())
                .and_then(|a| a.iter().find_map(|u| u.as_str()))
                .map(|s| s.to_string())
                .ok_or_else(|| format!("{method}: an rpcUrls entry is required"))?;
            validate_rpc(&rpc)?;
            let nc = p.get("nativeCurrency");
            let symbol = nc
                .and_then(|n| n.get("symbol"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("ETH")
                .to_string();
            let decimals = nc
                .and_then(|n| n.get("decimals"))
                .and_then(|v| v.as_u64())
                .filter(|d| *d != 0)
                .unwrap_or(18) as u32;
            let explorer_url = p
                .get("blockExplorerUrls")
                .and_then(|v| v.as_array())
                .and_then(|a| a.iter().find_map(|u| u.as_str()))
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            if let Some(url) = explorer_url.as_deref() {
                validate_explorer_url(url)?;
            }
            Ok(WalletOutcome::AddChain(ChainCfg {
                id,
                name,
                symbol,
                rpc,
                decimals,
                color: "#6b7280".to_string(),
                explorer_url,
                builtin: false,
            }))
        }
        // Minimal EIP-2255: we only ever grant eth_accounts.
        "wallet_requestPermissions" | "wallet_getPermissions" => Ok(WalletOutcome::Reply(
            json!([{ "parentCapability": "eth_accounts" }]),
        )),
        "wallet_revokePermissions" => Ok(WalletOutcome::Reply(Value::Null)),
        "wallet_watchAsset" => Ok(WalletOutcome::Reply(json!(true))),
        other => Err(format!("wallet method not handled: {other}")),
    }
}

/// Forward a read-only method to the selected chain's node and return its result.
/// Node-side JSON-RPC errors are propagated (not masked).
/// Low-level JSON-RPC POST to a specific chain's configured node. Done server-side
/// (reqwest), so it is NOT subject to the node's CORS policy — many public RPCs
/// send no CORS headers, which would break a browser `fetch`. Shared by dApp
/// forwarding and the shell's read command.
async fn node_rpc_call(chain: &ChainCfg, method: &str, params: &[Value]) -> Result<Value, String> {
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
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown RPC error");
        return Err(format!("{msg} (code {code})"));
    }
    body.get("result")
        .cloned()
        .ok_or_else(|| format!("RPC response from {} had no result", chain.name))
}

async fn forward_to_node(method: &str, params: &[Value]) -> Result<Value, String> {
    let chain_id = current_chain().lock().unwrap().clone();
    let chain =
        find_chain(&chain_id).ok_or_else(|| format!("no RPC configured for chain {chain_id}"))?;
    node_rpc_call(&chain, method, params).await
}

/// Read-only methods the trusted shell may forward to a node. Keeps `node_rpc` a
/// pure read channel — writes (eth_sendRawTransaction) go through the signing path.
fn is_read_method(method: &str) -> bool {
    matches!(
        method,
        "eth_getBalance"
            | "eth_call"
            | "eth_getTransactionCount"
            | "eth_gasPrice"
            | "eth_maxPriorityFeePerGas"
            | "eth_estimateGas"
            | "eth_blockNumber"
            | "eth_getBlockByNumber"
            | "eth_chainId"
            | "net_version"
            | "eth_getCode"
            | "eth_getTransactionReceipt"
            | "eth_getTransactionByHash"
            | "eth_feeHistory"
    )
}

/// Read-only JSON-RPC for the TRUSTED shell against ANY registered chain (not just
/// the active one). Server-side, so it works on chains whose public RPC doesn't
/// allow browser CORS. Shell-only (capabilities/default.json); read methods only.
#[tauri::command]
async fn node_rpc(
    chain_id: String,
    method: String,
    params: Option<Vec<Value>>,
) -> Result<Value, String> {
    if !is_read_method(&method) {
        return Err(format!("node_rpc: method not allowed: {method}"));
    }
    let chain =
        find_chain(&chain_id).ok_or_else(|| format!("node_rpc: unknown chain {chain_id}"))?;
    node_rpc_call(&chain, &method, &params.unwrap_or_default()).await
}

const BCS_API_URL: &str = "https://balance-change-simulate-api.wanscan.org/simulate";

#[derive(Debug, Deserialize)]
struct SimulateTxRequest {
    chain_id: u64,
    from: String,
    to: String,
    data: String,
    value: String,
    gas: u64,
}

/// Balance-change simulation for the trusted approval window. This runs through
/// Rust reqwest because the BCS API does not handle browser CORS preflight from
/// the Tauri WebView (`OPTIONS /simulate` returns 405), while the extension's
/// background context can call it with host permissions.
#[tauri::command]
async fn simulate_tx(req: SimulateTxRequest) -> Result<Value, String> {
    let payload = json!({
        "chain_id": req.chain_id,
        "from": req.from,
        "to": req.to,
        "data": req.data,
        "value": req.value,
        "gas": req.gas,
    });
    let resp = http()
        .post(BCS_API_URL)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("simulation request failed: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("simulation response read failed: {e}"))?;
    let data = if text.is_empty() {
        json!({})
    } else {
        serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!({ "message": text }))
    };
    Ok(json!({ "ok": (200..300).contains(&status), "status": status, "data": data }))
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
    /// For `eth_sendTransaction`: the fully-resolved transaction to display
    /// (gas/nonce/fees filled in), so the approval window can show details and
    /// let the user adjust the fee. `None` for message-signing methods.
    #[serde(skip_serializing_if = "Option::is_none")]
    tx: Option<PreparedTx>,
    /// For `eth_signTypedData_v4`: the full EIP-712 payload, so the approval
    /// window can render every field (spender/amount/deadline…). A summary
    /// alone would make typed-data signing blind signing (permit phishing).
    #[serde(skip_serializing_if = "Option::is_none")]
    typed_data: Option<Value>,
}

/// A transaction with every field resolved from the node (gas/nonce/fees filled),
/// ready to display in the approval window and then sign. All quantities 0x-hex.
#[derive(Debug, Clone, Serialize)]
struct PreparedTx {
    chain_id: String,
    chain_name: String,
    /// Native gas-token symbol (for displaying `value`).
    symbol: String,
    from: String,
    /// "" for contract creation.
    to: String,
    value: String,
    data: String,
    /// Gas limit.
    gas: String,
    nonce: String,
    max_priority_fee_per_gas: String,
    max_fee_per_gas: String,
}

/// The user's decision from the approval window. For `eth_sendTransaction` the
/// window may hand back fee overrides (wei hex) the user typed in.
#[derive(Debug, Clone, Default)]
struct ApprovalDecision {
    approved: bool,
    max_fee_per_gas: Option<String>,
    max_priority_fee_per_gas: Option<String>,
    tx_data: Option<String>,
    balance_changes: Vec<ActivityBalanceChange>,
}

struct PendingEntry {
    req: PendingRequest,
    responder: tokio::sync::oneshot::Sender<ApprovalDecision>,
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
/// decision (with a safety timeout). Returns the decision (rejected on timeout).
async fn request_approval<R: Runtime>(app: &AppHandle<R>, req: PendingRequest) -> ApprovalDecision {
    let id = req.id.clone();
    let (tx, rx) = tokio::sync::oneshot::channel::<ApprovalDecision>();
    pending()
        .lock()
        .unwrap()
        .insert(id.clone(), PendingEntry { req, responder: tx });

    // Best-effort: bring up the approval window. If it can't open we still wait —
    // an already-open window (or, in tests, a direct approve_request) resolves it.
    if let Err(e) = open_approval_window(app) {
        println!("[AutoDesktop] warn: could not open approval window: {e}");
    }

    let decided = tokio::time::timeout(std::time::Duration::from_secs(300), rx).await;
    pending().lock().unwrap().remove(&id); // no-op if already resolved; cleans up on timeout
    match decided {
        Ok(Ok(decision)) => decision,
        _ => ApprovalDecision::default(), // timeout / channel drop = rejected
    }
}

/// Open (or focus) the dedicated approval window — a separate top-level window
/// loading the shell UI in approval mode.
fn open_approval_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window("approval") {
        let _ = win.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        app,
        "approval",
        WebviewUrl::App("index.html?view=approval".into()),
    )
    .title("Confirm request — AutoDesktop")
    .inner_size(420.0, 600.0)
    .resizable(false)
    .build()?;
    Ok(())
}

/// Resolve a pending request and close the approval window once nothing is left.
fn resolve_request<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    decision: ApprovalDecision,
) -> Result<(), String> {
    let entry = pending()
        .lock()
        .unwrap()
        .remove(id)
        .ok_or_else(|| format!("no pending request {id}"))?;
    let _ = entry.responder.send(decision); // receiver may have timed out; ignore
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
    webview_label: &str,
) -> Result<Value, String> {
    // Refuse before opening an approval window if there's no key to sign with —
    // otherwise the user would approve a request we can't fulfill.
    if active_account_address().is_none() {
        return Err("wallet is locked".to_string());
    }

    match method {
        "personal_sign" => {
            let message = decode_message_param(
                params
                    .first()
                    .ok_or("personal_sign: missing message param")?,
            )?;
            ensure_signing_webview_is_active(webview_label)?;
            let req = PendingRequest {
                id: next_request_id(),
                method: method.to_string(),
                origin: origin.to_string(),
                summary: preview_message(&message),
                tx: None,
                typed_data: None,
            };
            if request_approval(app, req).await.approved {
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
            ensure_signing_webview_is_active(webview_label)?;
            let chain_id = current_chain().lock().unwrap().clone();
            approve_and_send(app, &chain_id, origin, &tx).await
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
            ensure_signing_webview_is_active(webview_label)?;
            let req = PendingRequest {
                id: next_request_id(),
                method: method.to_string(),
                origin: origin.to_string(),
                summary: preview_typed_data(&typed),
                tx: None,
                typed_data: Some(typed.clone()),
            };
            if request_approval(app, req).await.approved {
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
    let primary = typed
        .get("primaryType")
        .and_then(|v| v.as_str())
        .unwrap_or("typed data");
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

fn is_nonzero_quantity(hex: &str) -> bool {
    hex_to_u128(hex).map(|value| value > 0).unwrap_or(false)
}

fn resolve_provided_fees(tx: &Value) -> Option<(String, String)> {
    if let (Some(prio), Some(max)) = (
        tx_field(tx, "maxPriorityFeePerGas"),
        tx_field(tx, "maxFeePerGas"),
    ) {
        if is_nonzero_quantity(max) {
            return Some((prio.to_string(), max.to_string()));
        }
    }
    tx_field(tx, "gasPrice").and_then(|gas_price| {
        if !is_nonzero_quantity(gas_price) {
            return None;
        }
        let fee = gas_price.to_string();
        Some((fee.clone(), fee))
    })
}

fn bump_estimated_gas(gas: &str) -> Result<String, String> {
    let value = hex_to_u128(gas)?;
    // Add a 20% safety margin to node gas estimates. Some contracts pass
    // estimation but still run out of gas at execution with the exact value.
    let margin = value.saturating_add(4) / 5;
    Ok(format!("0x{:x}", value.saturating_add(margin)))
}

/// A human-readable summary of a transaction for the approval window. Display
/// only — `prepare_tx` resolves the real fields and `finalize_tx` signs them.
fn preview_tx(tx: &Value) -> String {
    let to = tx_field(tx, "to").unwrap_or("new contract");
    let short_to = if to.len() > 12 {
        format!("{}…{}", &to[..6], &to[to.len() - 4..])
    } else {
        to.to_string()
    };
    let eth = hex_to_u128(tx_field(tx, "value").unwrap_or("0x0")).unwrap_or(0) as f64 / 1e18;
    let has_data = tx_field(tx, "data")
        .or_else(|| tx_field(tx, "input"))
        .map_or(false, |d| d.len() > 2);
    if has_data {
        format!("Contract interaction → {short_to} ({eth:.4} ETH)")
    } else {
        format!("Send {eth:.4} ETH → {short_to}")
    }
}

/// Resolve the EIP-1559 fee fields on a specific chain: use the caller's if both
/// EIP-1559 values are given, map legacy `gasPrice` to an equivalent type-2 cap,
/// else suggest `maxPriorityFeePerGas` from the node (1 gwei fallback) and
/// `maxFeePerGas = 2*baseFee + priority` from the pending block's base fee.
async fn resolve_fees_on(chain: &ChainCfg, tx: &Value) -> Result<(String, String), String> {
    if let Some(fees) = resolve_provided_fees(tx) {
        return Ok(fees);
    }
    let priority = match node_rpc_call(chain, "eth_maxPriorityFeePerGas", &[]).await {
        Ok(v) => v
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| "0x3b9aca00".into()),
        Err(_) => "0x3b9aca00".to_string(), // 1 gwei
    };
    let priority_wei = hex_to_u128(&priority)?;
    let block = node_rpc_call(
        chain,
        "eth_getBlockByNumber",
        &[json!("pending"), json!(false)],
    )
    .await?;
    let base_wei = block
        .get("baseFeePerGas")
        .and_then(|v| v.as_str())
        .ok_or("chain has no baseFeePerGas (pre-EIP-1559 chain not supported)")?;
    let base_wei = hex_to_u128(base_wei)?;
    let max_fee = base_wei.saturating_mul(2).saturating_add(priority_wei);
    Ok((format!("0x{priority_wei:x}"), format!("0x{max_fee:x}")))
}

/// Resolve a transaction on `chain_id`: validate `from`, then fill any missing
/// nonce / gas / fees from the node. Pure preparation — no signing, no broadcast —
/// so the approval window can show the user exactly what they're about to sign.
async fn prepare_tx(chain_id: &str, tx: &Value) -> Result<PreparedTx, String> {
    let chain =
        find_chain(chain_id).ok_or_else(|| format!("no RPC configured for chain {chain_id}"))?;
    let from = active_account_address().ok_or("wallet is locked")?;
    if let Some(req_from) = tx_field(tx, "from") {
        if !req_from.eq_ignore_ascii_case(&from) {
            return Err(format!(
                "transaction 'from' {req_from} is not the active account {from}"
            ));
        }
    }

    let to = tx_field(tx, "to").unwrap_or("").to_string();
    let value = tx_field(tx, "value").unwrap_or("0x0").to_string();
    let data = tx_field(tx, "data")
        .or_else(|| tx_field(tx, "input"))
        .unwrap_or("0x")
        .to_string();

    let nonce = match tx_field(tx, "nonce") {
        Some(n) => n.to_string(),
        None => node_rpc_call(
            &chain,
            "eth_getTransactionCount",
            &[json!(from), json!("pending")],
        )
        .await?
        .as_str()
        .ok_or("node returned a non-string nonce")?
        .to_string(),
    };

    let gas = match tx_field(tx, "gas") {
        Some(g) => g.to_string(),
        None => {
            let call = json!({ "from": from, "to": to, "value": value, "data": data });
            let estimate = node_rpc_call(&chain, "eth_estimateGas", &[call])
                .await?
                .as_str()
                .ok_or("node returned a non-string gas estimate")?
                .to_string();
            bump_estimated_gas(&estimate)?
        }
    };

    let (priority, max_fee) = resolve_fees_on(&chain, tx).await?;

    Ok(PreparedTx {
        chain_id: chain.id,
        chain_name: chain.name,
        symbol: chain.symbol,
        from,
        to,
        value,
        data,
        gas,
        nonce,
        max_priority_fee_per_gas: priority,
        max_fee_per_gas: max_fee,
    })
}

/// Sign (Rust-side software key, or on the Ledger) and broadcast a fully-prepared
/// EIP-1559 transaction. Returns the broadcast tx hash.
async fn finalize_tx(p: &PreparedTx) -> Result<Value, String> {
    use eth_tx::{parse_address, parse_data, parse_quantity, Eip1559Tx};

    let chain = find_chain(&p.chain_id)
        .ok_or_else(|| format!("no RPC configured for chain {}", p.chain_id))?;

    let tx1559 = Eip1559Tx {
        chain_id: parse_quantity(&p.chain_id)?,
        nonce: parse_quantity(&p.nonce)?,
        max_priority_fee_per_gas: parse_quantity(&p.max_priority_fee_per_gas)?,
        max_fee_per_gas: parse_quantity(&p.max_fee_per_gas)?,
        gas_limit: parse_quantity(&p.gas)?,
        to: parse_address(&p.to)?,
        value: parse_quantity(&p.value)?,
        data: parse_data(&p.data)?,
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
    node_rpc_call(&chain, "eth_sendRawTransaction", &[json!(raw_tx)]).await
}

/// The shared eth_sendTransaction path: resolve the tx, ask the user (showing full
/// details + an editable fee), apply any fee override, then sign + broadcast. Used
/// by both a dApp's `eth_sendTransaction` and the wallet's own Send.
async fn approve_and_send<R: Runtime>(
    app: &AppHandle<R>,
    chain_id: &str,
    origin: &str,
    tx: &Value,
) -> Result<Value, String> {
    ensure_tx_chain_id_matches(tx, chain_id)?;
    let prepared = prepare_tx(chain_id, tx).await?;
    let req = PendingRequest {
        id: next_request_id(),
        method: "eth_sendTransaction".to_string(),
        origin: origin.to_string(),
        summary: preview_tx(tx),
        tx: Some(prepared.clone()),
        typed_data: None,
    };

    let decision = request_approval(app, req).await;
    if !decision.approved {
        return Err("User rejected the request (4001)".to_string());
    }

    let mut p = prepared;
    if let Some(mf) = decision.max_fee_per_gas {
        p.max_fee_per_gas = mf;
    }
    if let Some(mp) = decision.max_priority_fee_per_gas {
        p.max_priority_fee_per_gas = mp;
    }
    if let Some(data) = decision.tx_data {
        p.data = data;
    }
    // Keep priority ≤ max fee even if the user lowered the cap below it.
    if hex_to_u128(&p.max_priority_fee_per_gas).unwrap_or(0)
        > hex_to_u128(&p.max_fee_per_gas).unwrap_or(u128::MAX)
    {
        p.max_priority_fee_per_gas = p.max_fee_per_gas.clone();
    }
    let hash = finalize_tx(&p).await?;
    if let Some(hash_str) = hash.as_str() {
        record_activity(app, &p, origin, hash_str, tx, decision.balance_changes);
    }
    Ok(hash)
}

/// Wallet-initiated send (shell-only): same approval + sign + broadcast path as a
/// dApp's eth_sendTransaction, so the user confirms in the approval window with the
/// full gas/nonce details. `tx` is `{ to, value?, data? }`; native sends set
/// `value`, ERC-20 sends set `to`=token + `data`=transfer(...).
#[tauri::command]
async fn wallet_send<R: Runtime>(
    app: AppHandle<R>,
    chain_id: String,
    tx: Value,
) -> Result<Value, String> {
    if active_account_address().is_none() {
        return Err("wallet is locked".to_string());
    }
    find_chain(&chain_id).ok_or_else(|| format!("wallet_send: unknown chain {chain_id}"))?;
    approve_and_send(&app, &chain_id, "AutoDesktop Wallet", &tx).await
}

/// The single wallet backend entry point. `origin` is the trustworthy caller
/// origin derived from the webview context (see `wallet_request`).
async fn handle_rpc<R: Runtime>(
    app: &AppHandle<R>,
    method: &str,
    params: &[Value],
    origin: &str,
    webview_label: &str,
) -> Result<Value, String> {
    println!("[AutoDesktop] rpc  method={method}  origin={origin}");
    match route_method(method) {
        Route::Wallet => {
            let current = current_chain().lock().unwrap().clone();
            let account = dapp_account_address();
            match handle_wallet_method(method, params, &current, account.as_deref())? {
                WalletOutcome::Reply(v) => Ok(v),
                WalletOutcome::SwitchChain(new_id) => {
                    *current_chain().lock().unwrap() = new_id.clone();
                    println!("[AutoDesktop] switched chain -> {new_id}");
                    // A dApp switched the network: make the wallet UI (shell) follow
                    // (event the activeChain store listens for), and re-push
                    // chainChanged to every dApp tab so they all agree.
                    let _ = app.emit("active-chain-changed", new_id.clone());
                    push_chain_changed(app, &new_id);
                    Ok(Value::Null) // EIP-3326: null on success
                }
                WalletOutcome::AddChain(chain) => {
                    let new_id = chain.id.clone();
                    let summary = format!(
                        "Network: {}\nChain ID: {}\nRPC: {}\nCurrency: {}",
                        chain.name, chain.id, chain.rpc, chain.symbol
                    );
                    let req = PendingRequest {
                        id: next_request_id(),
                        method: "wallet_addEthereumChain".to_string(),
                        origin: origin.to_string(),
                        summary,
                        tx: None,
                        typed_data: None,
                    };
                    if !request_approval(app, req).await.approved {
                        return Err("User rejected adding the network (code 4001)".to_string());
                    }
                    {
                        let mut chains = chains_state().lock().unwrap();
                        if !chains.iter().any(|c| c.id.eq_ignore_ascii_case(&new_id)) {
                            chains.push(chain);
                        }
                    }
                    save_chains(app)?;
                    println!("[AutoDesktop] dApp added chain -> {new_id}");
                    // Refresh the shell's network list, then switch to the new chain.
                    let _ = app.emit("chains-changed", ());
                    *current_chain().lock().unwrap() = new_id.clone();
                    let _ = app.emit("active-chain-changed", new_id.clone());
                    push_chain_changed(app, &new_id);
                    Ok(Value::Null) // EIP-3085: null on success
                }
            }
        }
        Route::Signing => handle_signing(app, method, params, origin, webview_label).await,
        Route::Forward => forward_to_node(method, params).await,
    }
}

/// Approve a pending request. Scoped to the "approval" webview (ACL). For a
/// transaction the window may pass fee overrides (wei hex) the user typed in;
/// they're absent (None) for message signing or an unchanged fee.
#[tauri::command]
fn approve_request<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    max_fee_per_gas: Option<String>,
    max_priority_fee_per_gas: Option<String>,
    tx_data: Option<String>,
    balance_changes: Option<Vec<ActivityBalanceChange>>,
) -> Result<(), String> {
    resolve_request(
        &app,
        &id,
        ApprovalDecision {
            approved: true,
            max_fee_per_gas,
            max_priority_fee_per_gas,
            tx_data,
            balance_changes: balance_changes.unwrap_or_default(),
        },
    )
}

/// Reject a pending request. Scoped to the "approval" webview (ACL).
#[tauri::command]
fn reject_request<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    resolve_request(
        &app,
        &id,
        ApprovalDecision {
            approved: false,
            ..Default::default()
        },
    )
}

/// List requests awaiting approval, for the approval window to render.
#[tauri::command]
fn get_pending_requests() -> Vec<PendingRequest> {
    pending()
        .lock()
        .unwrap()
        .values()
        .map(|e| e.req.clone())
        .collect()
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
    handle_rpc(
        &app,
        &method,
        &params.unwrap_or_default(),
        &origin,
        webview.label(),
    )
    .await
}

// ---------------------------------------------------------------------------
// dApp JavaScript dialog bridge.
//
// Remote WKWebView child pages do not reliably show native alert/confirm/prompt
// sheets. The injected script replaces those APIs with this narrow command; Rust
// derives the origin from the calling webview, forwards a display-only request to
// the trusted shell, then waits briefly for the shell overlay to resolve it.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
struct DappDialogRequest {
    id: String,
    kind: String,
    origin: String,
    message: String,
    default_value: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
struct DappDialogResult {
    action: String,
    value: Option<String>,
}

fn dapp_dialog_pending(
) -> &'static Mutex<HashMap<String, tokio::sync::oneshot::Sender<DappDialogResult>>> {
    static PENDING: OnceLock<
        Mutex<HashMap<String, tokio::sync::oneshot::Sender<DappDialogResult>>>,
    > = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_dapp_dialog_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    format!("dlg-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

#[tauri::command]
async fn dapp_dialog<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    kind: String,
    message: String,
    default_value: Option<String>,
) -> Result<DappDialogResult, String> {
    if !matches!(kind.as_str(), "alert" | "confirm" | "prompt" | "print") {
        return Err(format!("dapp_dialog: unsupported kind {kind:?}"));
    }
    let origin = match webview.url() {
        Ok(url) => url.origin().ascii_serialization(),
        Err(_) => format!("webview://{}", webview.label()),
    };
    let id = next_dapp_dialog_id();
    let (tx, rx) = tokio::sync::oneshot::channel::<DappDialogResult>();
    dapp_dialog_pending().lock().unwrap().insert(id.clone(), tx);

    let req = DappDialogRequest {
        id: id.clone(),
        kind,
        origin,
        message,
        default_value,
    };
    if let Err(e) = webview.app_handle().emit("dapp-dialog-request", req) {
        dapp_dialog_pending().lock().unwrap().remove(&id);
        return Err(format!("dapp_dialog: failed to notify shell: {e}"));
    }

    match tokio::time::timeout(Duration::from_secs(300), rx).await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(_)) => Ok(DappDialogResult::default()),
        Err(_) => {
            dapp_dialog_pending().lock().unwrap().remove(&id);
            Ok(DappDialogResult::default())
        }
    }
}

#[tauri::command]
fn resolve_dapp_dialog(id: String, action: String, value: Option<String>) -> Result<(), String> {
    let Some(sender) = dapp_dialog_pending().lock().unwrap().remove(&id) else {
        return Ok(());
    };
    let _ = sender.send(DappDialogResult { action, value });
    Ok(())
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
    // The frame/content mismatch is a macOS (NSView-in-window-frame) artifact.
    // On Windows/Linux child-webview bounds are relative to the client area —
    // the same space the shell measured with getBoundingClientRect — so the
    // rect must pass through unchanged. Applying the macOS compensation there
    // shifts the dapp webview down by a full title bar (visible in the Windows
    // CI smoke screenshots).
    if !cfg!(target_os = "macos") {
        return (x, y);
    }
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

#[derive(Clone, Copy, Debug)]
struct DappBounds {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn dapp_bounds_state() -> &'static Mutex<HashMap<String, DappBounds>> {
    static BOUNDS: OnceLock<Mutex<HashMap<String, DappBounds>>> = OnceLock::new();
    BOUNDS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember_dapp_bounds(label: &str, bounds: DappBounds) {
    dapp_bounds_state()
        .lock()
        .unwrap()
        .insert(label.to_string(), bounds);
}

fn forget_dapp_bounds(label: &str) {
    dapp_bounds_state().lock().unwrap().remove(label);
}

fn last_dapp_bounds(label: &str) -> Option<DappBounds> {
    dapp_bounds_state().lock().unwrap().get(label).copied()
}

fn apply_dapp_bounds<R: Runtime>(
    dapp: &tauri::Webview<R>,
    bounds: DappBounds,
) -> Result<(), String> {
    raise_dapp_above_shell(dapp)?;
    let (fx, fy) = content_to_frame(dapp, bounds.x, bounds.y);
    dapp.set_position(LogicalPosition::new(fx, fy))
        .map_err(|e| e.to_string())?;
    dapp.set_size(LogicalSize::new(bounds.w.max(1.0), bounds.h.max(1.0)))
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
fn raise_dapp_above_shell<R: Runtime>(dapp: &tauri::Webview<R>) -> Result<(), String> {
    let window = dapp.window();
    dapp.reparent(&window).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "windows"))]
fn raise_dapp_above_shell<R: Runtime>(_dapp: &tauri::Webview<R>) -> Result<(), String> {
    Ok(())
}

fn repair_active_dapp_after_shell_resize<R: Runtime>(app: &AppHandle<R>) {
    let Some(label) = active_dapp_label().lock().unwrap().clone() else {
        return;
    };
    let Some(bounds) = last_dapp_bounds(&label) else {
        return;
    };
    let Some(dapp) = app.get_webview(&label) else {
        return;
    };
    if let Err(e) = apply_dapp_bounds(&dapp, bounds) {
        println!("[AutoDesktop] dapp resize repair failed for {label}: {e}");
    }
    if let Err(e) = dapp.show() {
        println!("[AutoDesktop] dapp resize show failed for {label}: {e}");
    }
}

fn repair_dapp_bounds_after_devtools<R: Runtime + 'static>(app: AppHandle<R>, label: String) {
    const REPAIR_DELAYS_MS: [u64; 7] = [0, 50, 150, 300, 700, 1200, 2000];

    tauri::async_runtime::spawn(async move {
        for delay_ms in REPAIR_DELAYS_MS {
            if delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
            let Some(bounds) = last_dapp_bounds(&label) else {
                println!("[AutoDesktop] dapp devtools repair: no bounds for {label}");
                return;
            };
            let Some(dapp) = app.get_webview(&label) else {
                println!("[AutoDesktop] dapp devtools repair: webview {label:?} not found");
                return;
            };
            if let Err(e) = apply_dapp_bounds(&dapp, bounds) {
                println!("[AutoDesktop] dapp devtools repair failed for {label}: {e}");
            }
        }
    });
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
    println!(
        "[AutoDesktop] create dapp webview label={label} url={url} bounds=({x:.0},{y:.0},{w:.0},{h:.0})"
    );
    let window = app
        .get_window("main")
        .ok_or("create_dapp_webview: main window not found")?;
    let builder = WebviewBuilder::new(label, WebviewUrl::External(url))
        .on_page_load(|webview, payload| {
            println!(
                "[AutoDesktop] dapp page-load {:?}  url={}",
                payload.event(),
                payload.url()
            );
            if payload.event() == PageLoadEvent::Finished {
                let should_show =
                    active_dapp_label().lock().unwrap().as_deref() == Some(webview.label());
                if should_show {
                    let _ = webview.show();
                }
                let _ = webview.app_handle().emit(
                    "dapp-load-finished",
                    DappNavigationEvent {
                        label: webview.label().to_string(),
                        url: payload.url().to_string(),
                    },
                );
            }
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
    println!(
        "[AutoDesktop] open_dapp label={label} url={url} bounds=({x:.0},{y:.0},{w:.0},{h:.0})"
    );
    let parsed: tauri::Url = url
        .parse()
        .map_err(|e| format!("open_dapp: invalid url {url}: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("open_dapp: refusing non-http(s) url: {url}"));
    }
    let bounds = DappBounds { x, y, w, h };
    remember_dapp_bounds(&label, bounds);
    let (dapp, newly_created) = match app.get_webview(&label) {
        Some(wv) => (wv, false),
        None => (create_dapp_webview(&app, &label, parsed, x, y, w, h)?, true),
    };
    apply_dapp_bounds(&dapp, bounds)?;
    dapp.show().map_err(|e| e.to_string())?;
    println!("[AutoDesktop] dapp webview ready label={label} newly_created={newly_created}");
    set_active_dapp_label(label);
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
    let bounds = DappBounds { x, y, w, h };
    remember_dapp_bounds(&label, bounds);
    if let Some(dapp) = app.get_webview(&label) {
        apply_dapp_bounds(&dapp, bounds)?;
    }
    Ok(())
}

/// A tiny transparent local child webview used only to draw shell toasts above a
/// remote dApp child webview. It is positioned to the measured toast stack rect,
/// so it does not steal clicks from the rest of the dApp page.
#[tauri::command]
fn sync_toast_overlay<R: Runtime>(
    app: AppHandle<R>,
    visible: bool,
    x: Option<f64>,
    y: Option<f64>,
    w: Option<f64>,
    h: Option<f64>,
) -> Result<(), String> {
    const LABEL: &str = "toast-overlay";

    if !visible {
        if let Some(overlay) = app.get_webview(LABEL) {
            overlay.hide().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    let x = x.unwrap_or(0.0);
    let y = y.unwrap_or(0.0);
    let w = w.unwrap_or(1.0).max(1.0);
    let h = h.unwrap_or(1.0).max(1.0);

    let overlay = match app.get_webview(LABEL) {
        Some(wv) => wv,
        None => {
            let window = app
                .get_window("main")
                .ok_or("sync_toast_overlay: main window not found")?;
            let builder = WebviewBuilder::new(
                LABEL,
                WebviewUrl::App("index.html?view=toast-overlay".into()),
            )
            .transparent(true);
            window
                .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
                .map_err(|e| e.to_string())?
        }
    };

    let (fx, fy) = content_to_frame(&overlay, x, y);
    overlay
        .set_position(LogicalPosition::new(fx, fy))
        .map_err(|e| e.to_string())?;
    overlay
        .set_size(LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    overlay.show().map_err(|e| e.to_string())?;
    Ok(())
}

/// A transparent local child webview that renders the browser top-bar dropdown
/// menus (account / chain switcher) ABOVE the remote dApp child webview — native
/// child webviews stack over the shell, so an in-shell dropdown would be covered
/// by the page. Unlike the toast overlay it spans the whole window while a menu
/// is open: the transparent area doubles as the click-away backdrop (the overlay
/// page posts a dismiss action back to the shell over a BroadcastChannel).
#[tauri::command]
fn sync_menu_overlay<R: Runtime>(
    app: AppHandle<R>,
    visible: bool,
    x: Option<f64>,
    y: Option<f64>,
    w: Option<f64>,
    h: Option<f64>,
) -> Result<(), String> {
    const LABEL: &str = "menu-overlay";

    if !visible {
        if let Some(overlay) = app.get_webview(LABEL) {
            overlay.hide().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    let x = x.unwrap_or(0.0);
    let y = y.unwrap_or(0.0);
    let w = w.unwrap_or(1.0).max(1.0);
    let h = h.unwrap_or(1.0).max(1.0);

    let window = app
        .get_window("main")
        .ok_or("sync_menu_overlay: main window not found")?;
    let overlay = match app.get_webview(LABEL) {
        Some(wv) => {
            // Child webviews stack in creation order, so a dApp tab opened after
            // this overlay was first created would cover it. Re-adding the
            // overlay's native view to the window (reparent to the SAME window)
            // puts it back on top of every webview created since.
            wv.reparent(&window).map_err(|e| e.to_string())?;
            wv
        }
        None => {
            let builder = WebviewBuilder::new(
                LABEL,
                WebviewUrl::App("index.html?view=menu-overlay".into()),
            )
            .transparent(true);
            window
                .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
                .map_err(|e| e.to_string())?
        }
    };

    let (fx, fy) = content_to_frame(&overlay, x, y);
    overlay
        .set_position(LogicalPosition::new(fx, fy))
        .map_err(|e| e.to_string())?;
    overlay
        .set_size(LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    overlay.show().map_err(|e| e.to_string())?;
    Ok(())
}

/// Reload a tab webview. Shell-only; dApps are never granted this command.
#[tauri::command]
fn reload_dapp<R: Runtime>(app: AppHandle<R>, label: String) -> Result<(), String> {
    validate_dapp_label(&label)?;
    if let Some(dapp) = app.get_webview(&label) {
        dapp.reload().map_err(|e| e.to_string())?;
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
    clear_active_dapp_label(&label);
    Ok(())
}

/// Close (destroy) a tab webview when its tab is closed. Idempotent.
#[tauri::command]
fn close_dapp<R: Runtime>(app: AppHandle<R>, label: String) -> Result<(), String> {
    validate_dapp_label(&label)?;
    if let Some(dapp) = app.get_webview(&label) {
        dapp.close().map_err(|e| e.to_string())?;
    }
    forget_dapp_bounds(&label);
    clear_active_dapp_label(&label);
    Ok(())
}

#[derive(Serialize, Clone)]
struct DappNavigationEvent {
    label: String,
    url: String,
}

#[derive(Serialize, Clone)]
struct DappLayoutInvalidatedEvent {
    label: String,
}

fn registrable_site(host: &str) -> String {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host == "localhost" || host.parse::<std::net::IpAddr>().is_ok() {
        return host;
    }
    let parts: Vec<&str> = host.split('.').filter(|part| !part.is_empty()).collect();
    if parts.len() <= 2 {
        return host;
    }
    let second_last = parts[parts.len() - 2];
    let last = parts[parts.len() - 1];
    let public_second_level = matches!(second_last, "co" | "com" | "net" | "org" | "gov" | "edu");
    if public_second_level && last.len() == 2 && parts.len() >= 3 {
        parts[parts.len() - 3..].join(".")
    } else {
        parts[parts.len() - 2..].join(".")
    }
}

fn is_same_registrable_site(a: &tauri::Url, b: &tauri::Url) -> bool {
    match (a.host_str(), b.host_str()) {
        (Some(a_host), Some(b_host)) => registrable_site(a_host) == registrable_site(b_host),
        _ => false,
    }
}

/// Open an http(s) URL from a webview. For dApp-initiated "new window" intents,
/// same-site subdomains (e.g. www.pendle.finance -> app.pendle.finance) navigate
/// in the current dApp webview so the injected wallet stays available. Cross-site
/// links still land in the OS default browser. SECURITY: only http/https is
/// honored; a dApp can't coerce us into file://, custom schemes, or shell
/// execution.
#[tauri::command]
fn open_external_url<R: Runtime>(
    app: AppHandle<R>,
    webview: tauri::Webview<R>,
    url: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let u: tauri::Url = url
        .trim()
        .parse()
        .map_err(|e| format!("invalid url {url}: {e}"))?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err(format!("refusing to open non-http(s) url: {u}"));
    }

    let label = webview.label().to_string();
    if label.starts_with("dapp-") {
        if let Ok(current) = webview.url() {
            if is_same_registrable_site(&current, &u) {
                let target = u.to_string();
                let js_target =
                    serde_json::to_string(&target).map_err(|e| format!("encode url: {e}"))?;
                webview
                    .eval(format!("window.location.assign({js_target});"))
                    .map_err(|e| e.to_string())?;
                let _ = app.emit("dapp-navigated", DappNavigationEvent { label, url: target });
                return Ok(());
            }
        }
    }

    let u = u.to_string();
    println!("[AutoDesktop] open external -> {u}");
    app.opener()
        .open_url(u, None::<&str>)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Active wallet network (the chain dApps see via eth_chainId).
// ---------------------------------------------------------------------------

/// Push an EIP-1193 `chainChanged` to every open dApp tab by eval'ing the
/// provider's `window.__autoWalletPush` (see inpage.tauri.ts). Avoids granting the
/// dapp webviews any event capability — they keep ONLY allow-wallet-request.
fn push_chain_changed<R: Runtime>(app: &AppHandle<R>, chain_id: &str) {
    let payload = serde_json::to_string(chain_id).unwrap_or_else(|_| "\"0x1\"".into());
    let js =
        format!("window.__autoWalletPush && window.__autoWalletPush('chainChanged', {payload});");
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
    let chain = find_chain(&chain_id)
        .ok_or_else(|| format!("set_active_chain: unknown chain {chain_id}"))?;
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
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(CHAINS_FILE))
}

/// Load the persisted chain list (built-ins + user edits) at startup, if present.
fn load_chains<R: Runtime>(app: &AppHandle<R>) {
    let Ok(path) = chains_path(app) else { return };
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(mut list) = serde_json::from_slice::<Vec<ChainCfg>>(&bytes) {
            if !list.is_empty() {
                for chain in &mut list {
                    hydrate_chain_defaults(chain);
                }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum CloseBehavior {
    Hide,
    Quit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct AppPrefs {
    close_behavior: CloseBehavior,
}

impl Default for AppPrefs {
    fn default() -> Self {
        Self {
            close_behavior: default_close_behavior(),
        }
    }
}

fn default_close_behavior() -> CloseBehavior {
    #[cfg(target_os = "macos")]
    {
        CloseBehavior::Hide
    }
    #[cfg(not(target_os = "macos"))]
    {
        CloseBehavior::Quit
    }
}

const APP_PREFS_FILE: &str = "app-prefs.json";

fn app_prefs_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(APP_PREFS_FILE))
}

fn load_app_prefs<R: Runtime>(app: &AppHandle<R>) -> AppPrefs {
    let Ok(path) = app_prefs_path(app) else {
        return AppPrefs::default();
    };
    let Ok(bytes) = std::fs::read(path) else {
        return AppPrefs::default();
    };
    serde_json::from_slice::<AppPrefs>(&bytes).unwrap_or_default()
}

fn save_app_prefs<R: Runtime>(app: &AppHandle<R>, prefs: &AppPrefs) -> Result<(), String> {
    let path = app_prefs_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(prefs).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("writing app prefs: {e}"))
}

const ACTIVITY_FILE: &str = "activity.json";

fn activity_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(ACTIVITY_FILE))
}

fn load_activity_records<R: Runtime>(app: &AppHandle<R>) -> Vec<ActivityRecord> {
    let Ok(path) = activity_path(app) else {
        return Vec::new();
    };
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    serde_json::from_slice::<Vec<ActivityRecord>>(&bytes).unwrap_or_default()
}

fn save_activity_records<R: Runtime>(
    app: &AppHandle<R>,
    records: &[ActivityRecord],
) -> Result<(), String> {
    let path = activity_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(records).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("writing activity: {e}"))
}

const PORTFOLIO_HISTORY_FILE: &str = "portfolio-history.json";
const PORTFOLIO_HISTORY_MAX_AGE_SECS: u64 = 90 * 24 * 60 * 60;
const PORTFOLIO_HISTORY_REPLACE_WINDOW_SECS: u64 = 10 * 60;

fn portfolio_history_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(PORTFOLIO_HISTORY_FILE))
}

fn load_portfolio_snapshots<R: Runtime>(app: &AppHandle<R>) -> Vec<PortfolioSnapshot> {
    let Ok(path) = portfolio_history_path(app) else {
        return Vec::new();
    };
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    serde_json::from_slice::<Vec<PortfolioSnapshot>>(&bytes).unwrap_or_default()
}

fn save_portfolio_snapshots<R: Runtime>(
    app: &AppHandle<R>,
    snapshots: &[PortfolioSnapshot],
) -> Result<(), String> {
    let path = portfolio_history_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(snapshots).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("writing portfolio history: {e}"))
}

fn normalized_address(address: &str) -> Result<String, String> {
    let address = address.trim();
    if address.len() == 42
        && address.starts_with("0x")
        && address[2..].chars().all(|c| c.is_ascii_hexdigit())
    {
        Ok(address.to_lowercase())
    } else {
        Err("invalid address".to_string())
    }
}

#[tauri::command]
fn get_portfolio_history<R: Runtime>(
    app: AppHandle<R>,
    address: String,
) -> Result<Vec<PortfolioSnapshot>, String> {
    let address = normalized_address(&address)?;
    let mut snapshots: Vec<PortfolioSnapshot> = load_portfolio_snapshots(&app)
        .into_iter()
        .filter(|s| s.address.eq_ignore_ascii_case(&address))
        .collect();
    snapshots.sort_by_key(|s| s.timestamp);
    Ok(snapshots)
}

#[tauri::command]
fn record_portfolio_snapshot<R: Runtime>(
    app: AppHandle<R>,
    address: String,
    total_usd: f64,
) -> Result<Vec<PortfolioSnapshot>, String> {
    if !total_usd.is_finite() || total_usd < 0.0 {
        return Err("invalid total".to_string());
    }
    let address = normalized_address(&address)?;
    let now = now_secs();
    let cutoff = now.saturating_sub(PORTFOLIO_HISTORY_MAX_AGE_SECS);
    let mut snapshots: Vec<PortfolioSnapshot> = load_portfolio_snapshots(&app)
        .into_iter()
        .filter(|s| s.timestamp >= cutoff)
        .collect();

    if let Some(last) = snapshots
        .iter_mut()
        .filter(|s| s.address.eq_ignore_ascii_case(&address))
        .max_by_key(|s| s.timestamp)
    {
        if now.saturating_sub(last.timestamp) < PORTFOLIO_HISTORY_REPLACE_WINDOW_SECS {
            last.total_usd = total_usd;
            last.timestamp = now;
            save_portfolio_snapshots(&app, &snapshots)?;
            return get_portfolio_history(app, address);
        }
    }

    snapshots.push(PortfolioSnapshot {
        address: address.clone(),
        total_usd,
        timestamp: now,
    });
    snapshots.sort_by_key(|s| s.timestamp);
    save_portfolio_snapshots(&app, &snapshots)?;
    get_portfolio_history(app, address)
}

#[derive(Default)]
struct ActivityMeta {
    kind: Option<String>,
    counterparty: Option<String>,
    asset_symbol: Option<String>,
    asset_decimals: Option<u32>,
    amount: Option<String>,
    token_address: Option<String>,
}

fn tx_activity_meta(tx: &Value) -> ActivityMeta {
    let Some(meta) = tx.get("activity").and_then(|v| v.as_object()) else {
        return ActivityMeta::default();
    };
    ActivityMeta {
        kind: meta
            .get("kind")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        counterparty: meta
            .get("counterparty")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        asset_symbol: meta
            .get("assetSymbol")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        asset_decimals: meta
            .get("assetDecimals")
            .and_then(|v| v.as_u64())
            .and_then(|n| u32::try_from(n).ok()),
        amount: meta
            .get("amount")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        token_address: meta
            .get("tokenAddress")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    }
}

fn parse_erc20_transfer(data: &str) -> Option<(String, String)> {
    let hex = data.strip_prefix("0x").unwrap_or(data);
    if hex.len() < 8 + 64 + 64 || !hex[..8].eq_ignore_ascii_case("a9059cbb") {
        return None;
    }
    let to_word = &hex[8..72];
    let amount_word = &hex[72..136];
    let to = format!("0x{}", &to_word[24..64]);
    let amount = format!("0x{}", amount_word.trim_start_matches('0'));
    Some((
        to,
        if amount == "0x" {
            "0x0".to_string()
        } else {
            amount
        },
    ))
}

fn record_activity<R: Runtime>(
    app: &AppHandle<R>,
    prepared: &PreparedTx,
    origin: &str,
    hash: &str,
    tx: &Value,
    balance_changes: Vec<ActivityBalanceChange>,
) {
    let has_data = prepared.data.trim() != "0x" && !prepared.data.trim().is_empty();
    let mut meta = tx_activity_meta(tx);
    let parsed_transfer = parse_erc20_transfer(&prepared.data);
    if parsed_transfer.is_some() && meta.kind.is_none() {
        meta.kind = Some("token_send".to_string());
    }
    if let Some((to, amount)) = parsed_transfer {
        meta.counterparty.get_or_insert(to);
        meta.amount.get_or_insert(amount);
        meta.token_address.get_or_insert(prepared.to.clone());
    }
    let kind = meta.kind.clone().unwrap_or_else(|| {
        if has_data {
            "contract".to_string()
        } else {
            "send".to_string()
        }
    });
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let record = ActivityRecord {
        id: format!(
            "{}:{}",
            prepared.chain_id.to_lowercase(),
            hash.to_lowercase()
        ),
        hash: hash.to_string(),
        chain_id: prepared.chain_id.clone(),
        chain_name: prepared.chain_name.clone(),
        symbol: prepared.symbol.clone(),
        from: prepared.from.clone(),
        to: prepared.to.clone(),
        value: prepared.value.clone(),
        data: prepared.data.clone(),
        gas: prepared.gas.clone(),
        nonce: prepared.nonce.clone(),
        max_priority_fee_per_gas: prepared.max_priority_fee_per_gas.clone(),
        max_fee_per_gas: prepared.max_fee_per_gas.clone(),
        origin: origin.to_string(),
        kind,
        counterparty: meta.counterparty.or_else(|| {
            if prepared.to.is_empty() {
                None
            } else {
                Some(prepared.to.clone())
            }
        }),
        asset_symbol: meta.asset_symbol.or_else(|| {
            if has_data {
                None
            } else {
                Some(prepared.symbol.clone())
            }
        }),
        asset_decimals: meta
            .asset_decimals
            .or_else(|| if has_data { None } else { Some(18) }),
        amount: meta.amount.or_else(|| {
            if prepared.value != "0x0" {
                Some(prepared.value.clone())
            } else {
                None
            }
        }),
        token_address: meta.token_address,
        balance_changes,
        status: Some("submitted".to_string()),
        timestamp: now,
    };

    let mut records = load_activity_records(app);
    records.retain(|r| {
        !r.hash.eq_ignore_ascii_case(hash) || !r.chain_id.eq_ignore_ascii_case(&prepared.chain_id)
    });
    records.insert(0, record);
    records.truncate(500);
    if let Err(e) = save_activity_records(app, &records) {
        println!("[AutoDesktop] warn: failed to save activity: {e}");
    } else {
        let _ = app.emit("activity-changed", ());
    }
    let _ = app.emit("activity-recorded", &records[0]);
}

#[tauri::command]
fn get_activity<R: Runtime>(app: AppHandle<R>) -> Vec<ActivityRecord> {
    load_activity_records(&app)
}

async fn receipt_status(chain: &ChainCfg, hash: &str) -> Result<Option<String>, String> {
    let receipt = node_rpc_call(chain, "eth_getTransactionReceipt", &[json!(hash)]).await?;
    if receipt.is_null() {
        return Ok(None);
    }
    let status = receipt
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("0x0");
    Ok(Some(if status == "0x1" {
        "confirmed".to_string()
    } else {
        "failed".to_string()
    }))
}

#[tauri::command]
async fn sync_activity_receipts<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<ActivityRecord>, String> {
    let mut records = load_activity_records(&app);
    let pending: Vec<(usize, String, String)> = records
        .iter()
        .enumerate()
        .filter(|(_, r)| r.status.as_deref().unwrap_or("submitted") == "submitted")
        .map(|(idx, r)| (idx, r.chain_id.clone(), r.hash.clone()))
        .collect();

    let mut changed = false;
    let mut completed = Vec::new();
    for (idx, chain_id, hash) in pending {
        let Some(chain) = find_chain(&chain_id) else {
            continue;
        };
        match receipt_status(&chain, &hash).await {
            Ok(Some(status)) => {
                if records[idx].status.as_deref() != Some(status.as_str()) {
                    records[idx].status = Some(status.clone());
                    completed.push((status, records[idx].clone()));
                    changed = true;
                }
            }
            Ok(None) => {}
            Err(e) => println!("[AutoDesktop] warn: failed to sync receipt {hash}: {e}"),
        }
    }

    if changed {
        save_activity_records(&app, &records)?;
        let _ = app.emit("activity-changed", ());
        for (status, record) in completed {
            if status == "confirmed" {
                let _ = app.emit("activity-confirmed", &record);
            } else if status == "failed" {
                let _ = app.emit("activity-failed", &record);
            }
        }
    }
    Ok(records)
}

#[tauri::command]
async fn replace_activity_transaction<R: Runtime>(
    app: AppHandle<R>,
    activity_id: String,
    action: String,
    max_fee_per_gas: String,
    max_priority_fee_per_gas: String,
) -> Result<Value, String> {
    let records = load_activity_records(&app);
    let original = records
        .iter()
        .find(|r| r.id == activity_id)
        .cloned()
        .ok_or("activity record not found")?;
    if original.status.as_deref().unwrap_or("submitted") != "submitted" {
        return Err("only pending transactions can be replaced".to_string());
    }
    if original.nonce.is_empty() || original.gas.is_empty() {
        return Err("this activity record is missing nonce/gas; it cannot be replaced".to_string());
    }
    let active = active_account_address().ok_or("wallet is locked")?;
    if !original.from.eq_ignore_ascii_case(&active) {
        return Err("only the active sender can replace this transaction".to_string());
    }
    if hex_to_u128(&max_priority_fee_per_gas).unwrap_or(0)
        > hex_to_u128(&max_fee_per_gas).unwrap_or(u128::MAX)
    {
        return Err("priority fee cannot exceed max fee".to_string());
    }
    let chain = find_chain(&original.chain_id)
        .ok_or_else(|| format!("no RPC configured for chain {}", original.chain_id))?;

    let is_cancel = action == "cancel" || action == "revoke";
    let prepared = if is_cancel {
        PreparedTx {
            chain_id: chain.id,
            chain_name: chain.name,
            symbol: chain.symbol,
            from: original.from.clone(),
            to: original.from.clone(),
            value: "0x0".to_string(),
            data: "0x".to_string(),
            gas: "0x5208".to_string(),
            nonce: original.nonce.clone(),
            max_priority_fee_per_gas,
            max_fee_per_gas,
        }
    } else {
        PreparedTx {
            chain_id: original.chain_id.clone(),
            chain_name: original.chain_name.clone(),
            symbol: original.symbol.clone(),
            from: original.from.clone(),
            to: original.to.clone(),
            value: original.value.clone(),
            data: original.data.clone(),
            gas: original.gas.clone(),
            nonce: original.nonce.clone(),
            max_priority_fee_per_gas,
            max_fee_per_gas,
        }
    };

    let req = PendingRequest {
        id: next_request_id(),
        method: "eth_sendTransaction".to_string(),
        origin: "AutoDesktop Wallet".to_string(),
        summary: if is_cancel {
            format!("Cancel pending transaction\nOriginal: {}", original.hash)
        } else {
            format!("Speed up pending transaction\nOriginal: {}", original.hash)
        },
        tx: Some(prepared.clone()),
        typed_data: None,
    };
    let decision = request_approval(&app, req).await;
    if !decision.approved {
        return Err("User rejected the request (4001)".to_string());
    }
    let mut p = prepared;
    if let Some(mf) = decision.max_fee_per_gas {
        p.max_fee_per_gas = mf;
    }
    if let Some(mp) = decision.max_priority_fee_per_gas {
        p.max_priority_fee_per_gas = mp;
    }
    if hex_to_u128(&p.max_priority_fee_per_gas).unwrap_or(0)
        > hex_to_u128(&p.max_fee_per_gas).unwrap_or(u128::MAX)
    {
        p.max_priority_fee_per_gas = p.max_fee_per_gas.clone();
    }

    let hash = finalize_tx(&p).await?;
    if let Some(hash_str) = hash.as_str() {
        let tx = json!({
            "to": p.to,
            "value": p.value,
            "data": p.data,
            "activity": {
                "kind": if is_cancel { "cancel" } else { "speedup" },
                "counterparty": original.counterparty,
                "assetSymbol": original.asset_symbol,
                "assetDecimals": original.asset_decimals,
                "amount": original.amount,
                "tokenAddress": original.token_address
            }
        });
        record_activity(&app, &p, "AutoDesktop Wallet", hash_str, &tx, Vec::new());

        let mut records = load_activity_records(&app);
        if let Some(old) = records.iter_mut().find(|r| r.id == activity_id) {
            old.status = Some("replaced".to_string());
        }
        save_activity_records(&app, &records)?;
        let _ = app.emit("activity-changed", ());
    }
    Ok(hash)
}

#[tauri::command]
fn get_close_behavior<R: Runtime>(app: AppHandle<R>) -> CloseBehavior {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        return CloseBehavior::Quit;
    }
    load_app_prefs(&app).close_behavior
}

#[tauri::command]
fn set_close_behavior<R: Runtime>(
    app: AppHandle<R>,
    close_behavior: CloseBehavior,
) -> Result<CloseBehavior, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = close_behavior;
        return Ok(CloseBehavior::Quit);
    }
    let prefs = AppPrefs { close_behavior };
    save_app_prefs(&app, &prefs)?;
    Ok(close_behavior)
}

fn version_parts(version: &str) -> Vec<u64> {
    version
        .trim_start_matches('v')
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0)
        })
        .collect()
}

fn is_newer_version(latest: &str, current: &str) -> bool {
    let mut l = version_parts(latest);
    let mut c = version_parts(current);
    let n = l.len().max(c.len());
    l.resize(n, 0);
    c.resize(n, 0);
    l > c
}

fn matching_release_asset(assets: &[GithubAsset]) -> Option<&GithubAsset> {
    #[cfg(target_os = "macos")]
    {
        let arch = if cfg!(target_arch = "aarch64") {
            "aarch64"
        } else {
            "x64"
        };
        return assets.iter().find(|asset| {
            let name = asset.name.to_ascii_lowercase();
            name.contains("macos") && name.contains(arch) && name.ends_with(".dmg")
        });
    }
    #[cfg(target_os = "windows")]
    {
        return assets.iter().find(|asset| {
            let name = asset.name.to_ascii_lowercase();
            name.contains("windows") && name.contains("x64") && name.ends_with(".zip")
        });
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        assets.first()
    }
}

#[tauri::command]
async fn check_for_update() -> Result<UpdateInfo, String> {
    const LATEST_URL: &str =
        "https://api.github.com/repos/Auto-Wallet/auto-desktop/releases/latest";
    let current = env!("CARGO_PKG_VERSION").to_string();
    let release: GithubRelease = reqwest::Client::new()
        .get(LATEST_URL)
        .header(reqwest::header::USER_AGENT, "AutoDesktop")
        .send()
        .await
        .map_err(|e| format!("checking updates: {e}"))?
        .error_for_status()
        .map_err(|e| format!("checking updates: {e}"))?
        .json()
        .await
        .map_err(|e| format!("reading update response: {e}"))?;
    let latest = release.tag_name.trim_start_matches('v').to_string();
    let available = is_newer_version(&latest, &current);
    let download_url = if available {
        matching_release_asset(&release.assets)
            .map(|asset| asset.browser_download_url.clone())
            .or_else(|| Some(release.html_url.clone()))
    } else {
        None
    };
    Ok(UpdateInfo {
        current_version: current,
        latest_version: latest,
        available,
        release_url: release.html_url,
        download_url,
    })
}

fn read_env_file_value(name: &str) -> Option<String> {
    let mut dirs = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd.clone());
        if let Some(parent) = cwd.parent() {
            dirs.push(parent.to_path_buf());
        }
    }
    for dir in dirs {
        let path = dir.join(".env.local");
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let Some((key, value)) = trimmed.split_once('=') else {
                continue;
            };
            if key.trim() != name {
                continue;
            }
            let value = value
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn zapper_api_key() -> Option<String> {
    std::env::var("ZAPPER_APIKEY")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| {
            std::env::var("ZAPPER_API_KEY")
                .ok()
                .filter(|v| !v.trim().is_empty())
        })
        .or_else(|| read_env_file_value("ZAPPER_APIKEY"))
        .or_else(|| read_env_file_value("ZAPPER_API_KEY"))
        .or_else(|| {
            option_env!("ZAPPER_APIKEY")
                .filter(|v| !v.trim().is_empty())
                .map(str::to_string)
        })
        .or_else(|| {
            option_env!("ZAPPER_API_KEY")
                .filter(|v| !v.trim().is_empty())
                .map(str::to_string)
        })
}

fn debank_api_key() -> Option<String> {
    std::env::var("DEBANK_APIKEY")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| {
            std::env::var("DEBANK_API_KEY")
                .ok()
                .filter(|v| !v.trim().is_empty())
        })
        .or_else(|| read_env_file_value("DEBANK_APIKEY"))
        .or_else(|| read_env_file_value("DEBANK_API_KEY"))
        .or_else(|| {
            option_env!("DEBANK_APIKEY")
                .filter(|v| !v.trim().is_empty())
                .map(str::to_string)
        })
        .or_else(|| {
            option_env!("DEBANK_API_KEY")
                .filter(|v| !v.trim().is_empty())
                .map(str::to_string)
        })
}

fn okx_api_key() -> Option<String> {
    std::env::var("OKX_API_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| read_env_file_value("OKX_API_KEY"))
        .or_else(|| {
            option_env!("OKX_API_KEY")
                .filter(|v| !v.trim().is_empty())
                .map(str::to_string)
        })
}

fn okx_secret_key() -> Option<String> {
    std::env::var("OKX_SECRET_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| read_env_file_value("OKX_SECRET_KEY"))
        .or_else(|| {
            option_env!("OKX_SECRET_KEY")
                .filter(|v| !v.trim().is_empty())
                .map(str::to_string)
        })
}

fn okx_passphrase() -> Option<String> {
    std::env::var("OKX_PASSPHRASE")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| read_env_file_value("OKX_PASSPHRASE"))
        .or_else(|| {
            option_env!("OKX_PASSPHRASE")
                .filter(|v| !v.trim().is_empty())
                .map(str::to_string)
        })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OkxQuoteRequest {
    chain_index: String,
    amount: String,
    from_token_address: String,
    to_token_address: String,
    swap_mode: Option<String>,
    price_impact_protection_percent: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OkxSwapRequest {
    chain_index: String,
    amount: String,
    from_token_address: String,
    to_token_address: String,
    swap_mode: Option<String>,
    slippage_percent: String,
    user_wallet_address: String,
    price_impact_protection_percent: Option<String>,
}

type HmacSha256 = Hmac<Sha256>;

fn okx_credentials() -> Result<(String, String, String), String> {
    let api_key = okx_api_key().ok_or_else(|| "OKX_API_KEY is not configured".to_string())?;
    let secret_key =
        okx_secret_key().ok_or_else(|| "OKX_SECRET_KEY is not configured".to_string())?;
    let passphrase =
        okx_passphrase().ok_or_else(|| "OKX_PASSPHRASE is not configured".to_string())?;
    Ok((api_key, secret_key, passphrase))
}

fn utc_timestamp_millis() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let total_secs = now.as_secs() as i64;
    let millis = now.subsec_millis();
    let days = total_secs.div_euclid(86_400);
    let secs_of_day = total_secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3_600;
    let minute = (secs_of_day % 3_600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

// Howard Hinnant's civil-from-days algorithm, adapted for UTC timestamp formatting.
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m as u32, d as u32)
}

fn okx_query(params: &[(&str, String)]) -> String {
    params
        .iter()
        .filter(|(_, value)| !value.trim().is_empty())
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

async fn okx_get(path: &str, params: Vec<(&str, String)>) -> Result<Value, String> {
    let (api_key, secret_key, passphrase) = okx_credentials()?;
    let query = okx_query(&params);
    let request_path = if query.is_empty() {
        path.to_string()
    } else {
        format!("{path}?{query}")
    };
    let url = format!("https://web3.okx.com{request_path}");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("building OKX DEX client: {e}"))?;

    let mut last_rate_limit = None;
    for attempt in 0..=3 {
        let timestamp = utc_timestamp_millis();
        let prehash = format!("{timestamp}GET{request_path}");
        let mut mac =
            HmacSha256::new_from_slice(secret_key.as_bytes()).map_err(|e| e.to_string())?;
        mac.update(prehash.as_bytes());
        let sign = B64.encode(mac.finalize().into_bytes());

        let response = client
            .get(&url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header("OK-ACCESS-KEY", &api_key)
            .header("OK-ACCESS-SIGN", sign)
            .header("OK-ACCESS-TIMESTAMP", timestamp)
            .header("OK-ACCESS-PASSPHRASE", &passphrase)
            .send()
            .await
            .map_err(|e| format!("querying OKX DEX: {e}"))?;

        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let wait = okx_retry_after(response.headers(), attempt);
            last_rate_limit = Some(wait);
            if attempt < 3 {
                tokio::time::sleep(wait).await;
                continue;
            }
        }

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("querying OKX DEX: HTTP {status}: {body}"));
        }

        return response
            .json()
            .await
            .map_err(|e| format!("reading OKX DEX response: {e}"));
    }

    Err(format!(
        "OKX DEX rate limited. Retry after about {}s.",
        last_rate_limit
            .unwrap_or_else(|| Duration::from_secs(4))
            .as_secs()
            .max(1)
    ))
}

fn okx_retry_after(headers: &reqwest::header::HeaderMap, attempt: u32) -> Duration {
    if let Some(seconds) = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
    {
        return Duration::from_secs(seconds.clamp(1, 20));
    }
    let backoff_ms = match attempt {
        0 => 900,
        1 => 1_800,
        2 => 3_600,
        _ => 5_000,
    };
    Duration::from_millis(backoff_ms)
}

#[tauri::command]
async fn okx_dex_supported_chains(chain_index: Option<String>) -> Result<Value, String> {
    let mut params = Vec::new();
    if let Some(chain_index) = chain_index {
        params.push(("chainIndex", chain_index));
    }
    okx_get("/api/v6/dex/aggregator/supported/chain", params).await
}

#[tauri::command]
async fn okx_dex_tokens(chain_index: String) -> Result<Value, String> {
    okx_get(
        "/api/v6/dex/aggregator/all-tokens",
        vec![("chainIndex", chain_index)],
    )
    .await
}

#[tauri::command]
async fn okx_dex_quote(req: OkxQuoteRequest) -> Result<Value, String> {
    let mut params = vec![
        ("chainIndex", req.chain_index),
        ("amount", req.amount),
        ("fromTokenAddress", req.from_token_address),
        ("toTokenAddress", req.to_token_address),
        (
            "swapMode",
            req.swap_mode.unwrap_or_else(|| "exactIn".to_string()),
        ),
    ];
    if let Some(value) = req.price_impact_protection_percent {
        params.push(("priceImpactProtectionPercent", value));
    }
    okx_get("/api/v6/dex/aggregator/quote", params).await
}

#[tauri::command]
async fn okx_dex_swap(req: OkxSwapRequest) -> Result<Value, String> {
    let mut params = vec![
        ("chainIndex", req.chain_index),
        ("amount", req.amount),
        ("fromTokenAddress", req.from_token_address),
        ("toTokenAddress", req.to_token_address),
        (
            "swapMode",
            req.swap_mode.unwrap_or_else(|| "exactIn".to_string()),
        ),
        ("slippagePercent", req.slippage_percent),
        ("userWalletAddress", req.user_wallet_address),
    ];
    if let Some(value) = req.price_impact_protection_percent {
        params.push(("priceImpactProtectionPercent", value));
    }
    okx_get("/api/v6/dex/aggregator/swap", params).await
}

#[tauri::command]
async fn okx_dex_approve_transaction(
    chain_index: String,
    token_contract_address: String,
    approve_amount: String,
) -> Result<Value, String> {
    okx_get(
        "/api/v6/dex/aggregator/approve-transaction",
        vec![
            ("chainIndex", chain_index),
            ("tokenContractAddress", token_contract_address),
            ("approveAmount", approve_amount),
        ],
    )
    .await
}

#[tauri::command]
async fn okx_dex_history(chain_index: String, tx_hash: String) -> Result<Value, String> {
    okx_get(
        "/api/v6/dex/aggregator/history",
        vec![
            ("chainIndex", chain_index),
            ("txHash", tx_hash),
            ("isFromMyProject", "true".to_string()),
        ],
    )
    .await
}

fn value_as_f64(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.parse::<f64>().ok(),
        _ => None,
    }
}

fn value_as_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

fn zapper_display_label(node: &Value) -> String {
    value_as_string(node.pointer("/displayProps/label"))
        .or_else(|| value_as_string(node.get("groupLabel")))
        .or_else(|| value_as_string(node.get("type")))
        .unwrap_or_else(|| "Position".to_string())
}

fn zapper_position_tokens(node: &Value) -> Vec<DefiPositionToken> {
    let mut out = Vec::new();
    if let Some(symbol) = value_as_string(node.get("symbol")) {
        out.push(DefiPositionToken {
            symbol,
            balance: value_as_string(node.get("balance")),
            balance_usd: value_as_f64(node.get("balanceUSD")),
        });
    }
    if let Some(tokens) = node.get("tokens").and_then(Value::as_array) {
        for token in tokens {
            let inner = token.get("token").unwrap_or(token);
            let Some(symbol) = value_as_string(inner.get("symbol")) else {
                continue;
            };
            out.push(DefiPositionToken {
                symbol,
                balance: value_as_string(inner.get("balance")),
                balance_usd: value_as_f64(inner.get("balanceUSD")),
            });
        }
    }
    out
}

fn parse_zapper_positions(data: &Value) -> Vec<DefiPosition> {
    let Some(app_edges) = data
        .pointer("/data/portfolioV2/appBalances/byApp/edges")
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut positions = Vec::new();
    for (app_index, edge) in app_edges.iter().enumerate() {
        let node = edge.get("node").unwrap_or(edge);
        let app_name = value_as_string(node.pointer("/app/displayName"))
            .unwrap_or_else(|| "DeFi app".to_string());
        let app_image_url = value_as_string(node.pointer("/app/imgUrl"));
        let app_url = value_as_string(node.pointer("/app/url"))
            .or_else(|| value_as_string(node.pointer("/app/websiteUrl")));
        let network_name = value_as_string(node.pointer("/network/name"))
            .unwrap_or_else(|| "Unknown network".to_string());
        let chain_id =
            value_as_string(node.pointer("/network/chainId")).unwrap_or_else(|| "unknown".into());
        let app_balance = value_as_f64(node.get("balanceUSD")).unwrap_or(0.0);
        let Some(position_edges) = node
            .pointer("/positionBalances/edges")
            .and_then(Value::as_array)
        else {
            if app_balance > 0.0 {
                positions.push(DefiPosition {
                    id: format!("{app_name}:{chain_id}:{app_index}:summary"),
                    app_name,
                    app_image_url,
                    app_url,
                    network_name,
                    chain_id,
                    label: "Position".to_string(),
                    group_label: None,
                    balance_usd: app_balance,
                    symbols: Vec::new(),
                    tokens: Vec::new(),
                });
            }
            continue;
        };
        for (position_index, position_edge) in position_edges.iter().enumerate() {
            let position = position_edge.get("node").unwrap_or(position_edge);
            let balance_usd = value_as_f64(position.get("balanceUSD")).unwrap_or(0.0);
            if balance_usd <= 0.0 {
                continue;
            }
            let tokens = zapper_position_tokens(position);
            let mut symbols = Vec::new();
            for token in &tokens {
                if !symbols.iter().any(|s| s == &token.symbol) {
                    symbols.push(token.symbol.clone());
                }
            }
            positions.push(DefiPosition {
                id: format!("{app_name}:{chain_id}:{app_index}:{position_index}"),
                app_name: app_name.clone(),
                app_image_url: app_image_url.clone(),
                app_url: app_url.clone(),
                network_name: network_name.clone(),
                chain_id: chain_id.clone(),
                label: zapper_display_label(position),
                group_label: value_as_string(position.get("groupLabel")),
                balance_usd,
                symbols,
                tokens,
            });
        }
    }
    positions.sort_by(|a, b| {
        b.balance_usd
            .partial_cmp(&a.balance_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    positions
}

fn zapper_app_balance_usd(data: &Value) -> f64 {
    value_as_f64(data.pointer("/data/portfolioV2/appBalances/totalBalanceUSD")).unwrap_or(0.0)
}

async fn fetch_zapper_defi_positions(address: &str) -> Result<(Vec<DefiPosition>, f64), String> {
    let key = zapper_api_key().ok_or_else(|| "ZAPPER_APIKEY is not configured".to_string())?;
    println!("[AutoDesktop] defi Zapper start address={address}");
    const QUERY: &str = r#"
query AppBalances($addresses: [Address!]!, $first: Int = 30) {
  portfolioV2(addresses: $addresses) {
    appBalances {
      totalBalanceUSD
      byApp(first: $first) {
        totalCount
        edges {
          node {
            balanceUSD
            app {
              displayName
              imgUrl
              url
              websiteUrl
              description
              category { name }
            }
            network { name chainId }
            positionBalances(first: 30) {
              edges {
                node {
                  ... on AppTokenPositionBalance {
                    type
                    symbol
                    balance
                    balanceUSD
                    price
                    groupLabel
                    displayProps { label images }
                  }
                  ... on ContractPositionBalance {
                    type
                    balanceUSD
                    groupLabel
                    tokens {
                      metaType
                      token {
                        ... on BaseTokenPositionBalance {
                          symbol
                          balance
                          balanceUSD
                        }
                      }
                    }
                    displayProps { label images }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
"#;
    let body = json!({
        "query": QUERY,
        "variables": {
            "addresses": [address],
            "first": 30,
        }
    });
    let data: Value = reqwest::Client::builder()
        .timeout(DEFI_PROVIDER_TIMEOUT)
        .build()
        .map_err(|e| format!("building Zapper client: {e}"))?
        .post("https://public.zapper.xyz/graphql")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("x-zapper-api-key", key)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .header(reqwest::header::PRAGMA, "no-cache")
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AutoDesktop/1.0",
        )
        .header(reqwest::header::ORIGIN, "https://build.zapper.xyz")
        .header(reqwest::header::REFERER, "https://build.zapper.xyz/")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("querying Zapper: {e}"))?
        .error_for_status()
        .map_err(|e| format!("querying Zapper: {e}"))?
        .json()
        .await
        .map_err(|e| format!("reading Zapper response: {e}"))?;
    if let Some(errors) = data.get("errors").and_then(Value::as_array) {
        let msg = errors
            .first()
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("Zapper returned an error");
        return Err(msg.to_string());
    }
    let positions = parse_zapper_positions(&data);
    let app_balance = zapper_app_balance_usd(&data);
    println!(
        "[AutoDesktop] defi Zapper done address={address} positions={} appBalanceUsd={app_balance}",
        positions.len()
    );
    Ok((positions, app_balance))
}

fn debank_chain_name(chain: &str) -> String {
    match chain {
        "eth" => "Ethereum",
        "bsc" => "BSC",
        "arb" => "Arbitrum",
        "op" => "Optimism",
        "matic" => "Polygon",
        "base" => "Base",
        "avax" => "Avalanche",
        "ftm" => "Fantom",
        "xdai" => "Gnosis",
        "linea" => "Linea",
        "zksync" => "zkSync Era",
        "scroll" => "Scroll",
        _ => chain,
    }
    .to_string()
}

fn debank_token_from_value(value: &Value) -> Option<DefiPositionToken> {
    let symbol = value_as_string(value.get("optimized_symbol"))
        .or_else(|| value_as_string(value.get("display_symbol")))
        .or_else(|| value_as_string(value.get("symbol")))?;
    let balance = value_as_string(value.get("amount"))
        .or_else(|| value_as_string(value.get("balance")))
        .or_else(|| value_as_string(value.get("raw_amount")));
    let balance_usd = value_as_f64(value.get("usd_value"))
        .or_else(|| value_as_f64(value.get("net_usd_value")))
        .or_else(|| {
            let amount = value_as_f64(value.get("amount"))?;
            let price = value_as_f64(value.get("price"))?;
            Some(amount * price)
        });
    Some(DefiPositionToken {
        symbol,
        balance,
        balance_usd,
    })
}

fn collect_debank_tokens(value: &Value, out: &mut Vec<DefiPositionToken>) {
    match value {
        Value::Array(items) => {
            for item in items {
                if let Some(token) = debank_token_from_value(item) {
                    out.push(token);
                }
                collect_debank_tokens(item, out);
            }
        }
        Value::Object(map) => {
            for (key, child) in map {
                if key.ends_with("token_list") || key.ends_with("tokens") || key == "token" {
                    collect_debank_tokens(child, out);
                }
            }
        }
        _ => {}
    }
}

fn parse_debank_positions(data: &Value) -> Result<Vec<DefiPosition>, String> {
    let apps = data
        .as_array()
        .ok_or_else(|| "DeBank returned an unexpected response".to_string())?;
    let mut positions = Vec::new();
    for (app_index, app) in apps.iter().enumerate() {
        let app_name = value_as_string(app.get("name")).unwrap_or_else(|| "DeFi app".to_string());
        let app_id = value_as_string(app.get("id")).unwrap_or_else(|| app_name.clone());
        let app_image_url = value_as_string(app.get("logo_url"));
        let app_url = value_as_string(app.get("site_url"));
        let Some(items) = app.get("portfolio_item_list").and_then(Value::as_array) else {
            continue;
        };
        for (position_index, item) in items.iter().enumerate() {
            let net_usd = value_as_f64(item.pointer("/stats/net_usd_value"))
                .or_else(|| value_as_f64(item.pointer("/stats/asset_usd_value")))
                .unwrap_or(0.0);
            if net_usd <= 0.0 {
                continue;
            }
            let chain_id = value_as_string(item.pointer("/base/chain"))
                .or_else(|| value_as_string(app.get("chain")))
                .unwrap_or_else(|| "unknown".to_string());
            let mut tokens = Vec::new();
            collect_debank_tokens(item, &mut tokens);
            let mut symbols = Vec::new();
            tokens.retain(|token| {
                let key = format!(
                    "{}:{}:{}",
                    token.symbol,
                    token.balance.as_deref().unwrap_or(""),
                    token.balance_usd.unwrap_or(0.0)
                );
                if symbols.iter().any(|s| s == &key) {
                    false
                } else {
                    symbols.push(key);
                    true
                }
            });
            let symbols = tokens.iter().fold(Vec::new(), |mut out, token| {
                if !out.iter().any(|s| s == &token.symbol) {
                    out.push(token.symbol.clone());
                }
                out
            });
            positions.push(DefiPosition {
                id: format!("debank:{app_id}:{chain_id}:{app_index}:{position_index}"),
                app_name: app_name.clone(),
                app_image_url: app_image_url.clone(),
                app_url: app_url.clone(),
                network_name: debank_chain_name(&chain_id),
                chain_id,
                label: value_as_string(item.get("name")).unwrap_or_else(|| "Position".to_string()),
                group_label: value_as_string(item.get("detail_types"))
                    .or_else(|| value_as_string(item.get("position_index"))),
                balance_usd: net_usd,
                symbols,
                tokens,
            });
        }
    }
    positions.sort_by(|a, b| {
        b.balance_usd
            .partial_cmp(&a.balance_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(positions)
}

async fn fetch_debank_defi_positions(address: &str) -> Result<Vec<DefiPosition>, String> {
    let key = debank_api_key().ok_or_else(|| "DEBANK_APIKEY is not configured".to_string())?;
    println!("[AutoDesktop] defi DeBank start address={address}");
    let url =
        format!("https://pro-openapi.debank.com/v1/user/all_complex_protocol_list?id={address}");
    let data: Value = reqwest::Client::builder()
        .timeout(DEFI_PROVIDER_TIMEOUT)
        .build()
        .map_err(|e| format!("building DeBank client: {e}"))?
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header("AccessKey", key)
        .send()
        .await
        .map_err(|e| format!("querying DeBank: {e}"))?
        .error_for_status()
        .map_err(|e| format!("querying DeBank: {e}"))?
        .json()
        .await
        .map_err(|e| format!("reading DeBank response: {e}"))?;
    if let Some(msg) = value_as_string(data.get("error_msg")) {
        return Err(msg);
    }
    let positions = parse_debank_positions(&data)?;
    println!(
        "[AutoDesktop] defi DeBank done address={address} positions={}",
        positions.len()
    );
    Ok(positions)
}

#[tauri::command]
async fn get_defi_positions(
    address: String,
    has_wallet_assets_over_one_usd: Option<bool>,
) -> Result<DefiPositionsResponse, String> {
    let address = address.trim();
    println!(
        "[AutoDesktop] defi request address={address} hasWalletAssetsOverOneUsd={}",
        has_wallet_assets_over_one_usd.unwrap_or(false)
    );
    if !(address.len() == 42
        && address.starts_with("0x")
        && address[2..].chars().all(|c| c.is_ascii_hexdigit()))
    {
        return Err("invalid address".to_string());
    }
    let has_wallet_assets = has_wallet_assets_over_one_usd.unwrap_or(false);
    let debank_available = debank_api_key().is_some();
    let zapper = fetch_zapper_defi_positions(address).await;
    let (zapper_positions, zapper_balance_usd) = match zapper {
        Ok(result) => result,
        Err(err) => {
            if has_wallet_assets && debank_available {
                println!(
                    "[AutoDesktop] defi fallback source=DeBank address={address} reason=zapper-error error={err}"
                );
                let positions = fetch_debank_defi_positions(address).await?;
                println!(
                    "[AutoDesktop] defi response source=DeBank address={address} positions={}",
                    positions.len()
                );
                return Ok(DefiPositionsResponse {
                    source: "DeBank".to_string(),
                    positions,
                });
            }
            println!("[AutoDesktop] defi Zapper failed address={address} error={err}");
            return Err(err);
        }
    };
    if !zapper_positions.is_empty()
        || zapper_balance_usd > 0.0
        || !has_wallet_assets
        || !debank_available
    {
        println!(
            "[AutoDesktop] defi response source=Zapper address={address} positions={}",
            zapper_positions.len()
        );
        return Ok(DefiPositionsResponse {
            source: "Zapper".to_string(),
            positions: zapper_positions,
        });
    }
    println!(
        "[AutoDesktop] defi fallback source=DeBank address={address} reason=zapper-empty-wallet-assets-present"
    );
    let positions = fetch_debank_defi_positions(address).await?;
    println!(
        "[AutoDesktop] defi response source=DeBank address={address} positions={}",
        positions.len()
    );
    Ok(DefiPositionsResponse {
        source: "DeBank".to_string(),
        positions,
    })
}

/// Normalize a chain id (accept "0x.." or decimal) to canonical lowercase 0x-hex.
fn normalize_chain_id(id: &str) -> Result<String, String> {
    let s = id.trim();
    let value = match s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        Some(h) => u64::from_str_radix(h, 16).map_err(|_| format!("invalid chain id '{id}'"))?,
        None => s
            .parse::<u64>()
            .map_err(|_| format!("invalid chain id '{id}'"))?,
    };
    if value == 0 {
        return Err("chain id must be non-zero".to_string());
    }
    Ok(format!("0x{value:x}"))
}

/// http(s) only, and plaintext http only for loopback / RFC-1918 LAN hosts —
/// a wallet must never read chain state over a cleartext link an attacker can
/// MITM (fake balances, fake tx status), nor from a scheme that isn't HTTP.
fn validate_rpc(rpc: &str) -> Result<(), String> {
    let url: tauri::Url = rpc
        .parse()
        .map_err(|e| format!("invalid RPC URL '{rpc}': {e}"))?;
    match url.scheme() {
        "https" => {
            if url.host_str().unwrap_or("").is_empty() {
                return Err(format!("RPC URL '{rpc}' has no host"));
            }
            Ok(())
        }
        "http" => {
            let host = url.host_str().unwrap_or("");
            let local = host == "localhost"
                || host
                    .parse::<std::net::IpAddr>()
                    .map(|ip| match ip {
                        std::net::IpAddr::V4(v4) => v4.is_loopback() || v4.is_private(),
                        std::net::IpAddr::V6(v6) => v6.is_loopback(),
                    })
                    .unwrap_or(false);
            if local {
                Ok(())
            } else {
                Err(format!(
                    "plain http RPC is only allowed for localhost/LAN dev nodes, got '{rpc}' — use https://"
                ))
            }
        }
        _ => Err("RPC URL must start with http:// or https://".to_string()),
    }
}

fn validate_explorer_url(url: &str) -> Result<(), String> {
    let parsed: tauri::Url = url
        .parse()
        .map_err(|e| format!("invalid explorer URL '{url}': {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {
            if parsed.host_str().unwrap_or("").is_empty() {
                return Err(format!("explorer URL '{url}' has no host"));
            }
            Ok(())
        }
        _ => Err("explorer URL must start with http:// or https://".to_string()),
    }
}

/// EIP-1193: if a dApp transaction carries a `chainId`, it MUST match the chain
/// the wallet will sign/broadcast on. The wallet's selected chain is global
/// state — another tab or the shell may switch it after the dApp composed the
/// tx — so a mismatch means the user would sign for the wrong network.
fn ensure_tx_chain_id_matches(tx: &Value, current: &str) -> Result<(), String> {
    let Some(requested) = tx.get("chainId") else {
        return Ok(());
    };
    let requested = match requested {
        Value::String(s) => normalize_chain_id(s)?,
        Value::Number(n) => {
            let v = n
                .as_u64()
                .ok_or_else(|| format!("eth_sendTransaction: bad chainId {n}"))?;
            normalize_chain_id(&v.to_string())?
        }
        other => return Err(format!("eth_sendTransaction: bad chainId {other}")),
    };
    let current = normalize_chain_id(current)?;
    if requested != current {
        return Err(format!(
            "eth_sendTransaction: transaction chainId {requested} does not match the wallet's selected chain {current} — switch chains and retry (4901)"
        ));
    }
    Ok(())
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
    chain.explorer_url = match chain.explorer_url {
        Some(url) if !url.trim().is_empty() => {
            let url = url.trim().to_string();
            validate_explorer_url(&url)?;
            Some(url)
        }
        _ => None,
    };
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
        existing.decimals = if chain.decimals == 0 {
            18
        } else {
            chain.decimals
        };
        if !chain.symbol.trim().is_empty() {
            existing.symbol = chain.symbol;
        }
        if !chain.color.trim().is_empty() {
            existing.color = chain.color;
        }
        existing.explorer_url = match chain.explorer_url {
            Some(url) if !url.trim().is_empty() => {
                let url = url.trim().to_string();
                validate_explorer_url(&url)?;
                Some(url)
            }
            _ => None,
        };
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

/// Each wallet is one keystore file under `wallets/<id>.json` in the app-data dir,
/// so several independent wallets (seeds / private keys / Ledgers) coexist. A
/// pre-multi-wallet install kept a single `vault.json`; `migrate_legacy_keystore`
/// folds that into the new dir on first read.
const WALLETS_DIR: &str = "wallets";
const LEGACY_KEYSTORE_FILE: &str = "vault.json";

fn wallets_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(WALLETS_DIR))
}

/// Path to one wallet's keystore. `id` is our own random hex; still validate it so
/// a crafted id can never traverse out of the wallets dir.
fn wallet_file<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("invalid wallet id".to_string());
    }
    Ok(wallets_dir(app)?.join(format!("{id}.json")))
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_secs() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
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

/// Fold a legacy single-vault `vault.json` into `wallets/<id>.json` (assigning an
/// id + label) once, before any multi-wallet read. Idempotent: removes the legacy
/// file only after the new one is safely written.
fn migrate_legacy_keystore<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let legacy = base.join(LEGACY_KEYSTORE_FILE);
    if !legacy.exists() {
        return Ok(());
    }
    if let Some(mut ks) = read_keystore(&legacy)? {
        if ks.id.is_empty() {
            ks.id = vault::new_wallet_id();
        }
        if ks.label.is_empty() {
            ks.label = "Wallet 1".to_string();
        }
        let dest = wallet_file(app, &ks.id)?;
        write_keystore(&dest, &ks)?;
    }
    let _ = std::fs::remove_file(&legacy);
    Ok(())
}

/// Every wallet keystore on disk, in stable creation order (migrating the legacy
/// single vault first). The shell renders the wallet switcher from this.
fn read_all_keystores<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<vault::Keystore>, String> {
    migrate_legacy_keystore(app)?;
    let dir = wallets_dir(app)?;
    let mut out: Vec<vault::Keystore> = Vec::new();
    match std::fs::read_dir(&dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|x| x.to_str()) == Some("json") {
                    if let Some(ks) = read_keystore(&path)? {
                        out.push(ks);
                    }
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("reading wallets dir: {e}")),
    }
    // Stable order: by creation time, then id (creation is 0 for migrated wallets).
    out.sort_by(|a, b| a.created.cmp(&b.created).then_with(|| a.id.cmp(&b.id)));
    Ok(out)
}

/// Default label for the next wallet ("Wallet N", N = count + 1).
fn next_wallet_label<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    Ok(format!("Wallet {}", read_all_keystores(app)?.len() + 1))
}

/// The app password to seal a new SOFTWARE wallet with, plus whether to record it
/// in the store (Some only when this call establishes the password). If we're
/// already unlocked with a password, reuse it (no re-prompt); otherwise the caller
/// must supply one (≥8 chars) — and if software wallets already exist on disk, it
/// must decrypt one of them, so every software wallet shares the one app password.
fn resolve_app_password<R: Runtime>(
    app: &AppHandle<R>,
    provided: Option<String>,
) -> Result<(Zeroizing<String>, Option<Zeroizing<String>>), String> {
    if let Some(pw) = store_state()
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|s| s.password.clone())
    {
        return Ok((pw, None));
    }
    let pw = provided.ok_or("a password is required to add this wallet")?;
    if pw.len() < 8 {
        return Err("password must be at least 8 characters".to_string());
    }
    if let Some(existing) = read_all_keystores(app)?
        .iter()
        .find(|k| k.kind == "hd" || k.kind == "privkey")
    {
        vault::open(&pw, existing).map_err(|_| "incorrect password".to_string())?;
    }
    let pw = Zeroizing::new(pw);
    Ok((pw.clone(), Some(pw)))
}

/// One wallet for the shell switcher: its id, label, secret kind, and account
/// addresses.
#[derive(Serialize)]
struct WalletInfo {
    id: String,
    label: String,
    /// "hd" | "privkey" | "ledger".
    kind: String,
    accounts: Vec<String>,
}

#[derive(Serialize)]
struct VaultStatus {
    /// At least one wallet keystore exists on disk.
    exists: bool,
    /// The wallets are unlocked in memory this session.
    unlocked: bool,
    /// An app password is set (any software wallet exists). When false, the only
    /// wallets are Ledgers (no password) and the shell can skip the unlock screen.
    has_password: bool,
    /// All wallets (from memory when unlocked, else on-disk metadata for display).
    wallets: Vec<WalletInfo>,
    /// The active account address, if any.
    active: Option<String>,
}

fn store_wallet_infos(store: &WalletStore) -> Vec<WalletInfo> {
    store
        .wallets
        .iter()
        .map(|w| WalletInfo {
            id: w.id.clone(),
            label: w.label.clone(),
            kind: w.kind().to_string(),
            accounts: w.accounts.iter().map(|a| a.address.clone()).collect(),
        })
        .collect()
}

fn disk_wallet_infos(disk: &[vault::Keystore]) -> Vec<WalletInfo> {
    disk.iter()
        .map(|k| WalletInfo {
            id: k.id.clone(),
            label: k.label.clone(),
            kind: k.kind.clone(),
            accounts: k.accounts.iter().map(|a| a.address.clone()).collect(),
        })
        .collect()
}

/// Newly created wallet — returns the mnemonic ONCE so the trusted shell can show
/// the backup screen. (The dApp boundary never sees this; vault commands are
/// shell-only.)
#[derive(Serialize)]
struct NewVault {
    id: String,
    address: String,
    mnemonic: String,
}

/// A newly added wallet (id + active address) for import/connect paths.
#[derive(Serialize)]
struct WalletRef {
    id: String,
    address: String,
}

/// Decrypted secret for an explicit user export. Only the trusted shell can call
/// this command, and it still requires the app password so a casual unlocked
/// session cannot leak a seed/key by accident.
#[derive(Serialize)]
struct ExportedSecret {
    /// `Zeroizing` so the decrypted plaintext is scrubbed from memory once the IPC
    /// response is serialized — matching how the rest of `mod vault` holds secrets.
    /// The caller already knows the wallet kind, so it isn't echoed back here.
    secret: Zeroizing<String>,
}

/// Whether any wallet exists / is unlocked, the full wallet list, and the active
/// account. The shell renders the switcher + gates the lock screen from this.
#[tauri::command]
fn vault_status<R: Runtime>(app: AppHandle<R>) -> Result<VaultStatus, String> {
    let disk = read_all_keystores(&app)?;
    let has_password = disk.iter().any(|k| k.kind == "hd" || k.kind == "privkey");
    let guard = store_state().lock().unwrap();
    let (wallets, active) = match guard.as_ref() {
        Some(store) => (
            store_wallet_infos(store),
            (!store.active.is_empty()).then(|| store.active.clone()),
        ),
        None => (
            disk_wallet_infos(&disk),
            disk.iter()
                .find_map(|k| k.accounts.first())
                .map(|a| a.address.clone()),
        ),
    };
    Ok(VaultStatus {
        exists: !disk.is_empty(),
        unlocked: guard.is_some(),
        has_password,
        wallets,
        active,
    })
}

/// Add a brand-new HD wallet: generate a mnemonic, seal it under the app password,
/// persist it as a new keystore, and add it to the unlocked store (active). The
/// `password` is required only when establishing the app password (first software
/// wallet); when already unlocked it is ignored. Returns the mnemonic for the
/// one-time backup screen.
#[tauri::command]
fn create_vault<R: Runtime>(
    app: AppHandle<R>,
    password: Option<String>,
) -> Result<NewVault, String> {
    let (pw, store_pw) = resolve_app_password(&app, password)?;
    let mnemonic = vault::generate_mnemonic()?;
    let id = vault::new_wallet_id();
    let label = next_wallet_label(&app)?;
    let (accounts, metas) = derive_hd_accounts(&mnemonic, 1)?;
    let mut ks = vault::seal(&pw, &mnemonic, "hd", metas)?;
    ks.id = id.clone();
    ks.label = label.clone();
    ks.created = now_ms();
    write_keystore(&wallet_file(&app, &id)?, &ks)?;
    let wallet = UnlockedWallet {
        id: id.clone(),
        label,
        secret: VaultSecret::Mnemonic(Zeroizing::new(mnemonic.clone())),
        accounts,
    };
    let address = store_push_wallet(wallet, store_pw);
    push_accounts_changed(&app, Some(&address));
    Ok(NewVault {
        id,
        address,
        mnemonic,
    })
}

/// Add a wallet from a recovery phrase. Returns the new wallet's id + active address.
#[tauri::command]
fn import_vault<R: Runtime>(
    app: AppHandle<R>,
    password: Option<String>,
    mnemonic: String,
) -> Result<WalletRef, String> {
    vault::validate_mnemonic(&mnemonic)?;
    let (pw, store_pw) = resolve_app_password(&app, password)?;
    let id = vault::new_wallet_id();
    let label = next_wallet_label(&app)?;
    let (accounts, metas) = derive_hd_accounts(&mnemonic, 1)?;
    let mut ks = vault::seal(&pw, &mnemonic, "hd", metas)?;
    ks.id = id.clone();
    ks.label = label.clone();
    ks.created = now_ms();
    write_keystore(&wallet_file(&app, &id)?, &ks)?;
    let wallet = UnlockedWallet {
        id: id.clone(),
        label,
        secret: VaultSecret::Mnemonic(Zeroizing::new(mnemonic.trim().to_string())),
        accounts,
    };
    let address = store_push_wallet(wallet, store_pw);
    push_accounts_changed(&app, Some(&address));
    Ok(WalletRef { id, address })
}

/// Add a wallet from a single raw private key (single-account — no mnemonic to
/// derive from). Returns the new wallet's id + active address.
#[tauri::command]
fn import_private_key<R: Runtime>(
    app: AppHandle<R>,
    password: Option<String>,
    private_key: String,
) -> Result<WalletRef, String> {
    // Validate + canonicalize to 0x-lowercase-hex before sealing, so unlock
    // re-derives the same address deterministically.
    let key = vault::parse_private_key(&private_key)?;
    let key_hex = Zeroizing::new(format!("0x{}", hex::encode(key.to_bytes())));
    let address = address_from_verifying_key(key.verifying_key());
    let (pw, store_pw) = resolve_app_password(&app, password)?;
    let id = vault::new_wallet_id();
    let label = next_wallet_label(&app)?;
    let metas = vec![vault::AccountMeta {
        index: 0,
        address: address.clone(),
    }];
    let mut ks = vault::seal(&pw, &key_hex, "privkey", metas)?;
    ks.id = id.clone();
    ks.label = label.clone();
    ks.created = now_ms();
    write_keystore(&wallet_file(&app, &id)?, &ks)?;
    let wallet = UnlockedWallet {
        id: id.clone(),
        label,
        secret: VaultSecret::PrivateKey,
        accounts: vec![UnlockedAccount {
            index: 0,
            address,
            signer: Signer::Local(key),
        }],
    };
    let address = store_push_wallet(wallet, store_pw);
    push_accounts_changed(&app, Some(&address));
    Ok(WalletRef { id, address })
}

/// Export the selected software wallet's root secret after password re-check.
/// HD wallets return their recovery phrase; imported private-key wallets return
/// the canonical 0x private key. Ledger wallets have no local secret to export.
#[tauri::command]
fn export_wallet_secret<R: Runtime>(
    app: AppHandle<R>,
    wallet_id: String,
    password: String,
) -> Result<ExportedSecret, String> {
    let path = wallet_file(&app, &wallet_id)?;
    let ks = read_keystore(&path)?.ok_or("wallet not found")?;
    match ks.kind.as_str() {
        "hd" | "privkey" => Ok(ExportedSecret {
            secret: vault::open(&password, &ks)?,
        }),
        "ledger" => Err("Ledger wallets do not have a local secret to export".to_string()),
        _ => Err(format!("unsupported wallet kind {}", ks.kind)),
    }
}

/// On boot, auto-load wallets ONLY when there is no app password to enter — i.e. a
/// Ledger-only (or empty) setup. Their addresses are public, so they open straight
/// to the wallet with no lock screen (matching the old single-Ledger behaviour). If
/// ANY software wallet exists, do nothing: the app stays locked until the user
/// enters the password (which also loads the Ledger wallets).
fn boot_load_ledger_only<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let disk = read_all_keystores(app)?;
    let has_software = disk.iter().any(|k| k.kind == "hd" || k.kind == "privkey");
    if has_software || disk.is_empty() {
        return Ok(());
    }
    let mut wallets = Vec::new();
    for ks in disk.iter().filter(|k| k.kind == "ledger") {
        wallets.push(build_ledger_wallet_from_keystore(ks)?);
    }
    let active = wallets
        .iter()
        .flat_map(|w| &w.accounts)
        .next()
        .map(|a| a.address.clone())
        .unwrap_or_default();
    *store_state().lock().unwrap() = Some(WalletStore {
        password: None,
        wallets,
        active,
    });
    Ok(())
}

/// Unlock ALL wallets with the one app `password`: decrypt every software wallet
/// (a wrong password fails the AEAD tag check → "incorrect password") and load the
/// Ledger wallets (public addresses, no secret). The password is kept in memory so
/// further software wallets can be added without re-prompting. Returns the active
/// address.
#[tauri::command]
fn unlock_vault<R: Runtime>(app: AppHandle<R>, password: String) -> Result<String, String> {
    let disk = read_all_keystores(&app)?;
    if disk.is_empty() {
        return Err("no wallet to unlock".to_string());
    }
    let mut wallets = Vec::with_capacity(disk.len());
    let mut used_password = false;
    for ks in &disk {
        let wallet = match ks.kind.as_str() {
            "ledger" => build_ledger_wallet_from_keystore(ks)?,
            "privkey" => {
                let secret = vault::open(&password, ks)?;
                used_password = true;
                build_privkey_wallet_from_keystore(ks, &secret)?
            }
            // "hd" + legacy keystores with no `kind` (defaulted to "hd").
            _ => {
                let secret = vault::open(&password, ks)?;
                used_password = true;
                build_hd_wallet_from_keystore(ks, secret)?
            }
        };
        wallets.push(wallet);
    }
    let active = wallets
        .iter()
        .flat_map(|w| &w.accounts)
        .next()
        .map(|a| a.address.clone())
        .unwrap_or_default();
    let password = used_password.then(|| Zeroizing::new(password));
    *store_state().lock().unwrap() = Some(WalletStore {
        password,
        wallets,
        active: active.clone(),
    });
    if active.is_empty() {
        return Err("unlock failed".to_string());
    }
    Ok(active)
}

/// Lock the wallet: drop all decrypted key material (and the app password) from
/// memory.
#[tauri::command]
fn lock_vault() {
    *store_state().lock().unwrap() = None;
}

/// Reset EVERYTHING: drop in-memory keys AND delete every keystore, so the app
/// returns to first-run onboarding. This is the "忘记密码" escape hatch — it is
/// IRREVERSIBLE and destroys the only copy of every encrypted secret, so the UI must
/// gate it behind an explicit, clearly-worded confirmation (funds are unrecoverable
/// without the user's own mnemonic/key backups). To remove a single wallet, use
/// `delete_wallet`.
#[tauri::command]
fn reset_vault<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    *store_state().lock().unwrap() = None;
    let dir = wallets_dir(&app)?;
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("removing wallets dir: {e}")),
    }
    // Also drop any un-migrated legacy keystore.
    if let Ok(base) = app.path().app_data_dir() {
        let _ = std::fs::remove_file(base.join(LEGACY_KEYSTORE_FILE));
    }
    Ok(())
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
    // One picker page is 20 addresses; the UI fetches them in small chunks so it
    // can render each as it streams in (the device derives them sequentially).
    let count = count.clamp(1, 20);
    let indices: Vec<u32> = (start..start.saturating_add(count)).collect();
    let rows = ledger::get_addresses(&indices)?;
    Ok(rows
        .into_iter()
        .map(|(index, path, address)| LedgerAccount {
            index,
            path,
            address,
        })
        .collect())
}

/// Add a Ledger wallet at `path`: re-read its address from the device, persist a
/// Ledger keystore (path + address; no secret at rest), and add it to the store
/// (no password). Returns the new wallet's id + address.
#[tauri::command]
fn connect_ledger<R: Runtime>(app: AppHandle<R>, path: String) -> Result<WalletRef, String> {
    let address = ledger::get_address(&path)?;
    let id = vault::new_wallet_id();
    let label = next_wallet_label(&app)?;
    let metas = vec![vault::AccountMeta {
        index: 0,
        address: address.clone(),
    }];
    let mut ks = vault::ledger_keystore(&path, metas);
    ks.id = id.clone();
    ks.label = label.clone();
    ks.created = now_ms();
    write_keystore(&wallet_file(&app, &id)?, &ks)?;
    let wallet = UnlockedWallet {
        id: id.clone(),
        label,
        secret: VaultSecret::Ledger,
        accounts: vec![UnlockedAccount {
            index: 0,
            address: address.clone(),
            signer: Signer::Ledger { path },
        }],
    };
    // A Ledger adds no app password (None never overwrites an existing one).
    let address = store_push_wallet(wallet, None);
    push_accounts_changed(&app, Some(&address));
    Ok(WalletRef { id, address })
}

/// Switch the active account by ADDRESS (feature ①: 切换钱包地址), across all
/// wallets. Pushes EIP-1193 `accountsChanged` to open dApps. Returns the address.
#[tauri::command]
fn select_account<R: Runtime>(app: AppHandle<R>, address: String) -> Result<String, String> {
    let address = normalize_evm_address(&address)?;
    {
        let mut guard = store_state().lock().unwrap();
        let store = guard.as_mut().ok_or("wallet is locked")?;
        let known = store
            .wallets
            .iter()
            .flat_map(|w| &w.accounts)
            .any(|a| a.address == address);
        if !known {
            return Err(format!("unknown account {address}"));
        }
        store.active = address.clone();
    }
    *exposed_account_state().lock().unwrap() = Some(ExposedAccount::Signer(address.clone()));
    push_accounts_changed(&app, Some(&address));
    Ok(address)
}

/// Expose a public address to dApps without making it a signer. This is used for
/// watch-only accounts so portfolio dApps (DeBank, scanners, dashboards) can read
/// the selected address while signing still fails unless the active signer matches.
#[tauri::command]
fn expose_dapp_account<R: Runtime>(app: AppHandle<R>, address: String) -> Result<String, String> {
    let address = normalize_evm_address(&address)?;
    *exposed_account_state().lock().unwrap() = Some(ExposedAccount::WatchOnly(address.clone()));
    push_accounts_changed(&app, Some(&address));
    Ok(address)
}

/// Derive the next HD account in wallet `wallet_id`, persist it to that keystore's
/// (plaintext) account list, and return its address. The encrypted mnemonic is
/// unchanged, so no password is needed.
#[tauri::command]
fn add_account<R: Runtime>(app: AppHandle<R>, wallet_id: String) -> Result<String, String> {
    let (address, metas) = {
        let mut guard = store_state().lock().unwrap();
        let store = guard.as_mut().ok_or("wallet is locked")?;
        let w = store
            .wallets
            .iter_mut()
            .find(|w| w.id == wallet_id)
            .ok_or("wallet not found")?;
        let mnemonic = match &w.secret {
            VaultSecret::Mnemonic(m) => m.clone(),
            VaultSecret::PrivateKey => {
                return Err("imported private-key wallets can't derive more accounts".to_string())
            }
            VaultSecret::Ledger => {
                return Err("Ledger accounts are added by connecting the device".to_string())
            }
        };
        let next_index = w
            .accounts
            .iter()
            .map(|a| a.index)
            .max()
            .map_or(0, |m| m + 1);
        let (key, address) = vault::derive_account(&mnemonic, next_index)?;
        w.accounts.push(UnlockedAccount {
            index: next_index,
            address: address.clone(),
            signer: Signer::Local(key),
        });
        let metas = w
            .accounts
            .iter()
            .map(|a| vault::AccountMeta {
                index: a.index,
                address: a.address.clone(),
            })
            .collect::<Vec<_>>();
        (address, metas)
    };
    // Persist the grown account list (public metadata only — ciphertext untouched).
    let path = wallet_file(&app, &wallet_id)?;
    if let Some(mut ks) = read_keystore(&path)? {
        ks.accounts = metas;
        write_keystore(&path, &ks)?;
    }
    Ok(address)
}

/// Rename wallet `id` (label is plaintext metadata — no password needed).
#[tauri::command]
fn rename_wallet<R: Runtime>(app: AppHandle<R>, id: String, label: String) -> Result<(), String> {
    let label = label.trim().to_string();
    if label.is_empty() {
        return Err("wallet name cannot be empty".to_string());
    }
    let path = wallet_file(&app, &id)?;
    let mut ks = read_keystore(&path)?.ok_or("wallet not found")?;
    ks.label = label.clone();
    write_keystore(&path, &ks)?;
    if let Some(store) = store_state().lock().unwrap().as_mut() {
        if let Some(w) = store.wallets.iter_mut().find(|w| w.id == id) {
            w.label = label;
        }
    }
    Ok(())
}

/// Delete wallet `id`: remove its keystore from disk and from memory. If it held the
/// active account, the active is moved to another account (or cleared when none
/// remain). IRREVERSIBLE for a software wallet — the UI must confirm first.
#[tauri::command]
fn delete_wallet<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    let path = wallet_file(&app, &id)?;
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("removing keystore: {e}")),
    }
    let new_active = {
        let mut guard = store_state().lock().unwrap();
        match guard.as_mut() {
            Some(store) => {
                store.wallets.retain(|w| w.id != id);
                if store.wallets.is_empty() {
                    *guard = None;
                    Some(None) // nothing left → no active account
                } else {
                    let still = store
                        .wallets
                        .iter()
                        .flat_map(|w| &w.accounts)
                        .any(|a| a.address == store.active);
                    if !still {
                        store.active = store
                            .wallets
                            .iter()
                            .flat_map(|w| &w.accounts)
                            .next()
                            .map(|a| a.address.clone())
                            .unwrap_or_default();
                    }
                    Some(Some(store.active.clone()))
                }
            }
            None => None,
        }
    };
    if let Some(active) = new_active {
        push_accounts_changed(&app, active.as_deref());
    }
    Ok(())
}

/// Push an EIP-1193 `accountsChanged` to every open dApp tab (same eval-push
/// mechanism as `chainChanged`, so dApps keep ONLY allow-wallet-request).
fn push_accounts_changed<R: Runtime>(app: &AppHandle<R>, address: Option<&str>) {
    let accounts = address.map(|a| vec![a]).unwrap_or_default();
    let payload = serde_json::to_string(&accounts).unwrap_or_else(|_| "[]".into());
    let js = format!(
        "window.__autoWalletPush && window.__autoWalletPush('accountsChanged', {payload});"
    );
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
const WIN_W: f64 = 1350.0;
const WIN_H: f64 = 880.0;
const MIN_WIN_W: f64 = 940.0;
const MIN_WIN_H: f64 = 600.0;
const SMALL_SCREEN_W: f64 = 1280.0;
const SMALL_SCREEN_H: f64 = 800.0;
const MEDIUM_SCREEN_W: f64 = 1728.0;
const MEDIUM_SCREEN_H: f64 = 1117.0;
const LARGE_SCREEN_W: f64 = 2560.0;
const LARGE_SCREEN_H: f64 = 1440.0;

/// The real EIP-1193/EIP-6963 provider from the frontend wallet core, bundled to a
/// self-contained IIFE by `bun run build:injected` and embedded at compile time.
/// Injected into every dApp webview before page scripts.
const INPAGE_PROVIDER: &str = include_str!("../injected/inpage.js");

fn startup_window_size<R: Runtime>(app: &tauri::App<R>) -> (LogicalSize<f64>, bool) {
    let preferred = LogicalSize::new(WIN_W, WIN_H);
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return (preferred, false);
    };
    let work_area = monitor
        .work_area()
        .size
        .to_logical::<f64>(monitor.scale_factor());
    let w = work_area.width;
    let h = work_area.height;

    // The embedded dApp browser benefits more from width than the wallet pages do.
    // Pick startup sizes by usable monitor area, keeping small screens maximized
    // and giving large displays a wider canvas without making the app feel full-screen.
    if w <= SMALL_SCREEN_W || h <= SMALL_SCREEN_H {
        return (LogicalSize::new(w, h), true);
    }

    let target = if w <= MEDIUM_SCREEN_W || h <= MEDIUM_SCREEN_H {
        LogicalSize::new((w * 0.92).min(1440.0), (h * 0.9).min(900.0))
    } else if w <= LARGE_SCREEN_W || h <= LARGE_SCREEN_H {
        LogicalSize::new((w * 0.82).min(1680.0), (h * 0.84).min(980.0))
    } else {
        LogicalSize::new((w * 0.72).min(1860.0), (h * 0.78).min(1080.0))
    };

    (
        LogicalSize::new(
            target.width.clamp(MIN_WIN_W.min(w), w),
            target.height.clamp(MIN_WIN_H.min(h), h),
        ),
        false,
    )
}

fn restore_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn should_hide_on_close<R: Runtime>(app: &AppHandle<R>) -> bool {
    #[cfg(target_os = "macos")]
    {
        load_app_prefs(app).close_behavior == CloseBehavior::Hide
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        false
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            println!(
                "[AutoDesktop] adipc beacon: {}  origin={origin}",
                request.uri()
            );
            tauri::http::Response::builder()
                .status(200)
                .header("Access-Control-Allow-Origin", "*")
                .header(tauri::http::header::CONTENT_TYPE, "application/json")
                .body(br#"{"ok":true}"#.to_vec())
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![
            wallet_request,
            dapp_dialog,
            resolve_dapp_dialog,
            approve_request,
            reject_request,
            get_pending_requests,
            open_dapp,
            set_dapp_bounds,
            sync_toast_overlay,
            sync_menu_overlay,
            reload_dapp,
            hide_dapp,
            close_dapp,
            open_external_url,
            node_rpc,
            simulate_tx,
            wallet_send,
            set_active_chain,
            get_active_chain,
            get_close_behavior,
            set_close_behavior,
            check_for_update,
            get_activity,
            sync_activity_receipts,
            replace_activity_transaction,
            get_portfolio_history,
            record_portfolio_snapshot,
            get_defi_positions,
            okx_dex_supported_chains,
            okx_dex_tokens,
            okx_dex_quote,
            okx_dex_swap,
            okx_dex_approve_transaction,
            okx_dex_history,
            get_chains,
            add_chain,
            update_chain,
            remove_chain,
            vault_status,
            create_vault,
            import_vault,
            import_private_key,
            export_wallet_secret,
            unlock_vault,
            lock_vault,
            reset_vault,
            ledger_addresses,
            connect_ledger,
            select_account,
            expose_dapp_account,
            add_account,
            rename_wallet,
            delete_wallet
        ])
        .setup(|app| {
            // Load any persisted custom networks / RPC overrides before the UI asks.
            load_chains(app.handle());
            // A Ledger-only setup has no secret at rest, so load it on boot (paths +
            // addresses are public) — it boots straight to the wallet, no password.
            // (Migrates a legacy vault.json into wallets/ as a side effect.)
            if let Err(e) = boot_load_ledger_only(app.handle()) {
                println!("[AutoDesktop] warn: could not restore Ledger wallets: {e}");
            }
            install_debug_menu(app)?;
            let (startup_size, should_maximize) = startup_window_size(app);
            // Container window (no webview of its own).
            let window = WindowBuilder::new(app, "main")
                .title("AutoDesktop")
                .inner_size(startup_size.width, startup_size.height)
                .min_inner_size(
                    MIN_WIN_W.min(startup_size.width),
                    MIN_WIN_H.min(startup_size.height),
                )
                .maximized(should_maximize)
                .resizable(true)
                .center()
                .build()?;

            // Shell webview (local, trusted): our React UI, fills the whole window.
            let shell_builder = WebviewBuilder::new("shell", WebviewUrl::App("index.html".into()));
            let shell =
                window.add_child(shell_builder, LogicalPosition::new(0.0, 0.0), startup_size)?;

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
            let window_for_close = window.clone();
            let app_for_window_events = app.handle().clone();
            window.on_window_event(move |event| match event {
                tauri::WindowEvent::Resized(size) => {
                    let scale = shell_for_resize.window().scale_factor().unwrap_or(1.0);
                    let logical = size.to_logical::<f64>(scale);
                    let _ =
                        shell_for_resize.set_size(LogicalSize::new(logical.width, logical.height));
                    repair_active_dapp_after_shell_resize(&app_for_window_events);
                }
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if should_hide_on_close(&app_for_window_events) {
                        api.prevent_close();
                        let _ = window_for_close.hide();
                    }
                }
                _ => {}
            });

            // CI smoke mode (no-op unless AUTODESKTOP_SMOKE_DIR is set): opens a
            // loopback-served dApp page in a real dapp-* webview and reports
            // whether the injected provider answered. See src/smoke.rs + ci.yml.
            smoke::maybe_start(app.handle());

            Ok(())
        })
        .build(build_context())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            {
                if let tauri::RunEvent::Reopen { .. } = event {
                    restore_main_window(app);
                }
            }
        });
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
    fn provided_legacy_gas_price_maps_to_eip1559_fees() {
        let tx = json!({ "gasPrice": "0x59682f00" }); // 1.5 gwei

        assert_eq!(
            resolve_provided_fees(&tx),
            Some(("0x59682f00".to_string(), "0x59682f00".to_string()))
        );
    }

    #[test]
    fn zero_eip1559_fees_are_not_treated_as_provided() {
        let tx = json!({
            "maxPriorityFeePerGas": "0x0",
            "maxFeePerGas": "0x0",
        });

        assert_eq!(resolve_provided_fees(&tx), None);
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
    fn validate_rpc_requires_https_except_local_dev() {
        assert!(validate_rpc("https://rpc.example.com").is_ok());
        // Plain http is fine for local/LAN dev nodes…
        assert!(validate_rpc("http://localhost:8545").is_ok());
        assert!(validate_rpc("http://127.0.0.1:8545").is_ok());
        assert!(validate_rpc("http://192.168.1.50:8545").is_ok());
        assert!(validate_rpc("http://10.0.0.7:8545").is_ok());
        // …but NOT for arbitrary internet hosts (cleartext = MITM-able RPC).
        assert!(validate_rpc("http://rpc.example.com").is_err());
        assert!(validate_rpc("http://8.8.8.8:8545").is_err());
        assert!(validate_rpc("ftp://nope").is_err());
        assert!(validate_rpc("rpc.example.com").is_err());
        assert!(validate_rpc("https://").is_err());
    }

    #[test]
    fn tx_chain_id_must_match_selected_chain() {
        // No chainId in the tx → nothing to check (wallet's chain is used).
        assert!(ensure_tx_chain_id_matches(&json!({"to": "0x00"}), "0x1").is_ok());
        // Matching chainId, any accepted notation.
        assert!(ensure_tx_chain_id_matches(&json!({"chainId": "0x1"}), "0x1").is_ok());
        assert!(ensure_tx_chain_id_matches(&json!({"chainId": "0XA4B1"}), "0xa4b1").is_ok());
        assert!(ensure_tx_chain_id_matches(&json!({"chainId": 137}), "0x89").is_ok());
        // Mismatch → hard error: the wallet's global chain may have been switched
        // (another tab / the shell) after the dApp composed this transaction.
        let err = ensure_tx_chain_id_matches(&json!({"chainId": "0x89"}), "0x1").unwrap_err();
        assert!(err.contains("0x89") && err.contains("0x1"), "got: {err}");
        // Junk chainId → error, not silently ignored.
        assert!(ensure_tx_chain_id_matches(&json!({"chainId": "zzz"}), "0x1").is_err());
        assert!(ensure_tx_chain_id_matches(&json!({"chainId": true}), "0x1").is_err());
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
    fn estimated_gas_gets_twenty_percent_margin() {
        assert_eq!(bump_estimated_gas("0x5208").unwrap(), "0x6270"); // 21000 -> 25200
        assert_eq!(bump_estimated_gas("0xc351").unwrap(), "0xea62"); // ceil(50001 * 1.2)
        assert_eq!(bump_estimated_gas("0x0").unwrap(), "0x0");
    }

    #[test]
    fn parses_debank_protocol_positions() {
        let data = json!([
            {
                "id": "arb_gmx",
                "chain": "arb",
                "name": "GMX",
                "site_url": "https://app.gmx.io",
                "logo_url": "https://example.com/gmx.png",
                "portfolio_item_list": [
                    {
                        "name": "Staked",
                        "stats": { "net_usd_value": 5.5, "asset_usd_value": 5.5, "debt_usd_value": 0 },
                        "base": { "chain": "arb" },
                        "asset_token_list": [
                            { "symbol": "GMX", "amount": 1.25, "price": 4.4, "usd_value": 5.5 }
                        ]
                    }
                ]
            }
        ]);
        let positions = parse_debank_positions(&data).unwrap();
        assert_eq!(positions.len(), 1);
        assert_eq!(positions[0].app_name, "GMX");
        assert_eq!(positions[0].network_name, "Arbitrum");
        assert_eq!(positions[0].balance_usd, 5.5);
        assert_eq!(positions[0].symbols, vec!["GMX"]);
    }

    #[test]
    fn parses_erc20_transfer_activity() {
        let data = concat!(
            "0xa9059cbb",
            "00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8",
            "000000000000000000000000000000000000000000000000000000000012d687"
        );
        let parsed = parse_erc20_transfer(data).unwrap();
        assert_eq!(parsed.0, "0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
        assert_eq!(parsed.1, "0x12d687");
        assert!(parse_erc20_transfer("0x095ea7b3").is_none());
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

    #[test]
    fn add_ethereum_chain_switches_known_and_adds_new() {
        // A chain already in the registry → just switch (keep OUR rpc, ignore dApp's).
        let known = handle_wallet_method(
            "wallet_addEthereumChain",
            &[json!({ "chainId": "0xa86a", "rpcUrls": ["https://evil.example/rpc"] })],
            "0x1",
            None,
        )
        .unwrap();
        assert_eq!(known, WalletOutcome::SwitchChain("0xa86a".to_string()));

        // A brand-new chain → AddChain built from the EIP-3085 params.
        let added = handle_wallet_method(
            "wallet_addEthereumChain",
            &[json!({
                "chainId": "0x440b",
                "chainName": "Local Test Net",
                "rpcUrls": ["https://rpc.localtest.example"],
                "nativeCurrency": { "symbol": "LTN", "decimals": 18 }
            })],
            "0x1",
            None,
        )
        .unwrap();
        match added {
            WalletOutcome::AddChain(c) => {
                assert_eq!(c.id, "0x440b");
                assert_eq!(c.name, "Local Test Net");
                assert_eq!(c.symbol, "LTN");
                assert_eq!(c.rpc, "https://rpc.localtest.example");
                assert!(!c.builtin);
            }
            other => panic!("expected AddChain, got {other:?}"),
        }

        // A new chain with a non-http(s) rpc is rejected (no malicious scheme).
        assert!(handle_wallet_method(
            "wallet_addEthereumChain",
            &[json!({ "chainId": "0x440c", "chainName": "X", "rpcUrls": ["ftp://nope"] })],
            "0x1",
            None,
        )
        .is_err());
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
                dapp_dialog,
                resolve_dapp_dialog,
                approve_request,
                reject_request,
                get_pending_requests,
                open_dapp,
                set_dapp_bounds,
                sync_toast_overlay,
                sync_menu_overlay,
                reload_dapp,
                hide_dapp,
                close_dapp,
                open_external_url,
                node_rpc,
                wallet_send,
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
                export_wallet_secret,
                unlock_vault,
                lock_vault,
                reset_vault,
                ledger_addresses,
                connect_ledger,
                select_account,
                expose_dapp_account,
                add_account,
                rename_wallet,
                delete_wallet
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
        webview(
            app,
            "approval",
            tauri::WebviewUrl::App("index.html?view=approval".into()),
        )
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
        invoke(
            wv,
            "wallet_request",
            json!({ "method": method, "params": params }),
        )
    }

    /// Serialize every test that touches process-global wallet state and reset to a
    /// known baseline: pending registry cleared, chain = Ethereum, and the vault
    /// unlocked with the Anvil dev mnemonic (2 derived accounts). Returning the guard
    /// keeps these tests from racing on the shared statics.
    fn wallet_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        let g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        pending().lock().unwrap().clear();
        *active_dapp_label().lock().unwrap() = None;
        *exposed_account_state().lock().unwrap() = None;
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
        let mut preimage = format!("\x19Ethereum Signed Message:\n{}", message.len()).into_bytes();
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
        assert_eq!(
            call(&wv, "eth_accounts", json!([])).unwrap(),
            json!([SPIKE_ACCOUNT])
        );
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
            call(
                &wv,
                "wallet_switchEthereumChain",
                json!([{ "chainId": "0x2105" }])
            )
            .unwrap(),
            Value::Null
        );
        assert_eq!(
            call(&wv, "eth_chainId", json!([])).unwrap(),
            json!("0x2105")
        );
        assert_eq!(call(&wv, "net_version", json!([])).unwrap(), json!("8453"));

        // Unknown chain is rejected, current chain unchanged.
        assert!(call(
            &wv,
            "wallet_switchEthereumChain",
            json!([{ "chainId": "0xbadbad" }])
        )
        .is_err());
        assert_eq!(
            call(&wv, "eth_chainId", json!([])).unwrap(),
            json!("0x2105")
        );
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
        assert_eq!(
            call(&wv, "eth_accounts", json!([])).unwrap(),
            json!([SPIKE_ACCOUNT])
        );

        // add_account returns its refusal BEFORE any keystore I/O, so this stays
        // disk-free. The error must name the real cause, not a silent no-op.
        // (install_privkey_vault tags the wallet id "w-privkey".)
        let err = super::add_account(app.handle().clone(), "w-privkey".to_string()).unwrap_err();
        assert!(
            err.contains("can't derive"),
            "expected a 'can't derive more accounts' refusal, got: {err}"
        );
    }

    /// Several independent wallets coexist in one store: adding a second wallet makes
    /// its account active (dApps see it), the ACTIVE signing key follows the selected
    /// ADDRESS across wallets, and deleting the active wallet moves the active account
    /// back to a surviving wallet. Pure in-memory (delete's keystore file never
    /// exists, so disk stays untouched). Deleting the core dispatch breaks this.
    #[test]
    fn e2e_multi_wallet_active_follows_address_across_wallets() {
        let _guard = wallet_guard(); // installs HD wallet "w-hd" (2 Anvil accounts), active #0
        let app = build_app();

        // Add a second, independent wallet: Anvil #3's well-known key as a privkey
        // wallet (NOT a secret — a public dev key, used here as an oracle).
        let key = super::vault::parse_private_key(
            "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
        )
        .unwrap();
        let addr3 = super::address_from_verifying_key(key.verifying_key());
        super::store_push_wallet(
            super::UnlockedWallet {
                id: "w-2".to_string(),
                label: "Wallet 2".to_string(),
                secret: super::VaultSecret::PrivateKey,
                accounts: vec![super::UnlockedAccount {
                    index: 0,
                    address: addr3.clone(),
                    signer: super::Signer::Local(key),
                }],
            },
            None,
        );

        // The new wallet's account is active, and dApps see exactly that address.
        assert_eq!(
            super::active_account_address().as_deref(),
            Some(addr3.as_str())
        );
        let wv = dapp_webview(app);
        assert_eq!(
            call(&wv, "eth_accounts", json!([])).unwrap(),
            json!([addr3])
        );
        // The active signing key recovers to Anvil #3 (the second wallet's key).
        let active_addr =
            super::with_active_key(|k| super::address_from_verifying_key(k.verifying_key()))
                .unwrap();
        assert_eq!(active_addr, addr3);

        // Switch back to the FIRST wallet's account (Anvil #0) by address — the active
        // key must now be Anvil #0's, proving selection spans wallets.
        super::select_account(app.handle().clone(), SPIKE_ACCOUNT.to_string()).unwrap();
        let active_addr =
            super::with_active_key(|k| super::address_from_verifying_key(k.verifying_key()))
                .unwrap();
        assert_eq!(active_addr, SPIKE_ACCOUNT);

        // Deleting the second wallet (its keystore file doesn't exist → disk no-op)
        // leaves the first wallet's accounts; active stays a valid, surviving account.
        super::delete_wallet(app.handle().clone(), "w-2".to_string()).unwrap();
        let active = super::active_account_address().expect("an account remains active");
        assert_eq!(active, SPIKE_ACCOUNT);
        assert_eq!(
            call(&wv, "eth_accounts", json!([])).unwrap(),
            json!([SPIKE_ACCOUNT])
        );
    }

    /// Watch-only addresses can be exposed to dApps for read-only portfolio views
    /// (DeBank, explorers, dashboards), but they never become the active signer.
    #[test]
    fn e2e_watch_only_account_is_visible_to_dapps_without_signing_key() {
        let _guard = wallet_guard();
        let app = build_app();
        let shell = shell_webview(app);
        let wv = dapp_webview(app);
        let watch = "0x2222222222222222222222222222222222222222";

        assert_eq!(
            call(&wv, "eth_accounts", json!([])).unwrap(),
            json!([SPIKE_ACCOUNT])
        );
        invoke(&shell, "expose_dapp_account", json!({ "address": watch }))
            .expect("shell can expose a watch-only address");

        assert_eq!(
            call(&wv, "eth_accounts", json!([])).unwrap(),
            json!([watch])
        );
        assert_eq!(call(&wv, "eth_coinbase", json!([])).unwrap(), json!(watch));

        let active_addr =
            super::with_active_key(|k| super::address_from_verifying_key(k.verifying_key()))
                .unwrap();
        assert_eq!(active_addr, SPIKE_ACCOUNT);

        invoke(
            &shell,
            "select_account",
            json!({ "address": SPIKE_ACCOUNT }),
        )
        .expect("shell can switch back to a signer");
        assert_eq!(
            call(&wv, "eth_accounts", json!([])).unwrap(),
            json!([SPIKE_ACCOUNT])
        );
        invoke(&shell, "expose_dapp_account", json!({ "address": watch }))
            .expect("shell can expose the watch-only address again");

        super::lock_vault();
        assert_eq!(
            call(&wv, "eth_accounts", json!([])).unwrap(),
            json!([watch])
        );
        let err = call(&wv, "personal_sign", json!(["0x48656c6c6f", watch])).unwrap_err();
        assert!(
            err.as_str().unwrap_or_default().contains("locked"),
            "expected signing to remain unavailable, got: {err}"
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
        assert_eq!(
            call(&wv, "eth_accounts", json!([])).unwrap(),
            json!([ledger_addr])
        );

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
        assert!(
            bal.as_str().unwrap().starts_with("0x"),
            "balance not hex: {bal}"
        );

        // Switch to Base, then the SAME method forwards to a DIFFERENT node.
        call(
            &wv,
            "wallet_switchEthereumChain",
            json!([{ "chainId": "0x2105" }]),
        )
        .unwrap();
        let base_bn = call(&wv, "eth_blockNumber", json!([])).unwrap();
        let bs = base_bn.as_str().expect("hex string");
        let bnum = u64::from_str_radix(bs.trim_start_matches("0x"), 16).expect("hex");
        assert!(
            bnum > 10_000_000,
            "base block implausibly low: {bnum} ({bs})"
        );

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
        activate_dapp_tab(app, "dapp-0");
        let approval = approval_webview(app); // exists → request_approval reuses it

        let message_text = "Hello from AutoDesktop";
        let message_hex = format!("0x{}", hex::encode(message_text));
        let account = SPIKE_ACCOUNT;

        // personal_sign blocks on approval → run it on a worker thread.
        let dapp_for_thread = dapp.clone();
        let signer = std::thread::spawn(move || {
            call(
                &dapp_for_thread,
                "personal_sign",
                json!([message_hex, account]),
            )
        });

        // Approve from the approval webview once the request is registered.
        let id = wait_for_pending_id();
        // The approval UI first lists pending requests…
        let pending_list = invoke(&approval, "get_pending_requests", json!({})).unwrap();
        assert_eq!(pending_list.as_array().unwrap().len(), 1);
        assert_eq!(pending_list[0]["summary"], json!(message_text)); // decoded for display
        assert_eq!(
            pending_list[0]["origin"],
            json!("https://metamask.github.io")
        );
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
        activate_dapp_tab(app, "dapp-0");
        let approval = approval_webview(app);

        let dapp_for_thread = dapp.clone();
        let signer = std::thread::spawn(move || {
            call(
                &dapp_for_thread,
                "personal_sign",
                json!(["0x48656c6c6f", SPIKE_ACCOUNT]),
            )
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
        activate_dapp_tab(app, "dapp-0");
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
            call(
                &dapp_for_thread,
                "eth_signTypedData_v4",
                json!([SPIKE_ACCOUNT, typed_str]),
            )
        });

        let id = wait_for_pending_id();
        // The approval window shows a typed-data summary AND the full payload —
        // the UI must be able to render every field (spender/amount/deadline…),
        // otherwise typed-data signing is blind signing (permit-phishing risk).
        let pending = invoke(&approval, "get_pending_requests", json!({})).unwrap();
        assert_eq!(pending[0]["summary"], json!("Sign Mail for Ether Mail"));
        assert_eq!(pending[0]["typed_data"], typed);
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

    /// SECURITY: a hidden/background dApp webview stays alive, but it must not be
    /// able to surface a signing approval. Switching away calls hide_dapp, which
    /// clears the active dApp label; signing then fails before pending approval is
    /// registered.
    #[test]
    fn e2e_background_dapp_signing_is_blocked_without_approval_popup() {
        let _guard = wallet_guard();
        let app = build_app();
        let dapp = dapp_webview(app);
        let shell = shell_webview(app);

        invoke(
            &shell,
            "open_dapp",
            json!({ "label": "dapp-0", "url": "https://metamask.github.io/test-dapp/", "x": 0.0, "y": 0.0, "w": 100.0, "h": 100.0 }),
        )
        .expect("shell can activate dapp tab");

        invoke(&shell, "hide_dapp", json!({ "label": "dapp-0" }))
            .expect("shell can hide active dapp");

        let err = call(
            &dapp,
            "personal_sign",
            json!(["0x48656c6c6f", SPIKE_ACCOUNT]),
        )
        .unwrap_err();
        assert!(
            err.as_str()
                .unwrap_or_default()
                .contains("not the active tab"),
            "expected inactive-tab signing rejection, got: {err}"
        );
        assert!(
            pending().lock().unwrap().is_empty(),
            "background signing must not register a pending approval"
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
        activate_dapp_tab(app, "dapp-0");
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

    #[test]
    fn e2e_dapp_can_request_dialog_but_only_through_narrow_command() {
        let app = build_app();
        let dapp = dapp_webview(app);

        let err = invoke(
            &dapp,
            "dapp_dialog",
            json!({ "kind": "bogus", "message": "hi", "defaultValue": null }),
        )
        .unwrap_err();
        assert!(
            err.as_str()
                .unwrap_or_default()
                .contains("unsupported kind"),
            "expected dapp_dialog to reach the narrow handler, got: {err}"
        );
    }

    /// The trusted *shell* webview (local). As a local webview it may call bare
    /// app commands; the dapp-browser controls (open/close/bounds) are reachable
    /// only this way.
    fn shell_webview(app: &'static tauri::App<MockRuntime>) -> WebviewWindow<MockRuntime> {
        webview(app, "shell", tauri::WebviewUrl::App("index.html".into()))
    }

    fn activate_dapp_tab(app: &'static tauri::App<MockRuntime>, label: &str) {
        let shell = shell_webview(app);
        invoke(
            &shell,
            "open_dapp",
            json!({ "label": label, "url": "https://metamask.github.io/test-dapp/", "x": 0.0, "y": 0.0, "w": 100.0, "h": 100.0 }),
        )
        .expect("shell can activate dapp tab");
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
            (
                "open_dapp",
                json!({ "label": "dapp-9", "url": "https://evil.example", "x": 0.0, "y": 0.0, "w": 10.0, "h": 10.0 }),
            ),
            (
                "set_dapp_bounds",
                json!({ "label": "dapp-9", "x": 0.0, "y": 0.0, "w": 10.0, "h": 10.0 }),
            ),
            (
                "sync_toast_overlay",
                json!({ "visible": true, "x": 0.0, "y": 0.0, "w": 10.0, "h": 10.0 }),
            ),
            (
                "sync_menu_overlay",
                json!({ "visible": true, "x": 0.0, "y": 0.0, "w": 10.0, "h": 10.0 }),
            ),
            (
                "resolve_dapp_dialog",
                json!({ "id": "dlg-1", "action": "ok", "value": null }),
            ),
            ("reload_dapp", json!({ "label": "dapp-9" })),
            ("hide_dapp", json!({ "label": "dapp-9" })),
            ("close_dapp", json!({ "label": "dapp-9" })),
            ("set_active_chain", json!({ "chainId": "0x1" })),
            (
                "expose_dapp_account",
                json!({ "address": "0x2222222222222222222222222222222222222222" }),
            ),
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

        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,x",
        ] {
            let err = invoke(
                &shell,
                "open_dapp",
                json!({ "label": "dapp-0", "url": bad, "x": 0.0, "y": 0.0, "w": 100.0, "h": 100.0 }),
            )
            .unwrap_err();
            assert!(
                err.as_str()
                    .unwrap_or_default()
                    .contains("refusing non-http"),
                "expected scheme rejection for {bad}, got: {err}"
            );
        }
    }

    /// open_dapp / reload_dapp / hide_dapp / close_dapp reject labels that aren't `dapp-<id>`,
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
                err.as_str()
                    .unwrap_or_default()
                    .contains("invalid dapp label"),
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

        invoke(&shell, "reload_dapp", json!({ "label": "dapp-0" }))
            .expect("shell reload_dapp should succeed");

        invoke(&shell, "hide_dapp", json!({ "label": "dapp-0" }))
            .expect("shell hide_dapp should succeed");

        invoke(&shell, "close_dapp", json!({ "label": "dapp-0" }))
            .expect("shell close_dapp should succeed");
    }
}
