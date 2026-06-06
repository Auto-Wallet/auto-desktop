// Verifies the first-run onboarding chooser + import (phrase/private-key) + the
// honest Ledger placeholder in the debuggable Chrome (:9222) against the dev
// server (:1420). The unlock + forgot-password reset path needs a real on-disk
// keystore (phase === "locked"), which the no-backend browser preview can't
// produce — that path is covered by the Rust tests + native QA.
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
    const l2 = (await (await fetch(`${CDP}/json`)).json()) as any[];
    p = l2.find((t) => t.type === "page");
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
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
};
const send = (method: string, params: any = {}) =>
  new Promise<any>((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
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

console.log("1) first-run chooser (3 options)");
const optCount = await evalJs(`document.querySelectorAll('.lock-option').length`);
ok(optCount === 3, `chooser shows 3 options (got ${optCount})`);
const titles = await evalJs(
  `[...document.querySelectorAll('.lock-option-title')].map(e=>e.textContent).join(' | ')`,
);
console.log(`     options: ${titles}`);
ok(/创建新钱包/.test(titles), "‘创建新钱包’ present");
ok(/导入已有钱包/.test(titles), "‘导入已有钱包’ present");
ok(/连接 Ledger/.test(titles), "‘连接 Ledger’ present");
await shot("ob-1-chooser");

console.log("2) import → phrase/private-key tabs");
await evalJs(
  `[...document.querySelectorAll('.lock-option')].find(b=>/导入已有钱包/.test(b.textContent)).click()`,
);
await sleep(300);
const tabCount = await evalJs(`document.querySelectorAll('.lock-tab').length`);
ok(tabCount === 2, `import shows 2 tabs (got ${tabCount})`);
const tabLabels = await evalJs(
  `[...document.querySelectorAll('.lock-tab')].map(e=>e.textContent).join(' | ')`,
);
console.log(`     tabs: ${tabLabels}`);
ok(/助记词/.test(tabLabels) && /私钥/.test(tabLabels), "tabs are 助记词 / 私钥");
await shot("ob-2-import-phrase");

console.log("3) switch to private-key tab");
await evalJs(
  `[...document.querySelectorAll('.lock-tab')].find(b=>b.textContent.trim()==='私钥').click()`,
);
await sleep(250);
const ph = await evalJs(`document.querySelector('.lock-textarea')?.placeholder ?? ''`);
console.log(`     placeholder: ${ph}`);
ok(/64/.test(ph), "private-key field placeholder mentions 64 hex");
const importBtn = await evalJs(`document.querySelector('.lock-primary')?.textContent ?? ''`);
ok(/导入私钥/.test(importBtn), `import button reads ‘导入私钥’ (got “${importBtn}”)`);
await shot("ob-3-import-privkey");

console.log("4) back → Ledger placeholder (honest)");
await evalJs(`[...document.querySelectorAll('.lock-link')].find(b=>/返回/.test(b.textContent)).click()`);
await sleep(250);
await evalJs(
  `[...document.querySelectorAll('.lock-option')].find(b=>/连接 Ledger/.test(b.textContent)).click()`,
);
await sleep(250);
const info = await evalJs(`document.querySelector('.lock-info')?.textContent ?? ''`);
console.log(`     ledger note: ${info.slice(0, 40)}…`);
ok(/USB\/HID|即将/.test(info), "Ledger panel shows honest ‘coming soon / needs HID backend’ note");
await shot("ob-4-ledger");

ws.close();
console.log("done.");
