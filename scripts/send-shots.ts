// Visual check of the wallet's Send modal (#7): asset picker (held native/ERC-20),
// recipient, amount + Max, and submit. Demo mode (the Hardhat address has real
// mainnet dust, so it has sendable assets); walletSend is simulated in preview.
const CDP = "http://localhost:9222";
const APP = "http://localhost:1420/";
const OUT = "/tmp/ad-send";
const TO = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

async function pageWs() {
  const list = (await (await fetch(`${CDP}/json`)).json()) as any[];
  let p = list.find((t) => t.type === "page" && t.url.includes("localhost:1420")) ?? list.find((t) => t.type === "page");
  if (!p) { await fetch(`${CDP}/json/new?${APP}`, { method: "PUT" }); p = ((await (await fetch(`${CDP}/json`)).json()) as any[]).find((t) => t.type === "page"); }
  return p.webSocketDebuggerUrl as string;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(await pageWs());
let id = 0; const pending = new Map<number, any>();
await new Promise<void>((r) => (ws.onopen = () => r()));
ws.onmessage = (ev) => { const m = JSON.parse(ev.data as string); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method: string, params: any = {}) => new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (x: string) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("JS: " + JSON.stringify(r.exceptionDetails)); return r.result?.value; };
const shot = async (name: string) => { const r = await send("Page.captureScreenshot", { format: "png" }); await Bun.write(`${OUT}/${name}.png`, Buffer.from(r.data, "base64")); console.log(`  📸 ${name}.png`); };

await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: APP });
await sleep(900);
await evalJs(`localStorage.clear(); localStorage.setItem('autodesktop.lang','zh'); localStorage.setItem('autodesktop.theme','light')`);
await send("Page.reload");
await sleep(1500);
await evalJs(`window.__set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};`);

console.log("create wallet");
await evalJs(`document.querySelectorAll('.opt')[0].click()`); await sleep(350);
await evalJs(`(()=>{const ins=[...document.querySelectorAll('.lock-input-wrap input')];window.__set(ins[0],'password123');window.__set(ins[1],'password123');})()`); await sleep(150);
await evalJs(`[...document.querySelectorAll('.btn-aurora')].pop().click()`); await sleep(400);
await evalJs(`document.querySelector('.reveal-mnemonic')?.click()`); await sleep(150);
await evalJs(`document.querySelector('.lock-check input').click()`); await sleep(120);
await evalJs(`[...document.querySelectorAll('.btn-aurora')].pop().click()`); await sleep(1800);
await sleep(2000); // balances

console.log("open Send");
await evalJs(`[...document.querySelectorAll('.quick-btn')][1].click()`);
await sleep(500);
const assets = await evalJs(`[...document.querySelectorAll('.modal select option')].map(o=>o.textContent).slice(0,6)`);
console.log("   sendable assets:", JSON.stringify(assets));
await shot("01-send-open");

console.log("fill recipient + amount");
await evalJs(`(()=>{const i=document.querySelector('.modal input.mono');window.__set(i,'${TO}');})()`);
await sleep(120);
await evalJs(`[...document.querySelectorAll('.scan-row .btn')].pop().click()`); // Max
await sleep(150);
await shot("02-send-filled");
const amt = await evalJs(`[...document.querySelectorAll('.modal input.mono')].pop()?.value`);
console.log("   amount after Max:", amt);

console.log("submit (demo simulates)");
await evalJs(`[...document.querySelectorAll('.add-acts .btn-aurora')].pop().click()`);
await sleep(1100);
const toast = await evalJs(`document.querySelector('.toast, [class*="toast"]')?.textContent || '(modal closed)'`);
console.log("   result:", toast);
await shot("03-after-send");

console.log("dark");
await evalJs(`document.documentElement.dataset.theme='dark'`);
await sleep(200);
await evalJs(`[...document.querySelectorAll('.quick-btn')][1].click()`);
await sleep(400);
await shot("04-send-dark");

ws.close(); console.log("done.");
