use tauri::menu::{Menu, MenuItemKind, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

pub const DEBUG_SHELL_CONSOLE_MENU_ID: &str = "debug-shell-console";
pub const DEBUG_DAPP_CONSOLE_MENU_ID: &str = "debug-dapp-console";

pub fn validate_language(language: &str) -> Result<(), String> {
    match language {
        "en" | "zh" => Ok(()),
        _ => Err(format!("unsupported app menu language {language:?}")),
    }
}

pub fn localized_menu_text(language: &str, english: &str) -> String {
    if language != "zh" {
        return english.to_string();
    }

    match english {
        "File" => "文件".to_string(),
        "Edit" => "编辑".to_string(),
        "View" => "显示".to_string(),
        "Window" => "窗口".to_string(),
        "Help" => "帮助".to_string(),
        "Debug" => "调试".to_string(),
        "Undo" => "撤销".to_string(),
        "Redo" => "重做".to_string(),
        "Cut" => "剪切".to_string(),
        "Copy" => "拷贝".to_string(),
        "Paste" => "粘贴".to_string(),
        "Select All" => "全选".to_string(),
        "Enter Full Screen" => "进入全屏幕".to_string(),
        "Minimize" => "最小化".to_string(),
        "Zoom" => "缩放".to_string(),
        "Close Window" => "关闭窗口".to_string(),
        "Services" => "服务".to_string(),
        "Hide Others" => "隐藏其他".to_string(),
        "Show All" => "全部显示".to_string(),
        "Bring All to Front" => "前置全部窗口".to_string(),
        "Toggle Main Window Console" => "切换主窗口控制台".to_string(),
        "Toggle dApp Page Console" => "切换 dApp 页面控制台".to_string(),
        text if text.starts_with("About ") => text.replacen("About ", "关于 ", 1),
        text if text.starts_with("Hide ") => text.replacen("Hide ", "隐藏 ", 1),
        text if text.starts_with("Quit ") => text.replacen("Quit ", "退出 ", 1),
        _ => english.to_string(),
    }
}

fn localize_item<R: Runtime>(item: &MenuItemKind<R>, language: &str) -> tauri::Result<()> {
    match item {
        MenuItemKind::Submenu(submenu) => {
            let text = submenu.text()?;
            submenu.set_text(localized_menu_text(language, &text))?;
            for child in submenu.items()? {
                localize_item(&child, language)?;
            }
        }
        MenuItemKind::MenuItem(item) => {
            let text = item.text()?;
            item.set_text(localized_menu_text(language, &text))?;
        }
        MenuItemKind::Predefined(item) => {
            let text = item.text()?;
            item.set_text(localized_menu_text(language, &text))?;
        }
        MenuItemKind::Check(item) => {
            let text = item.text()?;
            item.set_text(localized_menu_text(language, &text))?;
        }
        MenuItemKind::Icon(item) => {
            let text = item.text()?;
            item.set_text(localized_menu_text(language, &text))?;
        }
    }
    Ok(())
}

pub fn build<R: Runtime>(app: &AppHandle<R>, language: &str) -> Result<Menu<R>, String> {
    validate_language(language)?;
    let menu = Menu::default(app).map_err(|error| format!("building app menu: {error}"))?;
    for item in menu
        .items()
        .map_err(|error| format!("reading app menu: {error}"))?
    {
        localize_item(&item, language).map_err(|error| format!("localizing app menu: {error}"))?;
    }

    let debug_menu = SubmenuBuilder::new(app, localized_menu_text(language, "Debug"))
        .text(
            DEBUG_SHELL_CONSOLE_MENU_ID,
            localized_menu_text(language, "Toggle Main Window Console"),
        )
        .text(
            DEBUG_DAPP_CONSOLE_MENU_ID,
            localized_menu_text(language, "Toggle dApp Page Console"),
        )
        .build()
        .map_err(|error| format!("building debug menu: {error}"))?;
    menu.append(&debug_menu)
        .map_err(|error| format!("adding debug menu: {error}"))?;
    Ok(menu)
}

#[cfg(test)]
mod tests {
    use super::{localized_menu_text, validate_language};

    #[test]
    fn chinese_menu_translates_top_level_and_native_actions() {
        assert_eq!(localized_menu_text("zh", "File"), "文件");
        assert_eq!(localized_menu_text("zh", "Edit"), "编辑");
        assert_eq!(localized_menu_text("zh", "View"), "显示");
        assert_eq!(localized_menu_text("zh", "Window"), "窗口");
        assert_eq!(localized_menu_text("zh", "Help"), "帮助");
        assert_eq!(
            localized_menu_text("zh", "Quit AutoDesktop"),
            "退出 AutoDesktop"
        );
        assert_eq!(
            localized_menu_text("zh", "Toggle Main Window Console"),
            "切换主窗口控制台"
        );
    }

    #[test]
    fn english_menu_keeps_native_text() {
        assert_eq!(localized_menu_text("en", "File"), "File");
        assert_eq!(
            localized_menu_text("en", "Quit AutoDesktop"),
            "Quit AutoDesktop"
        );
    }

    #[test]
    fn rejects_unknown_menu_language() {
        assert!(validate_language("fr").is_err());
    }
}
