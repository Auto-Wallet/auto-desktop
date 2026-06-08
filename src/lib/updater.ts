import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./platform";

export type UpdateInfo = {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  releaseUrl: string;
  downloadUrl?: string | null;
};

export async function checkForUpdate(): Promise<UpdateInfo> {
  if (!isTauri()) {
    return {
      currentVersion: "0.1.3",
      latestVersion: "0.1.3",
      available: false,
      releaseUrl: "https://github.com/Auto-Wallet/auto-desktop/releases",
      downloadUrl: null,
    };
  }
  return invoke<UpdateInfo>("check_for_update");
}
