// Verifies the Settings → Network CRUD UI in the debuggable Chrome (:9222) against
// the dev server (:1420). In the browser preview the chain store runs in-memory
// (BUILTIN_CHAINS + add/edit/remove), so the whole add-network flow is exercisable.
const CDP = "http://localhost:9222";
const APP = "http://localhost:1420/";
const OUT = "/tmp/ad-shots";

async function pageWs() {
  const list = (await (await fetch(`${CDP}/json`)).json()) as any[];
  let p = list.find((t) => t.type === "page" && t.url.includes("localhost:1420")) ?? list.find((t) => t.type === "page");
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
ws.onmessage = (ev) => { const m = JSON.parse(ev.data as string); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method: string, params: any = {}) => new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expression: string) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("JS: " + JSON.stringify(r.exceptionDetails)); return r.result?.value; };
const shot = async (name: string) => { const r = await send("Page.captureScreenshot", { format: "png" }); await Bun.write(`${OUT}/${name}.png`, Buffer.from(r.data, "base64")); console.log(`  📸 ${name}.png`); };
const SET = `function setInput(el,val){const p=Object.getPrototypeOf(el);const s=Object.getOwnPropertyDescriptor(p,'value').set;s.call(el,val);el.dispatchEvent(new Event('input',{bubbles:true}));}`;

await send("Page.enable"); await send("Runtime.enable");
await send("Page.navigate", { url: APP });
await sleep(900);
await evalJs(`localStorage.clear(); localStorage.setItem('autodesktop.lang','zh')`);
await send("Page.reload");
await sleep(1400);

console.log("1) create demo wallet to get past the lock screen");
await evalJs(`[...document.querySelectorAll('.lock-primary')].find(b=>/创建/.test(b.textContent)).click()`);
await sleep(300);
await evalJs(`${SET} const i=[...document.querySelectorAll('.lock-input')]; setInput(i[0],'verifypass123'); setInput(i[1],'verifypass123');`);
await sleep(200);
await evalJs(`[...document.querySelectorAll('.lock-primary')].find(b=>/创建/.test(b.textContent)).click()`);
await sleep(500);
await evalJs(`document.querySelector('.lock-check input').click()`);
await sleep(150);
await evalJs(`[...document.querySelectorAll('.lock-primary')].find(b=>/继续/.test(b.textContent)).click()`);
await sleep(800);

console.log("2) open Settings (设置)");
await evalJs(`document.querySelector('.nav-item.settings').click()`);
await sleep(500);
await shot("net-1-settings");

console.log("3) open Add network form");
await evalJs(`document.querySelector('.add-network-btn').click()`);
await sleep(300);
await evalJs(`${SET}
  const f=document.querySelector('.net-form');
  const ins=f.querySelectorAll('input');
  // name, chainId, symbol, rpc, decimals (color input is index 0)
  const byPlace=(p)=>[...ins].find(i=>i.placeholder&&i.placeholder.includes(p));
  setInput(byPlace('My Network'),'My Testnet');
  setInput(byPlace('0x'),'0x539');
  setInput(byPlace('ETH'),'TST');
  setInput(byPlace('https'),'https://rpc.testnet.example.com');`);
await sleep(250);
await shot("net-2-addform");

console.log("4) save → new network appears in the list");
await evalJs(`document.querySelector('.net-save').click()`);
await sleep(500);
await shot("net-3-added");

ws.close();
console.log("done.");
