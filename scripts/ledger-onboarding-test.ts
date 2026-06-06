// Verifies the Ledger onboarding UI (chooser → scan → pick → connect → wallet) in
// the debuggable Chrome (:9222) against the dev server (:1420). The browser preview
// has no device, so vault.ts's demo mode synthesizes the address picker from the
// Anvil demo addresses — exercising the whole UI flow without hardware. (The real
// device path is covered by the Rust ledger:: tests + native QA.)
const CDP = "http://localhost:9222";
const APP = "http://localhost:1420/";
const OUT = "/tmp/ad-shots";

async function pageWs() {
  const list = (await (await fetch(`${CDP}/json`)).json()) as any[];
  let p =
    list.find((t) => t.type === "page" && t.url.includes("localhost:1420")) ??
    list.find((t) => t.type === "page");
  if (!p) {
    await fetch(`${CDP}/json/new?${APP}`, { method: "PUT" });
    p = ((await (await fetch(`${CDP}/json`)).json()) as any[]).find((t) => t.type === "page");
  }
  return p.webSocketDebuggerUrl as string;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(await pageWs());
let id = 0;
const pending = new Map<number, any>();
await new Promise<void>((r) => (ws.onopen = () => r()));
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data as string);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
const send = (method: string, params: any = {}) =>
  new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expression: string) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("JS: " + JSON.stringify(r.exceptionDetails));
  return r.result?.value;
};
const shot = async (name: string) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  await Bun.write(`${OUT}/${name}.png`, Buffer.from(r.data, "base64"));
  console.log(`  📸 ${name}.png`);
};
const ok = (cond: boolean, msg: string) => console.log(`  ${cond ? "✅" : "❌"} ${msg}`);

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: APP });
await sleep(900);
await evalJs(`localStorage.clear(); localStorage.setItem('autodesktop.lang','zh')`);
await send("Page.reload");
await sleep(1400);

console.log("1) chooser → 连接 Ledger");
await evalJs(`[...document.querySelectorAll('.lock-option')].find(b=>/连接 Ledger/.test(b.textContent)).click()`);
await sleep(300);
const intro = await evalJs(`document.querySelector('.lock-info')?.textContent ?? ''`);
ok(/无需设置应用密码|以太坊/.test(intro), "Ledger intro: open Ethereum app + no app password");
await shot("ledger-1-intro");

console.log("2) scan for accounts");
await evalJs(`[...document.querySelectorAll('.lock-primary')].find(b=>/扫描账户/.test(b.textContent)).click()`);
await sleep(500);
const acctCount = await evalJs(`document.querySelectorAll('.ledger-acct').length`);
ok(acctCount === 5, `address picker shows 5 accounts (got ${acctCount})`);
const firstRow = await evalJs(`document.querySelector('.ledger-acct')?.textContent ?? ''`);
console.log(`     first row: ${firstRow}`);
ok(/#0/.test(firstRow) && /…/.test(firstRow), "rows show account index + shortened address");
await shot("ledger-2-pick");

console.log("3) pick account #0 → connect → wallet");
await evalJs(`document.querySelector('.ledger-acct').click()`);
await sleep(700);
const onWallet = await evalJs(`!!document.querySelector('.wallet')`);
ok(onWallet, "after connect, the app shows the Wallet page (unlocked, no password)");
const hasLedgerBadge = await evalJs(`[...document.querySelectorAll('.badge.ledger')].length > 0`);
ok(hasLedgerBadge, "the active account shows a Ledger badge");
await shot("ledger-3-wallet");

console.log("4) Ledger wallet hides the in-app Lock (nothing to lock)");
await evalJs(`document.querySelector('.acct')?.click()`);
await sleep(300);
const hasLock = await evalJs(`!!document.querySelector('.acct-menu-lock')`);
ok(!hasLock, "no Lock action for a Ledger wallet");
await shot("ledger-4-menu");

ws.close();
console.log("done.");
