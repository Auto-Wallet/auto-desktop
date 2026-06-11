//! CI smoke mode: exercises the real dApp pipeline on the actual platform
//! webview (WebView2 on Windows, WKWebView on macOS) — webview creation +
//! positioning, provider injection, the `wallet_request` ACL grant, and the
//! invoke round-trip — none of which the `tauri::test` MockRuntime e2e covers.
//!
//! Activated only when `AUTODESKTOP_SMOKE_DIR` is set (see ci.yml): a loopback
//! HTTP server serves a minimal dApp page, `open_dapp` loads it into a real
//! `dapp-*` child webview, the page calls `window.ethereum.request` and posts
//! the outcome back, and the server writes `smoke-result.json` into the dir for
//! the CI runner (scripts/smoke-ci.ts) to assert on. Setup failures panic —
//! this path runs only in CI, where a loud crash is the correct outcome.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;

use tauri::{AppHandle, Runtime};

const SMOKE_PAGE: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><title>AutoDesktop smoke dApp</title></head>
<body style="font-family: sans-serif; background: #eef2ff; margin: 24px">
<h1>AutoDesktop smoke dApp</h1>
<pre id="out">waiting for injected provider…</pre>
<script>
(async () => {
  const out = document.getElementById('out');
  const report = (payload) =>
    fetch('/result?payload=' + encodeURIComponent(JSON.stringify(payload)));
  try {
    const start = Date.now();
    while (!window.ethereum && Date.now() - start < 10000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!window.ethereum) throw new Error('window.ethereum was never injected');
    const chainId = await window.ethereum.request({ method: 'eth_chainId' });
    const accounts = await window.ethereum.request({ method: 'eth_accounts' });
    out.textContent = 'ok: chainId=' + chainId + ' accounts=' + JSON.stringify(accounts);
    await report({ ok: true, chainId, accounts });
  } catch (e) {
    out.textContent = 'failed: ' + e;
    await report({ ok: false, error: String((e && e.message) || e) });
  }
})();
</script>
</body></html>"#;

/// Entry point, called at the end of `setup()` (the main window and shell
/// webview already exist). No-op unless `AUTODESKTOP_SMOKE_DIR` is set.
pub fn maybe_start<R: Runtime>(app: &AppHandle<R>) {
    let Some(dir) = std::env::var_os("AUTODESKTOP_SMOKE_DIR") else {
        return;
    };
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("smoke: cannot create AUTODESKTOP_SMOKE_DIR");

    let listener =
        TcpListener::bind("127.0.0.1:0").expect("smoke: cannot bind loopback listener");
    let port = listener.local_addr().expect("smoke: listener has no addr").port();
    std::thread::spawn(move || serve(listener, dir));

    let url = format!("http://127.0.0.1:{port}/");
    println!("[AutoDesktop] smoke: opening dapp webview at {url}");
    // Same entry the shell uses, so label validation, webview creation and the
    // content_to_frame positioning are all exercised for real.
    crate::open_dapp(
        app.clone(),
        "dapp-smoke-1".to_string(),
        url,
        16.0,
        120.0,
        800.0,
        520.0,
    )
    .expect("smoke: open_dapp failed");
}

fn serve(listener: TcpListener, dir: PathBuf) {
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let mut buf = [0u8; 16384];
        let n = stream.read(&mut buf).unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]);
        let target = req.split_whitespace().nth(1).unwrap_or("/").to_string();
        if let Some(encoded) = target.strip_prefix("/result?payload=") {
            let payload = percent_decode(encoded);
            println!("[AutoDesktop] smoke: result reported: {payload}");
            // Write-then-rename so the CI poller never reads a partial file.
            let tmp = dir.join("smoke-result.json.tmp");
            std::fs::write(&tmp, payload.as_bytes()).expect("smoke: write result");
            std::fs::rename(&tmp, dir.join("smoke-result.json"))
                .expect("smoke: rename result");
            let _ = stream.write_all(
                b"HTTP/1.1 204 No Content\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
            );
        } else {
            let body = SMOKE_PAGE.as_bytes();
            let head = format!(
                "HTTP/1.1 200 OK\r\nconnection: close\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(body);
        }
    }
}

/// Minimal percent-decoding for the `encodeURIComponent` payload (which never
/// emits a bare `+`, so no `+`→space handling).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(b) = std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn decodes_encode_uri_component_output() {
        // encodeURIComponent('{"ok":true,"chainId":"0x1"}')
        let encoded = "%7B%22ok%22%3Atrue%2C%22chainId%22%3A%220x1%22%7D";
        assert_eq!(percent_decode(encoded), r#"{"ok":true,"chainId":"0x1"}"#);
    }

    #[test]
    fn passes_through_plain_and_malformed_sequences() {
        assert_eq!(percent_decode("abc-123"), "abc-123");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
