// Visual check of the approval window's transaction details + editable max fee.
// The window only renders under Tauri, so we inject a fake __TAURI_INTERNALS__
// (with one pending eth_sendTransaction) before the app boots, then screenshot
// ?view=approval. Also captures the wei-hex override the UI computes on approve.
const CDP = "http://localhost:9222";
const APP = "http://localhost:1420/?view=approval";
const OUT = "/tmp/ad-approval";

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

const mock = `
window.localStorage.setItem('autodesktop.lang','zh');
window.localStorage.setItem('autodesktop.theme','light');
const REQ = {
  id: "req-1", method: "eth_sendTransaction", origin: "https://xflows.wanchain.org",
  summary: "Contract interaction",
  tx: { chain_id:"0x1", chain_name:"Ethereum", symbol:"ETH",
    from:"0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    to:"0xBc2e4878fc9aD7Db2f207E0cd1E7f1d4D08c75aa",
    value:"0x2386f26fc10000", data:"0x", gas:"0x5208", nonce:"0x3",
    max_priority_fee_per_gas:"0x3b9aca00", max_fee_per_gas:"0x77359400" } };
window.__approveArgs = null;
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow:{label:'approval'}, currentWebview:{label:'approval'} },
  transformCallback: (cb)=>cb,
  invoke: async (cmd, args) => {
    if (cmd === 'plugin:event|listen') return 0;
    if (cmd === 'get_pending_requests') return window.__cleared ? [] : [REQ];
    if (cmd === 'vault_status') return { address: REQ.tx.from, kind: 'hd' };
    if (cmd === 'approve_request') { window.__approveArgs = args; window.__cleared = true; return null; }
    if (cmd === 'reject_request') { window.__cleared = true; return null; }
    return null;
  }
};
`;

await send("Page.enable");
await send("Runtime.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: mock });
await send("Emulation.setDeviceMetricsOverride", { width: 440, height: 640, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: APP });
await sleep(1600);

console.log("1) tx approval details (light)");
const title = await evalJs(`document.querySelector('.apv-kind h2')?.textContent`);
const rows = await evalJs(`[...document.querySelectorAll('.apv-row')].map(r=>r.textContent).join(' | ')`);
const fee = await evalJs(`document.querySelector('.apv-fee-input input')?.value`);
console.log("   title:", title, "| fee(Gwei):", fee);
console.log("   rows:", rows);
await shot("01-tx-light");

console.log("2) edit max fee → 3.5 Gwei, then approve (capture override)");
await evalJs(`(()=>{const i=document.querySelector('.apv-fee-input input');const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i),'value');d.set.call(i,'3.5');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
await sleep(200);
await shot("02-edited-fee");
await evalJs(`[...document.querySelectorAll('.approval-foot button')].pop().click()`);
await sleep(400);
const override = await evalJs(`JSON.stringify(window.__approveArgs)`);
console.log("   approve override sent:", override, " (3.5 Gwei == 0xd09dc300 wei)");

console.log("3) dark mode");
await evalJs(`window.__cleared=false`);
await send("Page.navigate", { url: APP });
await sleep(1500);
await evalJs(`document.documentElement.dataset.theme='dark'`);
await sleep(300);
await shot("03-tx-dark");

ws.close();
console.log("done.");
