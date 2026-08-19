#[cfg(test)]
mod tests {
    use super::{read_enabled_marker, remove_enabled_marker, write_enabled_marker};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn marker_path() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("autodesktop-touch-id-{nonce}"))
    }

    #[test]
    fn enabled_marker_round_trips_and_can_be_removed() {
        let path = marker_path();
        assert!(!read_enabled_marker(&path).expect("missing marker"));

        write_enabled_marker(&path).expect("write marker");
        assert!(read_enabled_marker(&path).expect("read marker"));

        remove_enabled_marker(&path).expect("remove marker");
        assert!(!read_enabled_marker(&path).expect("removed marker"));
    }

    #[test]
    fn malformed_marker_is_reported_instead_of_silently_enabling_touch_id() {
        let path = marker_path();
        std::fs::write(&path, "unexpected").expect("write malformed marker");
        let error = read_enabled_marker(&path).expect_err("malformed marker must fail");
        assert!(error.contains("invalid Touch ID marker"));
        std::fs::remove_file(path).expect("remove malformed marker");
    }
}
use serde::Serialize;
use std::path::Path;
use zeroize::Zeroizing;

const ENABLED_MARKER: &str = "autodesktop-touch-id-v1\n";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TouchIdStatus {
    pub available: bool,
    pub enabled: bool,
}

pub fn read_enabled_marker(path: &Path) -> Result<bool, String> {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("reading Touch ID marker: {error}")),
    };
    if contents != ENABLED_MARKER {
        return Err("invalid Touch ID marker".to_string());
    }
    Ok(true)
}

pub fn write_enabled_marker(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("creating Touch ID settings directory: {error}"))?;
    }
    std::fs::write(path, ENABLED_MARKER)
        .map_err(|error| format!("writing Touch ID marker: {error}"))
}

pub fn remove_enabled_marker(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("removing Touch ID marker: {error}")),
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };
    use std::sync::mpsc;

    const SERVICE: &str = "com.autowallet.desktop.touch-id";
    const ACCOUNT: &str = "vault-password";
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

    fn authentication_error(error: &NSError) -> String {
        error.localizedDescription().to_string()
    }

    pub fn available() -> bool {
        let context = unsafe { LAContext::new() };
        unsafe {
            context.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics)
        }
        .is_ok()
    }

    pub fn authenticate(reason: &str) -> Result<(), String> {
        if reason.trim().is_empty() {
            return Err("Touch ID reason must not be empty".to_string());
        }

        let context = unsafe { LAContext::new() };
        let policy = LAPolicy::DeviceOwnerAuthenticationWithBiometrics;
        unsafe { context.canEvaluatePolicy_error(policy) }.map_err(|error| {
            format!("Touch ID is unavailable: {}", authentication_error(&error))
        })?;

        let reason = NSString::from_str(reason);
        let (sender, receiver) = mpsc::channel();
        let reply: RcBlock<dyn Fn(Bool, *mut NSError)> =
            RcBlock::new(move |success: Bool, error: *mut NSError| {
                let result = if success.as_bool() {
                    Ok(())
                } else if error.is_null() {
                    Err("Touch ID authentication failed".to_string())
                } else {
                    let description = unsafe { authentication_error(&*error) };
                    Err(format!("Touch ID authentication failed: {description}"))
                };
                let _ = sender.send(result);
            });

        unsafe {
            context.evaluatePolicy_localizedReason_reply(policy, &reason, &reply);
        }
        receiver
            .recv()
            .map_err(|_| "Touch ID authentication ended without a result".to_string())?
    }

    fn save_password_at(service: &str, account: &str, password: &str) -> Result<(), String> {
        set_generic_password(service, account, password.as_bytes())
            .map_err(|error| format!("saving Touch ID unlock credential: {error}"))
    }

    pub fn save_password(password: &str) -> Result<(), String> {
        save_password_at(SERVICE, ACCOUNT, password)
    }

    pub fn load_password() -> Result<Zeroizing<String>, String> {
        let bytes = Zeroizing::new(
            get_generic_password(SERVICE, ACCOUNT)
                .map_err(|error| format!("Touch ID authentication failed: {error}"))?,
        );
        let password = String::from_utf8(bytes.to_vec())
            .map_err(|_| "Touch ID credential is not valid UTF-8".to_string())?;
        Ok(Zeroizing::new(password))
    }

    pub fn delete_password() -> Result<(), String> {
        match delete_generic_password(SERVICE, ACCOUNT) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(error) => Err(format!("removing Touch ID unlock credential: {error}")),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{authenticate, save_password_at};
        use security_framework::passwords::delete_generic_password;
        use std::time::{SystemTime, UNIX_EPOCH};

        #[test]
        fn touch_id_prompt_requires_a_localized_reason() {
            assert_eq!(
                authenticate("").expect_err("empty reason must fail before prompting"),
                "Touch ID reason must not be empty"
            );
        }

        #[test]
        #[ignore = "writes and removes a temporary item in the local macOS Keychain"]
        fn unsigned_debug_process_can_save_the_unlock_credential() {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let service = format!("com.autowallet.desktop.touch-id-test-{nonce}");
            let account = "temporary-test-password";

            save_password_at(&service, account, "not-a-real-wallet-password")
                .expect("unsigned debug process should save local Keychain item");
            delete_generic_password(&service, account).expect("remove temporary protected item");
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;

    pub fn available() -> bool {
        false
    }

    pub fn authenticate(_reason: &str) -> Result<(), String> {
        Err("Touch ID is only available on macOS".to_string())
    }

    pub fn save_password(_password: &str) -> Result<(), String> {
        Err("Touch ID is only available on macOS".to_string())
    }

    pub fn load_password() -> Result<Zeroizing<String>, String> {
        Err("Touch ID is only available on macOS".to_string())
    }

    pub fn delete_password() -> Result<(), String> {
        Ok(())
    }
}

pub use platform::{authenticate, available, delete_password, load_password, save_password};
