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
    "wallet.addAccount": "Add account",
    "wallet.pasteAddr": "Paste 0x address…",
    "wallet.add": "Add",
    "wallet.lock": "Lock",
    "wallet.switchAccount": "Switch account",

    "lock.tagline": "Your keys, your coins.",
    "lock.create": "Create a new wallet",
    "lock.import": "Import recovery phrase",
    "lock.unlock": "Unlock",
    "lock.password": "Password",
    "lock.newPassword": "New password",
    "lock.confirm": "Confirm password",
    "lock.min8": "At least 8 characters",
    "lock.recoveryPhrase": "Recovery phrase",
    "lock.phrasePlaceholder": "Enter your 12- or 24-word phrase…",
    "lock.back": "Back",
    "lock.continue": "Continue",
    "lock.backupWarn":
      "Write these words down and keep them safe. Anyone with this phrase controls your wallet — AutoDesktop cannot recover it for you.",
    "lock.backupAck": "I've saved my recovery phrase somewhere safe.",
    "lock.errShort": "Password must be at least 8 characters.",
    "lock.errMatch": "Passwords don't match.",
    "lock.errPhrase": "Enter a 12- or 24-word recovery phrase.",
    // First-run chooser
    "lock.chooseTitle": "How do you want to get started?",
    "lock.optCreate": "Create a new wallet",
    "lock.optCreateDesc": "Generate a new 12-word recovery phrase",
    "lock.optImport": "Import an existing wallet",
    "lock.optImportDesc": "Use a recovery phrase or private key",
    "lock.optLedger": "Connect a Ledger",
    "lock.optLedgerDesc": "Hardware wallet — no password needed",
    // Import: phrase ↔ private key
    "lock.importTab.phrase": "Recovery phrase",
    "lock.importTab.privkey": "Private key",
    "lock.privateKey": "Private key",
    "lock.privkeyPlaceholder": "0x… (64 hex characters)",
    "lock.errPrivkey": "Enter a 32-byte (64 hex character) private key.",
    "lock.importPrivkey": "Import private key",
    // Ledger
    "lock.ledgerTitle": "Connect a Ledger",
    "lock.ledgerIntro":
      "Plug in your Ledger, unlock it, and open the Ethereum app. Then scan for your accounts — no app password is needed.",
    "lock.ledgerScan": "Scan for accounts",
    "lock.ledgerScanning": "Looking for your Ledger…",
    "lock.ledgerPick": "Choose an account",
    "lock.ledgerConnect": "Connect",
    "lock.ledgerConnecting": "Confirm on your device…",
    "lock.retry": "Try again",
    // Unlock + forgot-password reset
    "lock.forgot": "Forgot password?",
    "lock.resetTitle": "Reset wallet",
    "lock.resetWarn":
      "This permanently deletes this wallet from AutoDesktop. The only way back in is your recovery phrase or private key. If you haven't backed it up, your funds are lost forever.",
    "lock.resetAck": "I have my recovery phrase / private key backed up.",
    "lock.resetConfirm": "Delete wallet",

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
    "settings.addNetwork": "Add network",
    "settings.editNetwork": "Edit network",
    "settings.netName": "Name",
    "settings.netChainId": "Chain ID",
    "settings.netSymbol": "Symbol",
    "settings.netRpc": "RPC URL",
    "settings.netDecimals": "Decimals",
    "settings.save": "Save",
    "settings.cancel": "Cancel",
    "settings.remove": "Remove",
    "settings.builtin": "Built-in",
    "settings.edit": "Edit",
    "settings.removeConfirm": "Remove this network?",
  },
  zh: {
    "nav.wallet": "钱包",
    "nav.dapps": "应用",
    "nav.settings": "设置",
    "nav.opened": "已打开的应用",

    "wallet.assets": "资产",
    "wallet.chains": "{n} 条链",
    "wallet.copy": "复制",
    "wallet.copied": "已复制",
    "wallet.refresh": "刷新",
    "wallet.signer": "签名",
    "wallet.watch": "观察",
    "wallet.addWatch": "添加观察地址",
    "wallet.addAccount": "添加账户",
    "wallet.pasteAddr": "粘贴 0x 地址…",
    "wallet.add": "添加",
    "wallet.lock": "锁定",
    "wallet.switchAccount": "切换账户",

    "lock.tagline": "你的私钥，你的资产。",
    "lock.create": "创建新钱包",
    "lock.import": "导入助记词",
    "lock.unlock": "解锁",
    "lock.password": "密码",
    "lock.newPassword": "新密码",
    "lock.confirm": "确认密码",
    "lock.min8": "至少 8 个字符",
    "lock.recoveryPhrase": "助记词",
    "lock.phrasePlaceholder": "输入你的 12 或 24 个助记词…",
    "lock.back": "返回",
    "lock.continue": "继续",
    "lock.backupWarn":
      "请抄下这些单词并妥善保管。任何拿到助记词的人都能完全控制你的钱包 —— AutoDesktop 无法帮你找回。",
    "lock.backupAck": "我已将助记词安全备份。",
    "lock.errShort": "密码至少 8 个字符。",
    "lock.errMatch": "两次输入的密码不一致。",
    "lock.errPhrase": "请输入 12 或 24 个助记词。",
    // 首次使用选择
    "lock.chooseTitle": "你想如何开始？",
    "lock.optCreate": "创建新钱包",
    "lock.optCreateDesc": "生成全新的 12 词助记词",
    "lock.optImport": "导入已有钱包",
    "lock.optImportDesc": "使用助记词或私钥",
    "lock.optLedger": "连接 Ledger",
    "lock.optLedgerDesc": "硬件钱包 —— 无需设置密码",
    // 导入：助记词 ↔ 私钥
    "lock.importTab.phrase": "助记词",
    "lock.importTab.privkey": "私钥",
    "lock.privateKey": "私钥",
    "lock.privkeyPlaceholder": "0x…（64 位十六进制）",
    "lock.errPrivkey": "请输入 32 字节（64 位十六进制）的私钥。",
    "lock.importPrivkey": "导入私钥",
    // Ledger
    "lock.ledgerTitle": "连接 Ledger",
    "lock.ledgerIntro":
      "插入并解锁你的 Ledger，打开以太坊（Ethereum）App，然后扫描账户 —— 无需设置应用密码。",
    "lock.ledgerScan": "扫描账户",
    "lock.ledgerScanning": "正在查找你的 Ledger…",
    "lock.ledgerPick": "选择一个账户",
    "lock.ledgerConnect": "连接",
    "lock.ledgerConnecting": "请在设备上确认…",
    "lock.retry": "重试",
    // 解锁 + 忘记密码重置
    "lock.forgot": "忘记密码？",
    "lock.resetTitle": "重置钱包",
    "lock.resetWarn":
      "此操作将从 AutoDesktop 永久删除该钱包。唯一的恢复途径是你的助记词或私钥。如果你没有备份，资产将永久丢失。",
    "lock.resetAck": "我已备份助记词 / 私钥。",
    "lock.resetConfirm": "删除钱包",

    "dapps.title": "应用",
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
    "settings.addNetwork": "添加网络",
    "settings.editNetwork": "编辑网络",
    "settings.netName": "名称",
    "settings.netChainId": "链 ID",
    "settings.netSymbol": "货币符号",
    "settings.netRpc": "RPC 地址",
    "settings.netDecimals": "精度",
    "settings.save": "保存",
    "settings.cancel": "取消",
    "settings.remove": "删除",
    "settings.builtin": "内置",
    "settings.edit": "编辑",
    "settings.removeConfirm": "删除这个网络？",
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
