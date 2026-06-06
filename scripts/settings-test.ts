// Drives the Settings page, language switch, and chain selector in the
// debuggable Chrome (:9222) against the dev server (:1420). Screenshots to
// /tmp/ad-shots. The native chainChanged push is verified separately in the app.
const CDP = "http://localhost:9222";
const APP = "http://localhost:1420/";
const OUT = "/tmp/ad-shots";

async function pageWs() {
  const list = (await (await fetch(`${CDP}/json`)).json()) as any[];
  const p = list.find((t) => t.type === "page" && t.url.includes("localhost:1420")) ?? list.find((t) => t.type === "page");
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

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: APP });
await sleep(800);
await evalJs("localStorage.clear()");
await send("Page.reload");
await sleep(1500);

console.log("1) open Settings");
await evalJs(`document.querySelector('.nav-item.settings').click()`);
await sleep(500);
await shot("settings-en");

console.log("2) switch active chain to Base");
await evalJs(`[...document.querySelectorAll('.chain-row')].find(r => r.textContent.includes('Base')).click()`);
await sleep(400);
await shot("settings-chain-base");

console.log("3) switch language to 中文");
await evalJs(`[...document.querySelectorAll('.lang-btn')].find(b => b.textContent.includes('中文')).click()`);
await sleep(400);
await shot("settings-zh");

console.log("4) Wallet page in 中文");
await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('钱包')).click()`);
await sleep(2500);
await shot("wallet-zh");

ws.close();
console.log("done.");
