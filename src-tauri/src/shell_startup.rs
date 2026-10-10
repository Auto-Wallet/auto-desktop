//! Recover a shell whose WebContent process dies before its first page loads.
//! WKWebView reload has no history item at that point, so it leaves a blank
//! window. Keep the URL requested by Tauri and navigate to it explicitly.
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, Runtime, Url, WebviewBuilder};

#[derive(Default)]
struct Startup {
    requested_url: Option<Url>,
    finished: bool,
    recovery_attempted: bool,
}

impl Startup {
    fn navigation(&mut self, url: &Url) {
        if self.requested_url.is_none() {
            self.requested_url = Some(url.clone());
        }
    }

    fn recovery_url(&mut self) -> Result<Option<Url>, &'static str> {
        if self.finished {
            return Ok(None);
        }
        if self.recovery_attempted {
            return Err("shell WebContent terminated again during startup");
        }
        self.recovery_attempted = true;
        self.requested_url
            .clone()
            .map(Some)
            .ok_or("shell startup URL was never requested")
    }
}

#[derive(Clone, Default)]
struct ShellStartup(Arc<Mutex<Startup>>);

pub fn install<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    let builder = builder.manage(ShellStartup::default());
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(|shell| {
        if shell.label() != "shell" {
            return;
        }
        let state = shell.state::<ShellStartup>();
        let target = state.0.lock().unwrap().recovery_url();
        match target {
            Ok(Some(url)) => {
                super::log_diagnostic(shell.app_handle(), format!(
                    "version={} shell WebContent terminated before startup finished; navigating to {url}",
                    env!("CARGO_PKG_VERSION")
                ));
                if let Err(error) = shell.navigate(url) {
                    super::log_diagnostic(shell.app_handle(), format!("shell startup recovery failed: {error}"));
                }
            }
            Ok(None) => {
                // WebKit's own crash reload can use history after startup.
                super::log_diagnostic(shell.app_handle(), "shell WebContent terminated after startup");
            }
            Err(error) => super::log_diagnostic(shell.app_handle(), error),
        }
    });
    builder
}

pub fn configure<R: Runtime>(app: &AppHandle<R>, builder: WebviewBuilder<R>) -> WebviewBuilder<R> {
    let navigation_state = app.state::<ShellStartup>().inner().clone();
    builder
        .on_navigation(move |url| {
            navigation_state.0.lock().unwrap().navigation(url);
            true
        })
        .on_page_load(|shell, payload| {
            super::log_diagnostic(
                shell.app_handle(),
                format!(
                    "version={} shell page-load {:?} url={}",
                    env!("CARGO_PKG_VERSION"),
                    payload.event(),
                    payload.url()
                ),
            );
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                shell.state::<ShellStartup>().0.lock().unwrap().finished = true;
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovers_the_requested_url_before_the_first_page_finishes() {
        let url = Url::parse("http://localhost:1420/").unwrap();
        let mut startup = Startup::default();
        startup.navigation(&url);
        assert_eq!(startup.recovery_url(), Ok(Some(url)));
        assert_eq!(
            startup.recovery_url(),
            Err("shell WebContent terminated again during startup")
        );
    }

    #[test]
    fn does_not_replace_the_startup_url_with_a_later_navigation() {
        let first = Url::parse("https://example.com/app/").unwrap();
        let mut startup = Startup::default();
        startup.navigation(&first);
        startup.navigation(&Url::parse("about:blank").unwrap());
        assert_eq!(startup.recovery_url(), Ok(Some(first)));
    }

    #[test]
    fn finished_pages_skip_startup_recovery_and_missing_urls_are_errors() {
        let mut startup = Startup::default();
        assert_eq!(
            startup.recovery_url(),
            Err("shell startup URL was never requested")
        );
        startup.finished = true;
        assert_eq!(startup.recovery_url(), Ok(None));
    }
}
