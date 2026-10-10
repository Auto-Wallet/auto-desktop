import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { isTauri } from "./platform";

/** Native writes do not depend on WebKit's focus/user-activation permission. */
export async function copyText(value: string): Promise<void> {
  if (isTauri()) {
    await writeText(value);
  } else {
    await navigator.clipboard.writeText(value);
  }
}
