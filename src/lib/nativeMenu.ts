import { invoke } from "@tauri-apps/api/core";
import type { Lang } from "./i18n";
import { isTauri } from "./platform";

/** Keep the OS-native menu bar in sync with the language chosen inside the app. */
export async function setNativeMenuLanguage(language: Lang): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_app_menu_language", { language });
}
