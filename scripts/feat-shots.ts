// Visual check of the new wallet features (token list / receive QR / add custom
// token) in debuggable Chrome (:9222) against the vite dev server (:1420), demo
// mode. Captures the wallet page, the receive sheet (QR), the add-token modal,
// a real on-chain scan of USDC, the custom token in the list, and dark mode.
const CDP = "http://localhost:9222";
const APP = "http://localhost:1420/";
const OUT = "/tmp/ad-feat";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // USDC on Ethereum

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
await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 920, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: APP });
await sleep(900);
await evalJs(`localStorage.clear(); localStorage.setItem('autodesktop.lang','zh'); localStorage.setItem('autodesktop.theme','light')`);
await send("Page.reload");
await sleep(1500);

await evalJs(`window.__set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};`);
const setTheme = (th: string) =>
  evalJs(`localStorage.setItem('autodesktop.theme','${th}');document.documentElement.dataset.theme='${th}'`);

console.log("1) create wallet via lock screen");
await evalJs(`document.querySelectorAll('.opt')[0].click()`);
await sleep(350);
await evalJs(`(()=>{const ins=[...document.querySelectorAll('.lock-input-wrap input')];window.__set(ins[0],'password123');window.__set(ins[1],'password123');})()`);
await sleep(150);
await evalJs(`[...document.querySelectorAll('.btn-aurora')].pop().click()`);
await sleep(400);
await evalJs(`document.querySelector('.reveal-mnemonic')?.click()`);
await sleep(150);
await evalJs(`document.querySelector('.lock-check input').click()`);
await sleep(120);
await evalJs(`[...document.querySelectorAll('.btn-aurora')].pop().click()`);
await sleep(1800);
console.log("   on wallet:", await evalJs(`!!document.querySelector('.hero')`));
await sleep(1200);
await shot("01-wallet");

console.log("2) receive sheet (QR)");
await evalJs(`[...document.querySelectorAll('.quick-btn')][0].click()`);
await sleep(450);
console.log("   qr present:", await evalJs(`!!document.querySelector('.receive-qr svg.qr path')`));
await shot("02-receive-qr");
await evalJs(`document.querySelector('.scrim')?.click()`);
await sleep(250);

console.log("3) add custom token modal");
await evalJs(`document.querySelector('.add-token').click()`);
await sleep(350);
await shot("03-addtoken");

console.log("4) scan USDC on Ethereum");
await evalJs(`(()=>{const i=document.querySelector('.scan-row input');window.__set(i,'${USDC}');})()`);
await sleep(150);
await evalJs(`[...document.querySelectorAll('.scan-row .btn')].pop().click()`);
await sleep(2500);
console.log("   scanned:", await evalJs(`document.querySelector('.scan-preview .scan-meta .l')?.textContent || '(none)'`));
await shot("04-scan-usdc");

console.log("5) add it → custom token in list");
await evalJs(`document.querySelector('.scan-preview .btn-aurora')?.click()`);
await sleep(500);
await shot("05-after-add");
await evalJs(`document.querySelector('.scrim')?.click()`);
await sleep(300);
const customRows = await evalJs(`[...document.querySelectorAll('.token-name')].filter(e=>e.textContent.includes('USDC')).length`);
console.log("   USDC rows in token list:", customRows);
await shot("06-list-with-custom");

console.log("6) dark mode");
await setTheme("dark");
await sleep(300);
await shot("07-dark");

const logs = await evalJs(`(window.__errs||[]).slice(0,20)`);
console.log("done. console errors:", logs ?? "(none captured)");
ws.close();
