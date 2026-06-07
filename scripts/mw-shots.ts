// Visual check of the multi-wallet redesign in debuggable Chrome (:9222) against
// the vite dev server (:1420). Demo mode (no Tauri) simulates multiple wallets so
// the switcher / add-wallet / rename-delete flows are browseable. Captures the
// wallet page (token-first list, cross-chain action, refresh-on-hero, aligned head)
// plus the wallet switcher with several wallets, in light + dark.
const CDP = "http://localhost:9222";
const APP = "http://localhost:1420/";
const OUT = "/tmp/ad-mw";

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

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 860, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: APP });
await sleep(900);
await evalJs(`localStorage.clear(); localStorage.setItem('autodesktop.lang','zh'); localStorage.setItem('autodesktop.theme','light')`);
await send("Page.reload");
await sleep(1500);

const setVal = `window.__set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};`;
await evalJs(setVal);
const setTheme = (th: string) =>
  evalJs(`localStorage.setItem('autodesktop.theme','${th}');document.documentElement.dataset.theme='${th}'`);

console.log("1) create first wallet via lock screen");
await evalJs(`document.querySelectorAll('.opt')[0].click()`); // create
await sleep(350);
await evalJs(`(()=>{const ins=[...document.querySelectorAll('.lock-input-wrap input')];window.__set(ins[0],'password123');window.__set(ins[1],'password123');})()`);
await sleep(150);
await evalJs(`[...document.querySelectorAll('.btn-aurora')].pop().click()`); // continue → backup
await sleep(400);
await evalJs(`document.querySelector('.reveal-mnemonic')?.click()`);
await sleep(150);
await evalJs(`document.querySelector('.lock-check input').click()`);
await sleep(120);
await evalJs(`[...document.querySelectorAll('.btn-aurora')].pop().click()`); // open wallet
await sleep(1500);

console.log("   on wallet:", await evalJs(`!!document.querySelector('.hero')`));
await sleep(1200); // balances + prices
await shot("01-wallet-light");

console.log("2) open the wallet switcher (1 wallet)");
await evalJs(`document.querySelector('.acct-pill').click()`);
await sleep(300);
await shot("02-switcher-1wallet");

console.log("3) open Add Wallet modal");
await evalJs(`document.querySelector('.acct-add-wallet').click()`);
await sleep(300);
await shot("03-addwallet-menu");

console.log("4) create a 2nd wallet (no password needed) → backup → done");
await evalJs(`document.querySelectorAll('.add-opt')[0].click()`); // create
await sleep(250);
await evalJs(`[...document.querySelectorAll('.add-acts .btn-aurora')].pop()?.click()`); // Create
await sleep(500);
await evalJs(`document.querySelector('.modal .reveal-mnemonic')?.click()`);
await sleep(150);
await evalJs(`document.querySelector('.modal .lock-check input')?.click()`);
await sleep(120);
await evalJs(`document.querySelector('.modal .btn-aurora.btn-block')?.click()`); // continue → onDone
await sleep(600);

console.log("5) reopen switcher (2 wallets) + add a watch account");
await evalJs(`document.querySelector('.acct-pill').click()`);
await sleep(300);
await shot("04-switcher-2wallets");

console.log("6) dark mode wallet + switcher");
await setTheme("dark");
await sleep(300);
await shot("05-switcher-2wallets-dark");
await evalJs(`document.body.click()`); // close menu
await sleep(200);
await shot("06-wallet-dark");

const errs = await evalJs(`(window.__errs||[]).slice(0,20)`);
console.log("done. console errors:", errs ?? "(none captured)");
ws.close();
