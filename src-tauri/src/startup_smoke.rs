//! Native macOS regression probe. Only present in debug builds and only runs
//! with an explicit artifact directory and a separate test app identifier.
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const MARKER: &str = "startup-smoke: React lock screen rendered and shell IPC answered";

fn enabled(app: &AppHandle) -> bool {
    std::env::var_os("AUTODESKTOP_STARTUP_SMOKE_DIR").is_some()
        && app.config().identifier == "com.autowallet.desktop.startup-test"
}

pub fn install(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    if std::env::var_os("AUTODESKTOP_STARTUP_SMOKE_DIR").is_none() {
        return builder;
    }
    let first = AtomicBool::new(true);
    builder.register_asynchronous_uri_scheme_protocol(
        "tauri",
        move |context, request, responder| {
            let app = context.app_handle();
            assert!(
                enabled(app),
                "startup smoke requires the isolated app identifier"
            );
            let path = request.uri().path();
            if !matches!(path, "/" | "/index.html" | "") || !first.swap(false, Ordering::SeqCst) {
                let asset_path = if path.is_empty() || path == "/" {
                    "index.html"
                } else {
                    path.trim_start_matches('/')
                };
                let asset = app
                    .asset_resolver()
                    .get(asset_path.into())
                    .expect("startup smoke: embedded asset missing");
                let mut response =
                    tauri::http::Response::builder().header("Content-Type", asset.mime_type);
                if let Some(csp) = asset.csp_header {
                    response = response.header("Content-Security-Policy", csp);
                }
                responder.respond(
                    response
                        .body(asset.bytes)
                        .expect("startup smoke: asset response"),
                );
                return;
            }
            // Leave the first HTML request pending without blocking the event loop.
            // No response can commit before the native kill, even on a busy runner.
            drop(responder);
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(100));
                let shell = app
                    .get_webview("shell")
                    .expect("startup smoke: shell missing");
                shell
                    .with_webview(|native| unsafe {
                        // Test-only SPI: kill this isolated WKWebView's own WebContent
                        // process before the first HTML response can commit.
                        let view = &*(native.inner() as *mut objc2::runtime::AnyObject);
                        let pid: i32 = objc2::msg_send![view, _webProcessIdentifier];
                        assert!(pid > 0, "startup smoke: no WebContent process");
                        let history: *mut objc2::runtime::AnyObject =
                            objc2::msg_send![view, backForwardList];
                        let current: *mut objc2::runtime::AnyObject =
                            objc2::msg_send![history, currentItem];
                        assert!(
                            current.is_null(),
                            "startup smoke: first page already committed"
                        );
                        unsafe extern "C" {
                            fn kill(pid: i32, signal: i32) -> i32;
                        }
                        assert_eq!(kill(pid, 9), 0, "startup smoke: kill failed");
                        println!(
                        "[AutoDesktop] startup-smoke: terminated provisional WebContent pid={pid}"
                    );
                    })
                    .expect("startup smoke: native webview unavailable");
            });
        },
    )
}

pub fn start(app: &AppHandle) {
    if !enabled(app) {
        return;
    }
    let dir = std::path::PathBuf::from(std::env::var_os("AUTODESKTOP_STARTUP_SMOKE_DIR").unwrap());
    std::fs::create_dir_all(&dir).expect("startup smoke: artifact directory");
    let log_path = super::diagnostic_log_path(app).expect("startup smoke: log path");
    let app = app.clone();
    std::thread::spawn(move || {
        let marker = format!("{MARKER} run={}", dir.display());
        let marker_json = serde_json::to_string(&marker).expect("startup smoke: marker JSON");
        let script = format!(
            r#"(() => {{
          const screen = document.querySelector('#root .lock');
          if (!screen || screen.querySelectorAll('button.opt').length !== 3 || window.__startupSmokeReady) return;
          window.__startupSmokeReady = true;
          window.__TAURI_INTERNALS__.invoke('write_diagnostic_log', {{message: {marker_json}}});
        }})();"#
        );
        for _ in 0..40 {
            std::thread::sleep(Duration::from_millis(250));
            app.get_webview("shell")
                .expect("startup smoke: shell missing")
                .eval(&script)
                .expect("startup smoke: eval failed");
            let log = std::fs::read_to_string(&log_path).expect("startup smoke: read log");
            if log.contains(&marker) {
                std::fs::write(
                    dir.join("result.json"),
                    r#"{"ok":true,"screen":"lock","choices":3,"ipc":true}"#,
                )
                .expect("startup smoke: result");
                return;
            }
        }
        std::fs::write(
            dir.join("result.json"),
            r#"{"ok":false,"error":"shell stayed blank after provisional WebContent termination"}"#,
        )
        .expect("startup smoke: result");
    });
}
