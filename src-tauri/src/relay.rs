use serde_json::Value;
use std::time::Duration;
use tauri::Runtime;

const BASE: &str = "https://api.relay.link/";

fn api_key() -> Option<String> {
    std::env::var("RELAY_API_KEY")
        .ok()
        .filter(|key| !key.trim().is_empty())
        .or_else(|| crate::read_env_file_value("RELAY_API_KEY"))
        .or_else(|| option_env!("RELAY_API_KEY").map(str::to_string))
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // Never forward an API key to a redirect target.
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Relay client: {e}"))
}

fn shell_only<R: Runtime>(webview: &tauri::Webview<R>) -> Result<(), String> {
    if webview.label() != "shell" {
        return Err("Relay commands require the trusted shell".to_string());
    }
    Ok(())
}

fn url(path: &str) -> reqwest::Url {
    reqwest::Url::parse(BASE)
        .expect("Relay base URL is valid")
        .join(path)
        .expect("Relay endpoint is valid")
}

#[tauri::command]
pub async fn relay_chains<R: Runtime>(webview: tauri::Webview<R>) -> Result<Value, String> {
    shell_only(&webview)?;
    request(&client()?, api_key().as_deref(), url("chains"), None).await
}

#[tauri::command]
pub async fn relay_quote<R: Runtime>(
    webview: tauri::Webview<R>,
    body: Value,
) -> Result<Value, String> {
    shell_only(&webview)?;
    if !body.is_object() {
        return Err("Relay quote body must be an object".to_string());
    }
    request(
        &client()?,
        api_key().as_deref(),
        url("quote/v2"),
        Some(&body),
    )
    .await
}

#[tauri::command]
pub async fn relay_status<R: Runtime>(
    webview: tauri::Webview<R>,
    request_id: String,
) -> Result<Value, String> {
    shell_only(&webview)?;
    if request_id.trim().is_empty() {
        return Err("Relay request id is required".to_string());
    }
    let mut endpoint = url("intents/status/v3");
    endpoint
        .query_pairs_mut()
        .append_pair("requestId", &request_id);
    request(&client()?, api_key().as_deref(), endpoint, None).await
}

async fn request(
    client: &reqwest::Client,
    api_key: Option<&str>,
    url: reqwest::Url,
    body: Option<&Value>,
) -> Result<Value, String> {
    if body.is_some() && api_key.is_none() {
        return Err("RELAY_API_KEY is not configured".to_string());
    }
    let builder = match body {
        Some(body) => client.post(url).json(body),
        None => client.get(url),
    };
    let builder = if let Some(key) = api_key {
        let mut header = reqwest::header::HeaderValue::from_str(key)
            .map_err(|_| "RELAY_API_KEY is invalid".to_string())?;
        header.set_sensitive(true);
        builder.header("x-api-key", header)
    } else {
        builder
    };
    let response = builder
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Relay response: {}", e.without_url()))?;
    if !status.is_success() {
        let mut error = format!("Relay HTTP {status}");
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            if let Some(message) = value.get("message").and_then(Value::as_str) {
                let safe_message = match api_key {
                    Some(key) => message.replace(key, "[redacted]"),
                    None => message.to_string(),
                };
                error.push_str(": ");
                error.push_str(&safe_message);
            }
        }
        return Err(error);
    }
    // Redact before deserialization so even an unexpected echoed key cannot
    // reach a webview or a frontend diagnostic log.
    let safe_text = match api_key {
        Some(key) => text.replace(key, "[redacted]"),
        None => text,
    };
    serde_json::from_str(&safe_text).map_err(|_| "Relay returned invalid JSON".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};

    fn server(status: &str, body: &str) -> (reqwest::Url, std::thread::JoinHandle<String>) {
        server_with_headers(status, "", body)
    }

    fn server_with_headers(
        status: &str,
        headers: &str,
        body: &str,
    ) -> (reqwest::Url, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = reqwest::Url::parse(&format!(
            "http://{}/quote/v2",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let response = format!("HTTP/1.1 {status}\r\n{headers}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut buf = [0; 4096];
                let n = stream.read(&mut buf).unwrap();
                assert!(n > 0, "request ended before its body");
                bytes.extend_from_slice(&buf[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8(bytes[..end].to_vec()).unwrap();
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(|s| s.parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8(bytes).unwrap()
        });
        (url, thread)
    }

    #[test]
    fn quote_sends_api_key_and_preserves_body() {
        let (url, server) = server("200 OK", r#"{"details":{"amount":"123"}}"#);
        let body =
            json!({"amount": "1000000", "referrer": "auto-desktop", "appFees": [{"fee": "10"}]});
        let response = tauri::async_runtime::block_on(request(
            &reqwest::Client::new(),
            Some("test-relay-key"),
            url,
            Some(&body),
        ))
        .unwrap();
        let wire = server.join().unwrap();
        assert!(wire.starts_with("POST /quote/v2 HTTP/1.1\r\n"));
        assert!(
            wire.contains("x-api-key: test-relay-key\r\n"),
            "missing Relay authentication header"
        );
        let (_, sent_body) = wire.split_once("\r\n\r\n").unwrap();
        assert_eq!(serde_json::from_str::<Value>(sent_body).unwrap(), body);
        assert_eq!(response, json!({"details": {"amount": "123"}}));
    }

    #[test]
    fn quote_without_key_fails_before_network() {
        let url = reqwest::Url::parse("http://127.0.0.1:1/quote/v2").unwrap();
        let error = tauri::async_runtime::block_on(request(
            &reqwest::Client::new(),
            None,
            url,
            Some(&json!({"amount": "1"})),
        ))
        .unwrap_err();
        assert_eq!(error, "RELAY_API_KEY is not configured");
    }

    #[test]
    fn http_errors_are_rejected_and_never_return_the_key() {
        let (url, server) = server(
            "401 Unauthorized",
            r#"{"message":"Invalid API key: test-relay-key"}"#,
        );
        let result = tauri::async_runtime::block_on(request(
            &reqwest::Client::new(),
            Some("test-relay-key"),
            url,
            Some(&json!({"amount": "1"})),
        ));
        server.join().unwrap();
        assert_eq!(
            result.unwrap_err(),
            "Relay HTTP 401 Unauthorized: Invalid API key: [redacted]"
        );
    }

    #[test]
    fn authenticated_requests_do_not_follow_redirects() {
        let (url, server) = server_with_headers(
            "307 Temporary Redirect",
            "Location: http://127.0.0.1:1/leak\r\n",
            "{}",
        );
        let result = tauri::async_runtime::block_on(request(
            &client().unwrap(),
            Some("test-relay-key"),
            url,
            Some(&json!({"amount": "1"})),
        ));
        server.join().unwrap();
        assert_eq!(result.unwrap_err(), "Relay HTTP 307 Temporary Redirect");
    }

    #[test]
    fn non_json_errors_keep_http_status() {
        let (url, server) = server("503 Service Unavailable", "upstream unavailable");
        let result = tauri::async_runtime::block_on(request(
            &client().unwrap(),
            Some("test-relay-key"),
            url,
            Some(&json!({"amount": "1"})),
        ));
        server.join().unwrap();
        assert_eq!(result.unwrap_err(), "Relay HTTP 503 Service Unavailable");
    }

    #[test]
    fn get_requests_work_without_key_and_encode_request_id() {
        let (mut url, server) = server("200 OK", r#"{"status":"success"}"#);
        url.set_path("/intents/status/v3");
        url.query_pairs_mut()
            .append_pair("requestId", "req&another=value");
        let result =
            tauri::async_runtime::block_on(request(&client().unwrap(), None, url, None)).unwrap();
        let wire = server.join().unwrap();
        assert!(
            wire.starts_with("GET /intents/status/v3?requestId=req%26another%3Dvalue HTTP/1.1\r\n")
        );
        assert!(!wire.contains("x-api-key:"));
        assert_eq!(result, serde_json::json!({"status": "success"}));
    }

    #[test]
    fn successful_responses_cannot_echo_key_to_webview() {
        let (url, server) = server("200 OK", r#"{"amount":"123","debug":"test-relay-key"}"#);
        let result = tauri::async_runtime::block_on(request(
            &client().unwrap(),
            Some("test-relay-key"),
            url,
            Some(&json!({"amount": "1"})),
        ))
        .unwrap();
        server.join().unwrap();
        assert_eq!(result, json!({"amount": "123", "debug": "[redacted]"}));
    }

    #[test]
    #[ignore = "Calls the live Relay API with RELAY_API_KEY; only requests a quote, never signs or sends a transaction"]
    fn live_relay_quote_with_configured_key() {
        let key = api_key().expect("RELAY_API_KEY must be configured");
        let body = json!({
            "user": "0x1111111111111111111111111111111111111111",
            "recipient": "0x1111111111111111111111111111111111111111",
            "originChainId": 8453, "destinationChainId": 42161,
            "originCurrency": "0x0000000000000000000000000000000000000000",
            "destinationCurrency": "0x0000000000000000000000000000000000000000",
            "amount": "10000000000000000", "tradeType": "EXACT_INPUT",
            "slippageTolerance": "50", "referrer": "auto-desktop",
            "appFees": [{"recipient": "0x7521EDa00E2Ce05aC4a9d8353d096CCB970d5188", "fee": "10"}],
        });
        let result = tauri::async_runtime::block_on(request(
            &client().unwrap(),
            Some(&key),
            url("quote/v2"),
            Some(&body),
        ))
        .expect("authenticated Relay quote");
        let out = result["details"]["currencyOut"]["amount"]
            .as_str()
            .expect("output amount");
        assert!(out.parse::<u128>().unwrap() > 0);
        assert!(result["steps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|step| step["id"] == "deposit"));
    }
}
