// Visual check of the Aurora redesign in the debuggable Chrome (:9222) against
// the dev server (:1420). Demo mode (no Tauri) synthesizes the vault so the whole
// flow is browseable. Captures light + dark across the key surfaces.
const CDP = "http://localhost:9222";
const APP = "http://localhost:1420/";
const OUT = "/tmp/ad-redesign";

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
await send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 820,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.navigate", { url: APP });
await sleep(900);
await evalJs(`localStorage.clear(); localStorage.setItem('autodesktop.lang','en'); localStorage.setItem('autodesktop.theme','light')`);
await send("Page.reload");
await sleep(1500);

// React controlled-input setter.
const setValHelper = `
window.__set = (el, v) => {
  const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
  d.set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};`;
await evalJs(setValHelper);

const setTheme = (th: string) =>
  evalJs(`localStorage.setItem('autodesktop.theme','${th}'); document.documentElement.dataset.theme='${th}'`);

console.log("1) lock / chooser");
await shot("01-lock-light");
await setTheme("dark");
await sleep(400);
await shot("02-lock-dark");
await setTheme("light");
await sleep(300);

console.log("2) create demo wallet → backup → open");
await evalJs(`[...document.querySelectorAll('.opt')].find(b=>/Create a new wallet/.test(b.textContent)).click()`);
await sleep(400);
await evalJs(`(()=>{const ins=[...document.querySelectorAll('.lock-input-wrap input')]; window.__set(ins[0],'password123'); window.__set(ins[1],'password123');})()`);
await sleep(200);
await shot("03-create-light");
await evalJs(`[...document.querySelectorAll('.btn-aurora')].find(b=>/Continue/.test(b.textContent)).click()`);
await sleep(500);
await shot("04-backup-light");
await evalJs(`document.querySelector('.reveal-mnemonic')?.click()`);
await sleep(300);
await evalJs(`document.querySelector('.lock-check input').click()`);
await sleep(150);
await shot("05-backup-revealed");
await evalJs(`[...document.querySelectorAll('.btn-aurora')].find(b=>/Open wallet|Continue/.test(b.textContent)).click()`);
await sleep(1600);

console.log("3) wallet (real balances + live prices)");
const onWallet = await evalJs(`!!document.querySelector('.hero')`);
console.log("   on wallet:", onWallet);
await sleep(1400); // let balances + prices resolve
await shot("06-wallet-light");
await setTheme("dark");
await sleep(400);
await shot("07-wallet-dark");

console.log("4) account switcher open");
await evalJs(`document.querySelector('.acct-pill')?.click()`);
await sleep(300);
await shot("08-wallet-acctmenu-dark");
await evalJs(`document.querySelector('.acct-switch > div[style]')?.click?.()`);
await evalJs(`document.body.click()`);
await setTheme("light");
await sleep(300);

console.log("5) explore / dapps");
await evalJs(`[...document.querySelectorAll('.nav-item')].find(b=>/Explore/.test(b.textContent))?.click()`);
await sleep(700);
await shot("09-explore-light");
await setTheme("dark");
await sleep(350);
await shot("10-explore-dark");
await setTheme("light");
await sleep(250);

console.log("6) browser (open a dapp)");
await evalJs(`document.querySelector('.dapp-card')?.click()`);
await sleep(1200);
await shot("11-browser-light");

console.log("7) settings");
await evalJs(`[...document.querySelectorAll('.nav-item')].find(b=>/Settings/.test(b.textContent))?.click()`);
await sleep(600);
await shot("12-settings-light");
await setTheme("dark");
await sleep(350);
await shot("13-settings-dark");
await setTheme("light");

console.log("8) approval window (idle state)");
await send("Page.navigate", { url: APP + "?view=approval" });
await sleep(1000);
await shot("14-approval-idle");

// console errors
const errs = await evalJs(`(window.__errs||[]).slice(0,20)`);
console.log("done. console errors:", errs ?? "(none captured)");
ws.close();
