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

    /// Models what a signed build showed on macOS: deleting the old plain item
    /// (a query without kSecUseDataProtectionKeychain) ALSO matches and deletes
    /// the protected item. Saving must therefore clear the plain copy first —
    /// clearing it after the save deleted the password it had just stored, and
    /// every Touch ID unlock then found nothing.
    #[test]
    fn replacing_the_password_leaves_the_protected_item_in_place() {
        use super::{replace_password, CredentialStore};

        #[derive(Default)]
        struct Keychain {
            plain: Option<String>,
            protected: Option<String>,
        }
        impl CredentialStore for Keychain {
            fn delete_plain(&mut self) -> Result<(), String> {
                self.plain = None;
                self.protected = None; // the query matches both keychains
                Ok(())
            }
            fn save_protected(&mut self, password: &str) -> Result<(), String> {
                self.protected = Some(password.to_string());
                Ok(())
            }
        }

        let mut keychain = Keychain {
            plain: Some("old".into()),
            protected: None,
        };
        replace_password(&mut keychain, "new-password").unwrap();
        assert_eq!(keychain.protected.as_deref(), Some("new-password"));
        assert_eq!(keychain.plain, None, "the unprotected copy is gone");
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

/// The two keychain operations a save needs, split out so their order is testable.
pub(crate) trait CredentialStore {
    /// Remove the plain login-keychain item older versions wrote.
    fn delete_plain(&mut self) -> Result<(), String>;
    /// Store the password behind the Touch ID access control.
    fn save_protected(&mut self, password: &str) -> Result<(), String>;
}

/// Clear the plain copy FIRST. On macOS that delete also matches the protected
/// item, so running it after the save wiped the password just stored.
pub(crate) fn replace_password(store: &mut impl CredentialStore, password: &str) -> Result<(), String> {
    store.delete_plain()?;
    store.save_protected(password)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::data::CFData;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use objc2::rc::Retained;
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::passwords::{
        delete_generic_password, delete_generic_password_options,
        set_generic_password_options,
    };
    use security_framework::passwords_options::{AccessControlOptions, PasswordOptions};
    use security_framework_sys::item::{
        kSecAttrAccount, kSecAttrService, kSecClass, kSecClassGenericPassword, kSecReturnData,
        kSecUseAuthenticationContext, kSecUseDataProtectionKeychain,
    };
    use security_framework_sys::keychain_item::SecItemCopyMatching;
    use std::sync::mpsc;

    const SERVICE: &str = "com.autowallet.desktop.touch-id";
    const ACCOUNT: &str = "vault-password";
    const ERR_SEC_SUCCESS: i32 = 0;
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

    fn protected_options(service: &str, account: &str) -> PasswordOptions {
        let mut options = PasswordOptions::new_generic_password(service, account);
        options.use_protected_keychain();
        options
    }

    /// Store the vault password so that only a Touch ID match with the CURRENT
    /// enrolled fingers releases it, on this Mac only (never synced, gone if the
    /// login password is removed). macOS enforces this, not our code. Needs the
    /// keychain entitlement: an unsigned build fails with -34018 and stores
    /// nothing — there is deliberately no weaker fallback.
    fn save_password_at(service: &str, account: &str, password: &str) -> Result<(), String> {
        let access = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenPasscodeSetThisDeviceOnly),
            AccessControlOptions::BIOMETRY_CURRENT_SET.bits(),
        )
        .map_err(|error| format!("creating the Touch ID access control: {error}"))?;
        // Replace, never update: an existing item may carry an older policy.
        match delete_generic_password_options(protected_options(service, account)) {
            Ok(()) => {}
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => {}
            Err(error) => return Err(keychain_error("replacing the Touch ID unlock credential", error.code(), &error.to_string())),
        }
        let mut options = protected_options(service, account);
        options.set_access_control(access);
        set_generic_password_options(password.as_bytes(), options).map_err(|error| {
            keychain_error("saving the Touch ID unlock credential", error.code(), &error.to_string())
        })
    }

    fn keychain_error(action: &str, code: i32, message: &str) -> String {
        if code == -34018 {
            format!(
                "{action}: this build is not signed with the keychain entitlement (-34018: {message}). Touch ID unlock works only in the signed release build."
            )
        } else {
            format!("{action}: {message} ({code})")
        }
    }

    struct SystemKeychain;

    impl CredentialStore for SystemKeychain {
        // Older versions kept the password as a plain login-keychain item;
        // never leave that copy behind next to the protected one.
        fn delete_plain(&mut self) -> Result<(), String> {
            delete_legacy_password()
        }
        fn save_protected(&mut self, password: &str) -> Result<(), String> {
            save_password_at(SERVICE, ACCOUNT, password)
        }
    }

    pub fn save_password(password: &str) -> Result<(), String> {
        replace_password(&mut SystemKeychain, password)
    }

    /// Read the password. macOS shows ONE Touch ID prompt, with `reason`, and
    /// hands the item over only on a match. `Ok(None)` means there is no
    /// protected item — e.g. Touch ID was enabled by a version that used the
    /// plain login keychain, so it must be turned on again.
    pub fn load_password(reason: &str) -> Result<Option<Zeroizing<String>>, String> {
        if reason.trim().is_empty() {
            return Err("Touch ID reason must not be empty".to_string());
        }
        let context: Retained<LAContext> = unsafe { LAContext::new() };
        unsafe { context.setLocalizedReason(&NSString::from_str(reason)) };
        let context_ref = Retained::as_ptr(&context) as CFTypeRef;

        let query = unsafe {
            CFDictionary::<CFType, CFType>::from_CFType_pairs(&[
                (
                    CFString::wrap_under_get_rule(kSecClass).as_CFType(),
                    CFString::wrap_under_get_rule(kSecClassGenericPassword).as_CFType(),
                ),
                (
                    CFString::wrap_under_get_rule(kSecAttrService).as_CFType(),
                    CFString::new(SERVICE).as_CFType(),
                ),
                (
                    CFString::wrap_under_get_rule(kSecAttrAccount).as_CFType(),
                    CFString::new(ACCOUNT).as_CFType(),
                ),
                (
                    CFString::wrap_under_get_rule(kSecReturnData).as_CFType(),
                    CFBoolean::true_value().as_CFType(),
                ),
                (
                    CFString::wrap_under_get_rule(kSecUseDataProtectionKeychain).as_CFType(),
                    CFBoolean::true_value().as_CFType(),
                ),
                (
                    CFString::wrap_under_get_rule(kSecUseAuthenticationContext).as_CFType(),
                    CFType::wrap_under_get_rule(context_ref),
                ),
            ])
        };
        let mut result: CFTypeRef = std::ptr::null();
        let status = unsafe { SecItemCopyMatching(query.as_concrete_TypeRef(), &mut result) };
        match status {
            ERR_SEC_SUCCESS => {}
            ERR_SEC_ITEM_NOT_FOUND => return Ok(None),
            code => {
                let message = security_framework::base::Error::from_code(code).to_string();
                return Err(keychain_error("Touch ID unlock", code, &message));
            }
        }
        if result.is_null() {
            return Err("Touch ID unlock: the keychain returned no data".to_string());
        }
        let data = unsafe { CFData::wrap_under_create_rule(result as _) };
        let bytes = Zeroizing::new(data.bytes().to_vec());
        let password = String::from_utf8(bytes.to_vec())
            .map_err(|_| "Touch ID credential is not valid UTF-8".to_string())?;
        Ok(Some(Zeroizing::new(password)))
    }

    fn delete_legacy_password() -> Result<(), String> {
        match delete_generic_password(SERVICE, ACCOUNT) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(error) => Err(format!("removing the old Touch ID unlock credential: {error}")),
        }
    }

    /// Remove both the protected item and any plain one an older version left.
    pub fn delete_password() -> Result<(), String> {
        match delete_generic_password_options(protected_options(SERVICE, ACCOUNT)) {
            Ok(()) => {}
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => {}
            // Unsigned builds cannot reach the protected keychain, so there is
            // nothing of ours there to remove.
            Err(error) if error.code() == -34018 => {}
            Err(error) => {
                return Err(format!("removing the Touch ID unlock credential: {error}"))
            }
        }
        delete_legacy_password()
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

        /// SECURITY: the vault password may only ever be stored behind Touch ID
        /// in the data-protection keychain. An unsigned process (this test
        /// binary, `tauri dev`) lacks the keychain entitlement, so saving must
        /// FAIL with the entitlement error — never fall back to a plain
        /// login-keychain item that any same-user process can ask for.
        #[test]
        fn unsigned_process_cannot_store_the_password_without_biometric_protection() {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let service = format!("com.autowallet.desktop.touch-id-test-{nonce}");
            let account = "temporary-test-password";

            let result = save_password_at(&service, account, "not-a-real-wallet-password");
            // Clean up in case an unprotected item was written.
            let _ = delete_generic_password(&service, account);
            let error = result.expect_err("must not store without biometric protection");
            assert!(
                error.contains("entitlement"),
                "expected the missing-entitlement error, got: {error}"
            );
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

    pub fn load_password(_reason: &str) -> Result<Option<Zeroizing<String>>, String> {
        Err("Touch ID is only available on macOS".to_string())
    }

    pub fn delete_password() -> Result<(), String> {
        Ok(())
    }
}

pub use platform::{authenticate, available, delete_password, load_password, save_password};
