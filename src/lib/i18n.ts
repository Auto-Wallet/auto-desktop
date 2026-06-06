// Minimal i18n for the app chrome (nav, page headers, common buttons, Settings).
// English + 中文, switched live from Settings → "语言 / Language", persisted to
// localStorage. Proper nouns (chain names, dApp hosts) are intentionally not
// translated. No dependency — a tiny dictionary + useSyncExternalStore.

import { useSyncExternalStore } from "react";

export type Lang = "en" | "zh";

const DICT: Record<Lang, Record<string, string>> = {
  en: {
    "nav.wallet": "Wallet",
    "nav.dapps": "dApps",
    "nav.settings": "Settings",
    "nav.opened": "OPENED DAPPS",

    "wallet.assets": "Assets",
    "wallet.chains": "{n} chains",
    "wallet.copy": "Copy",
    "wallet.copied": "Copied",
    "wallet.refresh": "Refresh",
    "wallet.signer": "Signer",
    "wallet.watch": "Watch",
    "wallet.addWatch": "Add watch address",
    "wallet.pasteAddr": "Paste 0x address…",
    "wallet.add": "Add",

    "dapps.title": "dApps",
    "dapps.search": "Search or paste a dApp URL…",
    "dapps.add": "Add",
    "dapps.empty": "No dApps yet — paste a URL above to add one.",
    "dapps.rename": "Double-click to rename",

    "browser.back": "Back to dApps",

    "settings.title": "Settings",
    "settings.network": "Network",
    "settings.networkHint": "The chain dApps see. Switching pushes chainChanged to open dApps.",
    "settings.active": "Active",
    "settings.language": "Language",
    "settings.languageHint": "Applies to the app interface.",
    "settings.about": "About",
    "settings.tagline": "A super-lightweight desktop wallet & dApp browser.",
    "settings.version": "Version",
    "settings.checkUpdates": "Check for updates",
    "settings.upToDate": "You're on the latest version.",
  },
  zh: {
    "nav.wallet": "钱包",
    "nav.dapps": "dApps",
    "nav.settings": "设置",
    "nav.opened": "已打开的 DAPP",

    "wallet.assets": "资产",
    "wallet.chains": "{n} 条链",
    "wallet.copy": "复制",
    "wallet.copied": "已复制",
    "wallet.refresh": "刷新",
    "wallet.signer": "签名",
    "wallet.watch": "观察",
    "wallet.addWatch": "添加观察地址",
    "wallet.pasteAddr": "粘贴 0x 地址…",
    "wallet.add": "添加",

    "dapps.title": "dApps",
    "dapps.search": "搜索或粘贴 dApp 网址…",
    "dapps.add": "添加",
    "dapps.empty": "还没有 dApp —— 在上方粘贴网址即可添加。",
    "dapps.rename": "双击重命名",

    "browser.back": "返回 dApps",

    "settings.title": "设置",
    "settings.network": "网络",
    "settings.networkHint": "dApp 看到的链。切换会向已打开的 dApp 推送 chainChanged。",
    "settings.active": "当前",
    "settings.language": "语言",
    "settings.languageHint": "应用于软件界面。",
    "settings.about": "关于",
    "settings.tagline": "超轻量级的桌面钱包 & dApp 浏览器。",
    "settings.version": "版本",
    "settings.checkUpdates": "检查更新",
    "settings.upToDate": "已是最新版本。",
  },
};

const KEY = "autodesktop.lang";

function initialLang(): Lang {
  const saved = localStorage.getItem(KEY);
  if (saved === "en" || saved === "zh") return saved;
  return typeof navigator !== "undefined" && navigator.language?.startsWith("zh") ? "zh" : "en";
}

let lang: Lang = initialLang();
const listeners = new Set<() => void>();

export function setLang(next: Lang) {
  if (next === lang) return;
  lang = next;
  localStorage.setItem(KEY, next);
  for (const l of listeners) l();
}

export type TFn = (key: string, vars?: Record<string, string | number>) => string;

function translate(l: Lang, key: string, vars?: Record<string, string | number>): string {
  let s = DICT[l][key] ?? DICT.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

/** Subscribe to the active language and get a translate function `t`. */
export function useT(): { t: TFn; lang: Lang } {
  const current = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => lang,
  );
  return { t: (key, vars) => translate(current, key, vars), lang: current };
}
