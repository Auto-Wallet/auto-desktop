import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { isTauri } from "./platform";

export type UpdateInfo = {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  installed?: boolean;
  manual?: boolean;
  releaseUrl: string;
  downloadUrl?: string | null;
};

export async function checkForUpdate(): Promise<UpdateInfo> {
  if (!isTauri()) {
    return {
      currentVersion: __APP_VERSION__,
      latestVersion: __APP_VERSION__,
      available: false,
      releaseUrl: "https://github.com/Auto-Wallet/auto-desktop/releases",
      downloadUrl: null,
    };
  }
  try {
    const update = await check();
    if (!update) {
      return {
        currentVersion: __APP_VERSION__,
        latestVersion: __APP_VERSION__,
        available: false,
        releaseUrl: "https://github.com/Auto-Wallet/auto-desktop/releases",
        downloadUrl: null,
      };
    }
    await update.downloadAndInstall();
    await relaunch();
    return {
      currentVersion: __APP_VERSION__,
      latestVersion: update.version,
      available: true,
      installed: true,
      releaseUrl: "https://github.com/Auto-Wallet/auto-desktop/releases/latest",
      downloadUrl: null,
    };
  } catch {
    const fallback = await invoke<UpdateInfo>("check_for_update");
    return fallback.available ? { ...fallback, manual: true } : fallback;
  }
}
