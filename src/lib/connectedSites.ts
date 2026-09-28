import { invoke } from "@tauri-apps/api/core";

/** Origins the user connected (they see the address and may ask to sign). */
export async function loadConnectedSites(): Promise<string[]> {
  return invoke<string[]>("get_connected_sites");
}

/** Disconnect one origin; its open tabs get `accountsChanged([])`. Returns the new list. */
export async function disconnectSite(origin: string): Promise<string[]> {
  await invoke("disconnect_connected_site", { origin });
  return loadConnectedSites();
}
