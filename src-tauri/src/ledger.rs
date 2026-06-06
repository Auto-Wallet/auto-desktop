//! Ledger hardware-wallet support over USB-HID (pure protocol + `hidapi` I/O).
//!
//! WKWebView has no WebHID, so (unlike the browser extension, which uses
//! `@ledgerhq/hw-transport-webhid`) the desktop app talks to the device from Rust.
//! This module hand-rolls the two layers the device speaks, to avoid the heavy
//! `@ledgerhq` JS stack and keep all key/signature handling in the backend:
//!
//!   1. **HID framing** — APDUs are chunked into 64-byte HID reports tagged with a
//!      channel/tag/sequence header (`frame`/`deframe`).
//!   2. **Ledger Ethereum app APDUs** — GET ADDRESS / SIGN PERSONAL MESSAGE / SIGN
//!      TRANSACTION / SIGN EIP-712, built and parsed here.
//!
//! The private key never leaves the device: we send it the payload, it displays it
//! and the user approves *on the device*, and it returns only the signature. The
//! deterministic layers (framing, path encoding, APDU build, response parse) are
//! unit-tested; the `hidapi` I/O needs a physical device to exercise.

use hidapi::{HidApi, HidDevice};

/// Ledger USB vendor id. The Ethereum-app APDU interface advertises usage page
/// 0xffa0 — we prefer that interface on multi-interface devices (macOS exposes
/// several HID interfaces per Ledger).
const LEDGER_VID: u16 = 0x2c97;
const APDU_USAGE_PAGE: u16 = 0xffa0;

// Ledger Ethereum app — CLA + instructions (see the app's APDU spec).
const CLA: u8 = 0xe0;
const INS_GET_ADDRESS: u8 = 0x02;
const INS_SIGN_TX: u8 = 0x04;
const INS_SIGN_PERSONAL: u8 = 0x08;
const INS_SIGN_EIP712: u8 = 0x0c;

// HID framing constants.
const CHANNEL: u16 = 0x0101;
const TAG: u8 = 0x05;
const PACKET: usize = 64;
/// Max APDU `data` length (Lc is a single byte).
const MAX_APDU_DATA: usize = 255;

// ---------------------------------------------------------------------------
// BIP-32 derivation path
// ---------------------------------------------------------------------------

const HARDENED: u32 = 0x8000_0000;

/// Parse `m/44'/60'/0'/0/0` (or `44'/60'/0'/0/0`) into raw path components, with
/// hardened markers (`'`, `h`, `H`) folded into the high bit.
fn parse_bip32_path(path: &str) -> Result<Vec<u32>, String> {
    let trimmed = path.trim();
    let body = trimmed
        .strip_prefix("m/")
        .or_else(|| trimmed.strip_prefix("M/"))
        .unwrap_or(trimmed);
    let mut comps = Vec::new();
    for part in body.split('/') {
        if part.is_empty() {
            continue;
        }
        let (num, hardened) = match part
            .strip_suffix('\'')
            .or_else(|| part.strip_suffix('h'))
            .or_else(|| part.strip_suffix('H'))
        {
            Some(n) => (n, true),
            None => (part, false),
        };
        let n: u32 = num
            .parse()
            .map_err(|_| format!("bad path component '{part}'"))?;
        if n >= HARDENED {
            return Err(format!("path index out of range: {part}"));
        }
        comps.push(if hardened { n | HARDENED } else { n });
    }
    if comps.is_empty() || comps.len() > 10 {
        return Err(format!("derivation path must have 1–10 components: {path}"));
    }
    Ok(comps)
}

/// Serialize a derivation path for an APDU: `count(1) || component(4 BE)…`.
fn path_apdu_bytes(path: &str) -> Result<Vec<u8>, String> {
    let comps = parse_bip32_path(path)?;
    let mut out = Vec::with_capacity(1 + comps.len() * 4);
    out.push(comps.len() as u8);
    for c in comps {
        out.extend_from_slice(&c.to_be_bytes());
    }
    Ok(out)
}

/// The Ledger Live Ethereum path for account `index`: `m/44'/60'/index'/0/0`.
pub fn ledger_live_path(index: u32) -> String {
    format!("m/44'/60'/{index}'/0/0")
}

// ---------------------------------------------------------------------------
// APDU + HID framing (deterministic, unit-tested)
// ---------------------------------------------------------------------------

/// Build a command APDU: `CLA INS P1 P2 Lc data`.
fn apdu(ins: u8, p1: u8, p2: u8, data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() > MAX_APDU_DATA {
        return Err("APDU data exceeds 255 bytes".to_string());
    }
    let mut a = Vec::with_capacity(5 + data.len());
    a.extend_from_slice(&[CLA, ins, p1, p2, data.len() as u8]);
    a.extend_from_slice(data);
    Ok(a)
}

/// Chunk an APDU into 64-byte HID reports. First report carries a 2-byte total
/// length after the channel/tag/seq header; continuations omit it.
fn frame(apdu: &[u8]) -> Vec<[u8; PACKET]> {
    let mut packets = Vec::new();
    let mut seq: u16 = 0;
    let mut offset = 0;
    loop {
        let mut pkt = [0u8; PACKET];
        pkt[0..2].copy_from_slice(&CHANNEL.to_be_bytes());
        pkt[2] = TAG;
        pkt[3..5].copy_from_slice(&seq.to_be_bytes());
        let hdr = if seq == 0 {
            pkt[5..7].copy_from_slice(&(apdu.len() as u16).to_be_bytes());
            7
        } else {
            5
        };
        let take = (PACKET - hdr).min(apdu.len() - offset);
        pkt[hdr..hdr + take].copy_from_slice(&apdu[offset..offset + take]);
        packets.push(pkt);
        offset += take;
        seq += 1;
        if offset >= apdu.len() {
            break;
        }
    }
    packets
}

/// Reassemble a response from HID report packets, validating the channel/tag and
/// sequence ordering. Returns the response bytes (APDU data ‖ SW1 ‖ SW2).
fn deframe(packets: &[Vec<u8>]) -> Result<Vec<u8>, String> {
    let mut data = Vec::new();
    let mut total: Option<usize> = None;
    for (i, pkt) in packets.iter().enumerate() {
        if pkt.len() < 5 {
            return Err("short HID packet".to_string());
        }
        if u16::from_be_bytes([pkt[0], pkt[1]]) != CHANNEL {
            return Err("HID packet on wrong channel".to_string());
        }
        if pkt[2] != TAG {
            return Err("HID packet with wrong tag".to_string());
        }
        if u16::from_be_bytes([pkt[3], pkt[4]]) != i as u16 {
            return Err("out-of-order HID packet".to_string());
        }
        let hdr = if i == 0 {
            if pkt.len() < 7 {
                return Err("short first HID packet".to_string());
            }
            total = Some(u16::from_be_bytes([pkt[5], pkt[6]]) as usize);
            7
        } else {
            5
        };
        let want = total.ok_or("missing length prefix")?;
        let remaining = want - data.len();
        let take = remaining.min(pkt.len() - hdr);
        data.extend_from_slice(&pkt[hdr..hdr + take]);
        if data.len() >= want {
            break;
        }
    }
    match total {
        Some(t) if data.len() == t => Ok(data),
        _ => Err("incomplete HID response".to_string()),
    }
}

/// Split off and check the 2-byte status word, returning the response payload on
/// success (SW = 0x9000) or a friendly error.
fn check_sw(resp: &[u8]) -> Result<&[u8], String> {
    if resp.len() < 2 {
        return Err("Ledger response too short".to_string());
    }
    let sw = u16::from_be_bytes([resp[resp.len() - 2], resp[resp.len() - 1]]);
    if sw == 0x9000 {
        Ok(&resp[..resp.len() - 2])
    } else {
        Err(map_sw(sw))
    }
}

/// Map a Ledger status word to a user-facing message. Mirrors the error handling in
/// the extension's `ledger.ts` (app-not-open / user-rejected / locked).
fn map_sw(sw: u16) -> String {
    match sw {
        0x6985 | 0x5501 => "Transaction rejected on the Ledger device.".to_string(),
        0x6a80 | 0x6a87 => {
            "Ledger rejected the data — enable blind signing / contract data in the Ethereum app."
                .to_string()
        }
        0x6700 | 0x6d00 | 0x6e00 | 0x6e01 | 0x6511 => {
            "Open the Ethereum app on your Ledger and try again.".to_string()
        }
        0x6982 | 0x5515 => "Unlock your Ledger and open the Ethereum app.".to_string(),
        other => format!("Ledger error 0x{other:04x}"),
    }
}

/// Parse a GET ADDRESS response: `pubkeyLen(1) ‖ pubkey ‖ addrLen(1) ‖ addrAscii`.
/// Returns the lowercase `0x` address.
fn parse_address_response(data: &[u8]) -> Result<String, String> {
    let pk_len = *data.first().ok_or("empty address response")? as usize;
    let addr_len_idx = 1 + pk_len;
    let addr_len = *data
        .get(addr_len_idx)
        .ok_or("truncated address response")? as usize;
    let start = addr_len_idx + 1;
    let ascii = data
        .get(start..start + addr_len)
        .ok_or("truncated address response")?;
    let s = std::str::from_utf8(ascii).map_err(|_| "non-UTF-8 address from Ledger")?;
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.len() != 40 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("Ledger returned a malformed address: {s}"));
    }
    Ok(format!("0x{}", s.to_lowercase()))
}

/// Parse a signature response: `v(1) ‖ r(32) ‖ s(32)`.
fn parse_signature(data: &[u8]) -> Result<(u8, [u8; 32], [u8; 32]), String> {
    if data.len() < 65 {
        return Err("Ledger signature response too short".to_string());
    }
    let mut r = [0u8; 32];
    let mut s = [0u8; 32];
    r.copy_from_slice(&data[1..33]);
    s.copy_from_slice(&data[33..65]);
    Ok((data[0], r, s))
}

/// Normalize the recovery byte for EIP-191 / EIP-712 signatures to {27, 28}.
fn normalize_eip191_v(v: u8) -> u8 {
    if v < 27 {
        v + 27
    } else {
        v
    }
}

/// Assemble a 65-byte `r ‖ s ‖ v` signature.
fn assemble_rsv(r: [u8; 32], s: [u8; 32], v: u8) -> [u8; 65] {
    let mut out = [0u8; 65];
    out[..32].copy_from_slice(&r);
    out[32..64].copy_from_slice(&s);
    out[64] = v;
    out
}

// ---------------------------------------------------------------------------
// Device I/O (hidapi) — needs a physical Ledger; not unit-tested
// ---------------------------------------------------------------------------

/// Open the Ledger's APDU HID interface. Prefers the interface advertising usage
/// page 0xffa0 (the Ethereum app endpoint); falls back to the first Ledger HID.
fn open_ledger(api: &HidApi) -> Result<HidDevice, String> {
    let mut fallback: Option<&hidapi::DeviceInfo> = None;
    let mut apdu_iface: Option<&hidapi::DeviceInfo> = None;
    for info in api.device_list() {
        if info.vendor_id() != LEDGER_VID {
            continue;
        }
        if info.usage_page() == APDU_USAGE_PAGE {
            apdu_iface = Some(info);
            break;
        }
        fallback.get_or_insert(info);
    }
    let info = apdu_iface
        .or(fallback)
        .ok_or("No Ledger found. Plug it in, unlock it, and open the Ethereum app.")?;
    info.open_device(api)
        .map_err(|e| format!("Could not open the Ledger device: {e}"))
}

/// Send one APDU and return the raw response (data ‖ SW). Frames the APDU into HID
/// reports (prefixing the report-id byte 0x00) and reassembles the reply.
fn exchange(device: &HidDevice, apdu_bytes: &[u8]) -> Result<Vec<u8>, String> {
    for pkt in frame(apdu_bytes) {
        let mut buf = Vec::with_capacity(1 + PACKET);
        buf.push(0x00); // HID report id (Ledger uses report 0)
        buf.extend_from_slice(&pkt);
        device
            .write(&buf)
            .map_err(|e| format!("HID write to Ledger failed: {e}"))?;
    }

    let mut packets: Vec<Vec<u8>> = Vec::new();
    loop {
        let mut rbuf = [0u8; PACKET];
        let n = device
            .read_timeout(&mut rbuf, 60_000)
            .map_err(|e| format!("HID read from Ledger failed: {e}"))?;
        if n == 0 {
            return Err("Ledger timed out — confirm or cancel on the device.".to_string());
        }
        packets.push(rbuf[..n].to_vec());
        // Once the first packet's length prefix is in, stop when we've collected it.
        if let Ok(done) = deframe(&packets) {
            return check_sw(&done).map(|d| d.to_vec());
        }
    }
}

/// Drive a (possibly multi-APDU) signing command: the first chunk carries the
/// derivation path (P1=0x00), continuations carry only payload (P1=0x80). Returns
/// the final chunk's response payload (the signature), already SW-checked.
fn exchange_signing(
    device: &HidDevice,
    ins: u8,
    path_bytes: &[u8],
    tail: &[u8],
) -> Result<Vec<u8>, String> {
    // First chunk = path ‖ as much tail as fits in one APDU; rest = tail only.
    let first_tail = (MAX_APDU_DATA - path_bytes.len()).min(tail.len());
    let mut chunks: Vec<Vec<u8>> = Vec::new();
    let mut data0 = path_bytes.to_vec();
    data0.extend_from_slice(&tail[..first_tail]);
    chunks.push(data0);
    let mut off = first_tail;
    while off < tail.len() {
        let n = MAX_APDU_DATA.min(tail.len() - off);
        chunks.push(tail[off..off + n].to_vec());
        off += n;
    }

    let mut last = Vec::new();
    for (i, chunk) in chunks.iter().enumerate() {
        let p1 = if i == 0 { 0x00 } else { 0x80 };
        last = exchange(device, &apdu(ins, p1, 0x00, chunk)?)?;
    }
    Ok(last)
}

/// Fetch the address at `path` from the device (no on-device confirmation prompt).
pub fn get_address(path: &str) -> Result<String, String> {
    let api = HidApi::new().map_err(|e| format!("HID init failed: {e}"))?;
    let device = open_ledger(&api)?;
    let resp = exchange(&device, &apdu(INS_GET_ADDRESS, 0x00, 0x00, &path_apdu_bytes(path)?)?)?;
    parse_address_response(&resp)
}

/// Fetch addresses for several Ledger Live account indices in ONE device session
/// (for the onboarding address picker). Returns (index, path, address) rows.
pub fn get_addresses(indices: &[u32]) -> Result<Vec<(u32, String, String)>, String> {
    let api = HidApi::new().map_err(|e| format!("HID init failed: {e}"))?;
    let device = open_ledger(&api)?;
    let mut out = Vec::with_capacity(indices.len());
    for &i in indices {
        let path = ledger_live_path(i);
        let resp = exchange(
            &device,
            &apdu(INS_GET_ADDRESS, 0x00, 0x00, &path_apdu_bytes(&path)?)?,
        )?;
        out.push((i, path.clone(), parse_address_response(&resp)?));
    }
    Ok(out)
}

/// Sign an EIP-191 `personal_sign` message on the device. Returns 65-byte `r‖s‖v`.
pub fn sign_personal_message(path: &str, message: &[u8]) -> Result<[u8; 65], String> {
    let api = HidApi::new().map_err(|e| format!("HID init failed: {e}"))?;
    let device = open_ledger(&api)?;
    let mut tail = (message.len() as u32).to_be_bytes().to_vec();
    tail.extend_from_slice(message);
    let resp = exchange_signing(&device, INS_SIGN_PERSONAL, &path_apdu_bytes(path)?, &tail)?;
    let (v, r, s) = parse_signature(&resp)?;
    Ok(assemble_rsv(r, s, normalize_eip191_v(v)))
}

/// Sign an EIP-1559 transaction on the device. `payload` is the unsigned
/// `0x02 ‖ rlp([...])`. Returns (r, s, y_parity) for assembling the signed tx.
pub fn sign_transaction(path: &str, payload: &[u8]) -> Result<([u8; 32], [u8; 32], u8), String> {
    let api = HidApi::new().map_err(|e| format!("HID init failed: {e}"))?;
    let device = open_ledger(&api)?;
    let resp = exchange_signing(&device, INS_SIGN_TX, &path_apdu_bytes(path)?, payload)?;
    let (v, r, s) = parse_signature(&resp)?;
    // Type-2 txns: the device returns the y-parity (0/1); tolerate a 27/28 form.
    let y_parity = if v >= 27 { (v - 27) & 1 } else { v & 1 };
    Ok((r, s, y_parity))
}

/// Sign EIP-712 typed data on the device from its two 32-byte hashes. Returns
/// 65-byte `r‖s‖v`.
pub fn sign_eip712(
    path: &str,
    domain_separator: &[u8; 32],
    message_hash: &[u8; 32],
) -> Result<[u8; 65], String> {
    let api = HidApi::new().map_err(|e| format!("HID init failed: {e}"))?;
    let device = open_ledger(&api)?;
    let mut tail = domain_separator.to_vec();
    tail.extend_from_slice(message_hash);
    let resp = exchange_signing(&device, INS_SIGN_EIP712, &path_apdu_bytes(path)?, &tail)?;
    let (v, r, s) = parse_signature(&resp)?;
    Ok(assemble_rsv(r, s, normalize_eip191_v(v)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ledger_live_path() {
        // m/44'/60'/0'/0/0 → 5 hardened/normal components.
        let comps = parse_bip32_path("m/44'/60'/0'/0/0").unwrap();
        assert_eq!(
            comps,
            vec![44 | HARDENED, 60 | HARDENED, HARDENED, 0, 0]
        );
        // The APDU bytes: count, then 4 BE bytes per component.
        let bytes = path_apdu_bytes("m/44'/60'/0'/0/0").unwrap();
        assert_eq!(
            hex::encode(&bytes),
            "05" .to_string()
                + "8000002c" // 44'
                + "8000003c" // 60'
                + "80000000" // 0'
                + "00000000" // 0
                + "00000000" // 0
        );
        // 'h'/'H' hardened markers and a missing leading m/ both parse.
        assert_eq!(parse_bip32_path("44h/60h/2h/0/5").unwrap().len(), 5);
        assert_eq!(ledger_live_path(3), "m/44'/60'/3'/0/0");
    }

    #[test]
    fn rejects_bad_paths() {
        assert!(parse_bip32_path("m/").is_err()); // empty
        assert!(parse_bip32_path("m/44'/xyz/0").is_err()); // non-numeric
        assert!(parse_bip32_path("m/0/1/2/3/4/5/6/7/8/9/10").is_err()); // too many
    }

    #[test]
    fn apdu_layout_and_length_guard() {
        let a = apdu(INS_GET_ADDRESS, 0x00, 0x00, &[0xaa, 0xbb]).unwrap();
        assert_eq!(a, vec![0xe0, 0x02, 0x00, 0x00, 0x02, 0xaa, 0xbb]);
        assert!(apdu(INS_SIGN_TX, 0, 0, &vec![0u8; 256]).is_err());
    }

    #[test]
    fn frame_first_packet_has_channel_tag_seq_and_total_len() {
        let a = apdu(INS_GET_ADDRESS, 0x00, 0x00, &[0x01, 0x02, 0x03]).unwrap(); // 8 bytes
        let pkts = frame(&a);
        assert_eq!(pkts.len(), 1);
        let p = &pkts[0];
        assert_eq!(&p[0..2], &[0x01, 0x01]); // channel
        assert_eq!(p[2], 0x05); // tag
        assert_eq!(&p[3..5], &[0x00, 0x00]); // seq 0
        assert_eq!(&p[5..7], &[0x00, 0x08]); // total apdu length = 8
        assert_eq!(&p[7..15], &a[..]); // the apdu bytes follow
    }

    #[test]
    fn frame_deframe_roundtrip_multi_packet() {
        // An APDU larger than one packet (must span ≥2 reports).
        let data: Vec<u8> = (0u16..200).map(|i| (i % 251) as u8).collect();
        let a = apdu(INS_SIGN_PERSONAL, 0x00, 0x00, &data).unwrap(); // 205 bytes
        let pkts = frame(&a);
        assert!(pkts.len() >= 2, "should span multiple HID reports");
        // Sequence numbers increment 0,1,2…
        for (i, p) in pkts.iter().enumerate() {
            assert_eq!(u16::from_be_bytes([p[3], p[4]]), i as u16);
        }
        // Deframing the same packets (as if they were the response framing) recovers it.
        let owned: Vec<Vec<u8>> = pkts.iter().map(|p| p.to_vec()).collect();
        assert_eq!(deframe(&owned).unwrap(), a);
    }

    #[test]
    fn deframe_rejects_out_of_order_and_short() {
        // Build two valid packets then swap their sequence to corrupt ordering.
        let a = apdu(INS_SIGN_TX, 0, 0, &vec![7u8; 120]).unwrap();
        let mut pkts: Vec<Vec<u8>> = frame(&a).iter().map(|p| p.to_vec()).collect();
        pkts.swap(0, 1);
        assert!(deframe(&pkts).is_err());
        assert!(deframe(&[vec![0x01, 0x01, 0x05]]).is_err()); // too short
    }

    #[test]
    fn check_sw_maps_status_words() {
        assert_eq!(check_sw(&[0xde, 0xad, 0x90, 0x00]).unwrap(), &[0xde, 0xad]);
        assert!(check_sw(&[0x69, 0x85]).unwrap_err().contains("rejected"));
        assert!(check_sw(&[0x6e, 0x00]).unwrap_err().contains("Ethereum app"));
        assert!(check_sw(&[0x69, 0x82]).unwrap_err().contains("Unlock"));
        assert!(check_sw(&[0x6a, 0x80]).unwrap_err().contains("blind signing"));
    }

    #[test]
    fn parses_address_response() {
        // pubkeyLen=0x41(65) ‖ 65 pubkey bytes ‖ addrLen=40 ‖ 40 ascii hex chars.
        let mut data = vec![0x41];
        data.extend_from_slice(&[0xab; 65]);
        let addr = "f39fd6e51aad88f6f4ce6ab8827279cfffb92266";
        data.push(40);
        data.extend_from_slice(addr.as_bytes());
        assert_eq!(
            parse_address_response(&data).unwrap(),
            "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
        );
        // An uppercase / 0x-prefixed ascii address is normalized to lowercase 0x.
        let mut d2 = vec![0x01, 0x00, 4];
        d2.extend_from_slice(b"ABCD");
        assert!(parse_address_response(&d2).is_err()); // wrong length → rejected
    }

    #[test]
    fn parses_signature_and_normalizes_v() {
        let mut data = vec![0x00]; // v = 0 (device parity)
        data.extend_from_slice(&[0x11; 32]); // r
        data.extend_from_slice(&[0x22; 32]); // s
        let (v, r, s) = parse_signature(&data).unwrap();
        assert_eq!(v, 0);
        assert_eq!(r, [0x11; 32]);
        assert_eq!(s, [0x22; 32]);
        // EIP-191 normalization: 0/1 → 27/28; 27/28 unchanged.
        assert_eq!(normalize_eip191_v(0), 27);
        assert_eq!(normalize_eip191_v(1), 28);
        assert_eq!(normalize_eip191_v(28), 28);
        // r‖s‖v assembly is 65 bytes with v last.
        let sig = assemble_rsv(r, s, normalize_eip191_v(v));
        assert_eq!(sig.len(), 65);
        assert_eq!(sig[64], 27);
    }
}
