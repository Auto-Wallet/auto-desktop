// Visual check of the paginated Ledger picker (onboarding flow): 20 addresses
// per page, streamed in, with prev/next pagination. Demo mode (:1420 via :9222).
const CDP = "http://localhost:9222";
const APP = "http://localhost:1420/";
const OUT = "/tmp/ad-ledger";

async function pageWs() {
  const list = (await (await fetch(`${CDP}/json`)).json()) as any[];
  let p = list.find((t) => t.type === "page" && t.url.includes("localhost:1420")) ?? list.find((t) => t.type === "page");
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

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 940, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: APP });
await sleep(800);
await evalJs(`localStorage.clear(); localStorage.setItem('autodesktop.lang','zh'); localStorage.setItem('autodesktop.theme','light')`);
await send("Page.reload");
await sleep(1500);

console.log("1) choose Ledger");
await evalJs(`[...document.querySelectorAll('.opt')].find(o=>/Ledger/i.test(o.textContent))?.click()`);
await sleep(400);
await shot("01-ledger-intro");

console.log("2) scan → stream 20 addresses");
await evalJs(`[...document.querySelectorAll('.btn-aurora')].find(b=>!b.disabled)?.click()`);
await sleep(400);
await shot("02-streaming");
await sleep(1200);
const n1 = await evalJs(`document.querySelectorAll('.ledger-acct:not(.ledger-skel)').length`);
const range1 = await evalJs(`document.querySelector('.ledger-range')?.textContent`);
console.log("   page1 rows:", n1, "range:", range1);
await shot("03-page1-full");

console.log("3) next page");
await evalJs(`[...document.querySelectorAll('.ledger-pager .btn')].pop()?.click()`);
await sleep(1400);
const range2 = await evalJs(`document.querySelector('.ledger-range')?.textContent`);
const first2 = await evalJs(`document.querySelector('.ledger-idx')?.textContent`);
console.log("   page2 range:", range2, "first idx:", first2);
await shot("04-page2");

console.log("4) dark");
await evalJs(`document.documentElement.dataset.theme='dark'`);
await sleep(300);
await shot("05-dark");

console.log("done.");
ws.close();
