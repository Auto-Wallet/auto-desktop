//! EIP-1559 (type-2) transaction encoding + signing — pure, no network.
//!
//! The dApp sends `eth_sendTransaction` params as 0x-hex quantities; lib.rs fills
//! the missing fields (nonce/gas/fees) from the chain node, then builds the fields
//! here, signs Rust-side with the vault key, and broadcasts the raw tx. This module
//! is just the deterministic bytes: minimal RLP + the type-2 envelope, unit-tested
//! against the canonical RLP vectors and a recover-signer round-trip.

use k256::ecdsa::SigningKey;
use sha3::{Digest, Keccak256};

// ---------------------------------------------------------------------------
// RLP (recursive length prefix) — encoding only.
// ---------------------------------------------------------------------------

/// Length prefix for a string (`offset` = 0x80) or list (`offset` = 0xc0).
fn rlp_len_prefix(len: usize, offset: u8) -> Vec<u8> {
    if len <= 55 {
        vec![offset + len as u8]
    } else {
        let len_be = strip_leading_zeros(&(len as u64).to_be_bytes());
        let mut out = vec![offset + 55 + len_be.len() as u8];
        out.extend_from_slice(&len_be);
        out
    }
}

/// RLP-encode a byte string. A single byte < 0x80 is itself; otherwise a length
/// prefix + the bytes. (The empty string encodes to 0x80.)
fn rlp_bytes(b: &[u8]) -> Vec<u8> {
    if b.len() == 1 && b[0] < 0x80 {
        vec![b[0]]
    } else {
        let mut out = rlp_len_prefix(b.len(), 0x80);
        out.extend_from_slice(b);
        out
    }
}

/// RLP-encode a list of ALREADY-encoded items.
fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload: Vec<u8> = items.concat();
    let mut out = rlp_len_prefix(payload.len(), 0xc0);
    out.extend_from_slice(&payload);
    out
}

/// Drop leading zero bytes — RLP integers are minimal big-endian (0 → empty).
fn strip_leading_zeros(b: &[u8]) -> Vec<u8> {
    let start = b.iter().position(|&x| x != 0).unwrap_or(b.len());
    b[start..].to_vec()
}

// ---------------------------------------------------------------------------
// Param parsing (0x-hex quantities/data from the dApp + the node).
// ---------------------------------------------------------------------------

/// Parse a 0x-hex quantity into minimal big-endian bytes (for an RLP integer).
pub fn parse_quantity(hex: &str) -> Result<Vec<u8>, String> {
    let s = hex.strip_prefix("0x").unwrap_or(hex);
    // Allow an odd number of nibbles (e.g. "0x1").
    let padded = if s.len() % 2 == 1 { format!("0{s}") } else { s.to_string() };
    let bytes = hex::decode(&padded).map_err(|e| format!("bad quantity {hex}: {e}"))?;
    Ok(strip_leading_zeros(&bytes))
}

/// Parse a 20-byte 0x address. Empty / "0x" means contract creation (no `to`).
pub fn parse_address(hex: &str) -> Result<Vec<u8>, String> {
    let s = hex.strip_prefix("0x").unwrap_or(hex);
    if s.is_empty() {
        return Ok(vec![]);
    }
    let bytes = hex::decode(s).map_err(|e| format!("bad address {hex}: {e}"))?;
    if bytes.len() != 20 {
        return Err(format!("address must be 20 bytes, got {}", bytes.len()));
    }
    Ok(bytes)
}

/// Parse 0x-hex call data (raw bytes; empty when absent).
pub fn parse_data(hex: &str) -> Result<Vec<u8>, String> {
    let s = hex.strip_prefix("0x").unwrap_or(hex);
    if s.is_empty() {
        return Ok(vec![]);
    }
    hex::decode(s).map_err(|e| format!("bad data: {e}"))
}

// ---------------------------------------------------------------------------
// EIP-1559 transaction
// ---------------------------------------------------------------------------

/// Type-2 transaction fields, each already in canonical byte form: integer fields
/// are minimal big-endian; `to` is 20 raw bytes (or empty); `data` is raw.
#[derive(Debug, Clone, Default)]
pub struct Eip1559Tx {
    pub chain_id: Vec<u8>,
    pub nonce: Vec<u8>,
    pub max_priority_fee_per_gas: Vec<u8>,
    pub max_fee_per_gas: Vec<u8>,
    pub gas_limit: Vec<u8>,
    pub to: Vec<u8>,
    pub value: Vec<u8>,
    pub data: Vec<u8>,
}

impl Eip1559Tx {
    /// The 9 unsigned fields, RLP-encoded (access list always empty here).
    fn base_fields(&self) -> Vec<Vec<u8>> {
        vec![
            rlp_bytes(&self.chain_id),
            rlp_bytes(&self.nonce),
            rlp_bytes(&self.max_priority_fee_per_gas),
            rlp_bytes(&self.max_fee_per_gas),
            rlp_bytes(&self.gas_limit),
            rlp_bytes(&self.to),
            rlp_bytes(&self.value),
            rlp_bytes(&self.data),
            rlp_list(&[]), // empty access list
        ]
    }

    /// `0x02 || rlp([...9 unsigned fields])` — the exact bytes that are hashed to
    /// produce the signing hash. A Ledger signs *these bytes* (it hashes them on the
    /// device); a local key signs `signing_hash()`. Sharing this keeps both paths on
    /// identical encoding.
    pub fn unsigned_payload(&self) -> Vec<u8> {
        let mut msg = vec![0x02u8];
        msg.extend_from_slice(&rlp_list(&self.base_fields()));
        msg
    }

    /// keccak256(0x02 || rlp([...9 fields])) — the EIP-1559 signing hash.
    pub fn signing_hash(&self) -> [u8; 32] {
        Keccak256::digest(self.unsigned_payload()).into()
    }

    /// Assemble the signed raw tx from a 64-byte signature (r‖s) + y-parity. Shared
    /// by the local-key and Ledger signing paths. Returns (raw_tx_hex, tx_hash_hex);
    /// the raw tx is `0x02 || rlp([...9 fields, yParity, r, s])`.
    pub fn into_signed(&self, r: &[u8; 32], s: &[u8; 32], y_parity: u8) -> (String, String) {
        let r = strip_leading_zeros(r);
        let s = strip_leading_zeros(s);
        let y = strip_leading_zeros(&[y_parity]); // 0 → empty, 1 → [0x01]

        let mut fields = self.base_fields();
        fields.push(rlp_bytes(&y));
        fields.push(rlp_bytes(&r));
        fields.push(rlp_bytes(&s));

        let mut raw = vec![0x02u8];
        raw.extend_from_slice(&rlp_list(&fields));
        let tx_hash = Keccak256::digest(&raw);
        (
            format!("0x{}", hex::encode(&raw)),
            format!("0x{}", hex::encode(tx_hash)),
        )
    }

    /// Sign with a local `key` and return (raw_tx_hex, tx_hash_hex), ready for
    /// eth_sendRawTransaction.
    pub fn sign(&self, key: &SigningKey) -> Result<(String, String), String> {
        let hash = self.signing_hash();
        // k256 returns a low-S (EIP-2) signature; recid is the y-parity (0/1).
        let (sig, recid) = key
            .sign_prehash_recoverable(&hash)
            .map_err(|e| format!("tx signing failed: {e}"))?;
        let sig_bytes = sig.to_bytes(); // 64 bytes: r ‖ s
        let mut r = [0u8; 32];
        let mut s = [0u8; 32];
        r.copy_from_slice(&sig_bytes[..32]);
        s.copy_from_slice(&sig_bytes[32..]);
        Ok(self.into_signed(&r, &s, recid.to_byte()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

    // Canonical RLP vectors (Ethereum yellow paper / wiki).
    #[test]
    fn rlp_string_vectors() {
        assert_eq!(rlp_bytes(b"dog"), vec![0x83, b'd', b'o', b'g']);
        assert_eq!(rlp_bytes(b""), vec![0x80]);
        assert_eq!(rlp_bytes(&[0x0f]), vec![0x0f]); // single byte < 0x80
        assert_eq!(rlp_bytes(&[0x00]), vec![0x00]); // a literal zero byte string
        // long string (56 bytes) → 0xb8, len, bytes…
        let long = vec![0x61u8; 56];
        let enc = rlp_bytes(&long);
        assert_eq!(&enc[..2], &[0xb8, 56]);
        assert_eq!(enc.len(), 58);
    }

    #[test]
    fn rlp_integer_vectors() {
        // RLP integers = rlp of the minimal big-endian bytes.
        assert_eq!(rlp_bytes(&parse_quantity("0x0").unwrap()), vec![0x80]); // 0 → empty → 0x80
        assert_eq!(rlp_bytes(&parse_quantity("0x0f").unwrap()), vec![0x0f]); // 15
        assert_eq!(
            rlp_bytes(&parse_quantity("0x400").unwrap()),
            vec![0x82, 0x04, 0x00]
        ); // 1024
    }

    #[test]
    fn rlp_list_vectors() {
        assert_eq!(rlp_list(&[]), vec![0xc0]);
        let cat_dog = rlp_list(&[rlp_bytes(b"cat"), rlp_bytes(b"dog")]);
        assert_eq!(
            cat_dog,
            vec![0xc8, 0x83, b'c', b'a', b't', 0x83, b'd', b'o', b'g']
        );
    }

    #[test]
    fn parsers_handle_edge_cases() {
        assert_eq!(parse_quantity("0x1").unwrap(), vec![0x01]); // odd nibble count
        assert_eq!(parse_quantity("0x00").unwrap(), Vec::<u8>::new()); // zero → empty
        assert_eq!(parse_address("0x").unwrap(), Vec::<u8>::new()); // contract creation
        assert_eq!(parse_address(&format!("0x{}", "11".repeat(20))).unwrap().len(), 20);
        assert!(parse_address("0x1234").is_err()); // wrong length
        assert_eq!(parse_data("0xdeadbeef").unwrap(), vec![0xde, 0xad, 0xbe, 0xef]);
    }

    #[test]
    fn signed_tx_recovers_to_the_signer() {
        // Anvil #0 (from the known dev mnemonic) — see vault tests.
        let key = SigningKey::from_slice(
            &hex::decode("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
                .unwrap(),
        )
        .unwrap();
        let expected = crate::address_from_verifying_key(key.verifying_key());

        // A real-shaped transfer: 1 ETH to Anvil #1 on chain 1, EIP-1559 fees.
        let tx = Eip1559Tx {
            chain_id: parse_quantity("0x1").unwrap(),
            nonce: parse_quantity("0x0").unwrap(),
            max_priority_fee_per_gas: parse_quantity("0x3b9aca00").unwrap(), // 1 gwei
            max_fee_per_gas: parse_quantity("0x77359400").unwrap(),          // 2 gwei
            gas_limit: parse_quantity("0x5208").unwrap(),                    // 21000
            to: parse_address("0x70997970c51812dc3a010c7d01b50e0d17dc79c8").unwrap(),
            value: parse_quantity("0xde0b6b3a7640000").unwrap(),            // 1e18 wei
            data: parse_data("0x").unwrap(),
        };

        let hash = tx.signing_hash();
        let (raw, tx_hash) = tx.sign(&key).unwrap();
        assert!(raw.starts_with("0x02"), "must be a type-2 envelope");
        assert_eq!(tx_hash.len(), 66); // 0x + 32 bytes

        // Recover the signer from the signing hash + the signature we embedded, and
        // assert it's the vault key's address — proving hash + signature are correct.
        let raw_bytes = hex::decode(raw.trim_start_matches("0x")).unwrap();
        let (r, s, y) = extract_sig(&raw_bytes);
        let sig = Signature::from_scalars(r, s).unwrap();
        let recid = RecoveryId::from_byte(y).unwrap();
        let vk = VerifyingKey::recover_from_prehash(&hash, &sig, recid).unwrap();
        assert_eq!(crate::address_from_verifying_key(&vk), expected);
    }

    /// Pull the last three RLP items (yParity, r, s) out of a signed type-2 tx.
    fn extract_sig(raw: &[u8]) -> ([u8; 32], [u8; 32], u8) {
        // Decode just enough: the signature is the final 3 fields. For a 21000-gas
        // ETH transfer the body is short, so we decode the outer list and walk items.
        let items = decode_list_items(&raw[1..]); // skip the 0x02 type byte
        let n = items.len();
        let y = if items[n - 3].is_empty() { 0u8 } else { items[n - 3][0] };
        let r = left_pad32(&items[n - 2]);
        let s = left_pad32(&items[n - 1]);
        (r, s, y)
    }

    fn left_pad32(b: &[u8]) -> [u8; 32] {
        let mut out = [0u8; 32];
        out[32 - b.len()..].copy_from_slice(b);
        out
    }

    /// Minimal RLP list decoder (test-only) returning each item's payload bytes.
    fn decode_list_items(rlp: &[u8]) -> Vec<Vec<u8>> {
        let (payload, _) = read_rlp_payload(rlp);
        let mut items = Vec::new();
        let mut i = 0;
        while i < payload.len() {
            let (item, consumed) = read_rlp_payload(&payload[i..]);
            items.push(item);
            i += consumed;
        }
        items
    }

    /// Returns (payload bytes of the item at the front, total bytes consumed).
    fn read_rlp_payload(rlp: &[u8]) -> (Vec<u8>, usize) {
        let first = rlp[0];
        if first < 0x80 {
            (vec![first], 1)
        } else if first < 0xb8 {
            let len = (first - 0x80) as usize;
            (rlp[1..1 + len].to_vec(), 1 + len)
        } else if first < 0xc0 {
            let ll = (first - 0xb7) as usize;
            let len = be_to_usize(&rlp[1..1 + ll]);
            (rlp[1 + ll..1 + ll + len].to_vec(), 1 + ll + len)
        } else if first < 0xf8 {
            let len = (first - 0xc0) as usize;
            (rlp[1..1 + len].to_vec(), 1 + len)
        } else {
            let ll = (first - 0xf7) as usize;
            let len = be_to_usize(&rlp[1..1 + ll]);
            (rlp[1 + ll..1 + ll + len].to_vec(), 1 + ll + len)
        }
    }

    fn be_to_usize(b: &[u8]) -> usize {
        b.iter().fold(0usize, |acc, &x| (acc << 8) | x as usize)
    }
}
