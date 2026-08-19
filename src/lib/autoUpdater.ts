import { useSyncExternalStore } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { isTauri } from "./platform";
import {
  createAutoUpdateController,
  type DownloadedUpdate,
} from "./autoUpdateController";

async function findAndDownload(): Promise<DownloadedUpdate | null> {
  if (!isTauri()) return null;
  const update = await check();
  if (!update) return null;

  try {
    await update.download();
  } catch (error) {
    await update.close();
    throw error;
  }

  let installed = false;
  return {
    version: update.version,
    async installAndRelaunch() {
      if (!installed) {
        await update.install();
        installed = true;
      }
      await relaunch();
    },
    async discard() {
      if (!installed) await update.close();
    },
  };
}

export const autoUpdater = createAutoUpdateController({
  findAndDownload,
  schedule: (callback, delay) => window.setTimeout(callback, delay),
  cancel: (timer) => window.clearTimeout(timer),
  reportError: (error) => {
    console.error("[AutoDesktop] automatic update failed", error);
  },
});

export function useAutoUpdate() {
  return useSyncExternalStore(
    autoUpdater.subscribe,
    autoUpdater.getSnapshot,
    autoUpdater.getSnapshot,
  );
}
