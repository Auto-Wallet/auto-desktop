// Visual check of the approval window: dense layout, decoded ERC-20 approve
// editor, the wrong-network token error, and the collapsed fee editor.
// The window only renders under Tauri, so we inject a fake __TAURI_INTERNALS__
// (scenario picked via location.hash) before the app boots, then screenshot
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

// Scenario is read from location.hash so one injected mock serves all cases:
//   #approve-ok         decoded ERC-20 approve, token metadata resolves (USDT, 6dp)
//   #approve-wrongchain same approve but every eth_call returns "0x" (token not
//                       on the selected chain) → must show the clear error
//   (default)           plain native send
const mock = `
window.localStorage.setItem('autodesktop.lang','zh');
window.localStorage.setItem('autodesktop.theme','light');
const scenario = location.hash.replace('#','') || 'send';
const SPENDER = '0x2c2dffc7ba90bc2bb2b95e4eb84b3ac1fd3bc07f';
const TOKEN = '0xE3aE74D1518A76715aB4C7BeDF1af73893cd435A';
const pad = (h) => h.replace(/^0x/,'').toLowerCase().padStart(64,'0');
const approveData = '0x095ea7b3' + pad(SPENDER) + pad('0x3b9aca00'); // 1000 USDT @6dp
const fees = { max_priority_fee_per_gas:'0x0', max_fee_per_gas:'0x2625a00' }; // 0.04 Gwei (Arbitrum-real)
const base = { id:'req-1', origin:'https://xstake.wanchain.org', summary:'Contract interaction' };
const REQ =
  scenario === 'approve-ok'
    ? { ...base, method:'eth_sendTransaction',
        tx:{ chain_id:'0xa4b1', chain_name:'Arbitrum One', symbol:'ETH',
          from:'0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', to:TOKEN,
          value:'0x0', data:approveData, gas:'0x69a0', nonce:'0x3f3', ...fees } }
  : scenario === 'approve-wrongchain'
    ? { ...base, method:'eth_sendTransaction',
        tx:{ chain_id:'0x1', chain_name:'Ethereum', symbol:'ETH',
          from:'0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', to:TOKEN,
          value:'0x0', data:approveData, gas:'0x69a0', nonce:'0x3f3', ...fees } }
    : { ...base, method:'eth_sendTransaction',
        tx:{ chain_id:'0x1', chain_name:'Ethereum', symbol:'ETH',
          from:'0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
          to:'0xBc2e4878fc9aD7Db2f207E0cd1E7f1d4D08c75aa',
          value:'0x2386f26fc10000', data:'0x', gas:'0x5208', nonce:'0x3',
          max_priority_fee_per_gas:'0x3b9aca00', max_fee_per_gas:'0x77359400' } };
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
    if (cmd === 'simulate_tx') return { ok:true, status:200, data:{ success:true, balance_changes: scenario==='send' ? [{ address:REQ.tx.from, native_delta:'-10000000000000000', token_deltas:[] }] : [] } };
    if (cmd === 'node_rpc') {
      if (scenario === 'approve-wrongchain') return '0x'; // no contract on this chain
      const data = (args.params?.[0]?.data) || '';
      if (data.startsWith('0x95d89b41')) return '0x' + pad('0x20') + pad('0x4') + '55534454'.padEnd(64,'0'); // "USDT"
      if (data.startsWith('0x313ce567')) return '0x' + pad('0x6');
      if (data.startsWith('0x70a08231')) return '0x' + BigInt('2500500000').toString(16).padStart(64,'0'); // 2500.5 USDT
      return '0x';
    }
    return null;
  }
};
`;

await send("Page.enable");
await send("Runtime.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: mock });
// The approval window's real size (open_approval_window: 420×640) — density
// must be judged at the size users actually get.
await send("Emulation.setDeviceMetricsOverride", { width: 420, height: 640, deviceScaleFactor: 1, mobile: false });

const goto = async (hash: string) => {
  // Bounce through about:blank: hash-only changes are same-document navigations,
  // which would keep the previous scenario's injected mock alive.
  await send("Page.navigate", { url: "about:blank" });
  await sleep(200);
  await send("Page.navigate", { url: `${APP}${hash}` });
  await sleep(1600);
};

console.log("1) ERC-20 approve, token metadata loaded (the dense first page)");
await goto("#approve-ok");
console.log("   title:", await evalJs(`document.querySelector('.apv-top h2')?.textContent`));
console.log("   chips:", await evalJs(`[...document.querySelectorAll('.apv-chip')].map(c=>c.textContent.trim()).join(' | ')`));
console.log("   amount input:", await evalJs(`document.querySelector('.apv-approve-field input')?.value`));
console.log("   balance line:", await evalJs(`document.querySelector('.apv-approve-meta span')?.textContent`));
console.log("   fee row:", await evalJs(`document.querySelector('.apv-fee-sum')?.textContent`));
console.log("   tags:", await evalJs(`[...document.querySelectorAll('.apv-tag')].map(c=>c.textContent.trim()).join(' | ')`));
console.log("   scrollable overflow px:", await evalJs(`(()=>{const b=document.querySelector('.approval-body');return b.scrollHeight-b.clientHeight})()`));
await shot("01-approve-ok");

console.log("2) same approve but token absent on the chain → clear error");
await goto("#approve-wrongchain");
console.log("   error:", await evalJs(`document.querySelector('.apv-approve-error')?.textContent`));
console.log("   balance line:", await evalJs(`document.querySelector('.apv-approve-meta span')?.textContent`));
console.log("   scrollable overflow px:", await evalJs(`(()=>{const b=document.querySelector('.approval-body');return b.scrollHeight-b.clientHeight})()`));
await shot("02-approve-wrongchain");

console.log("3) plain send; expand fee editor, set 3.5 Gwei, approve (capture override)");
await goto("");
await shot("03-send");
await evalJs(`document.querySelector('.apv-fee-toggle').click()`);
await sleep(200);
await evalJs(`(()=>{const i=document.querySelectorAll('.apv-fee input')[1];const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i),'value');d.set.call(i,'3.5');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
await sleep(200);
await shot("04-send-fee-edit");
await evalJs(`[...document.querySelectorAll('.approval-foot button')].pop().click()`);
await sleep(400);
console.log("   approve override sent:", await evalJs(`JSON.stringify(window.__approveArgs)`), " (3.5 Gwei == 0xd09dc300 wei)");

console.log("4) approve-ok in dark mode");
await goto("#approve-ok");
await evalJs(`document.documentElement.dataset.theme='dark'`);
await sleep(300);
await shot("05-approve-dark");

ws.close();
console.log("done.");
