// Drives the vault lock/setup/backup flow in the debuggable Chrome (:9222) against
// the dev server (:1420), screenshotting to /tmp/ad-shots. In the browser preview
// the vault runs in DEMO mode (in-memory, Anvil accounts) so the whole create →
// backup → wallet path is exercisable without the Tauri backend.
const CDP = "http://localhost:9222";
const APP = "http://localhost:1420/";
const OUT = "/tmp/ad-shots";

async function pageWs() {
  const list = (await (await fetch(`${CDP}/json`)).json()) as any[];
  const p =
    list.find((t) => t.type === "page" && t.url.includes("localhost:1420")) ??
    list.find((t) => t.type === "page");
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

// React-controlled inputs need the native value setter + an input event.
const SET_INPUT = `function setInput(el, val){const p=Object.getPrototypeOf(el);const s=Object.getOwnPropertyDescriptor(p,'value').set;s.call(el,val);el.dispatchEvent(new Event('input',{bubbles:true}));}`;

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: APP });
await sleep(800);
await evalJs("localStorage.clear()");
await send("Page.reload");
await sleep(1200);

console.log("1) lock screen — choose");
await shot("lock-1-choose");

console.log("2) create form");
await evalJs(`[...document.querySelectorAll('.lock-primary')].find(b=>/Create/i.test(b.textContent)).click()`);
await sleep(300);
await shot("lock-2-create");

console.log("3) fill password + confirm, submit");
await evalJs(`${SET_INPUT}
  const ins=[...document.querySelectorAll('.lock-input')];
  setInput(ins[0],'hunter2pw'); setInput(ins[1],'hunter2pw');`);
await sleep(200);
await evalJs(`[...document.querySelectorAll('.lock-primary')].find(b=>/Create/i.test(b.textContent)).click()`);
await sleep(500);
await shot("lock-3-backup");

console.log("4) ack + continue → wallet");
await evalJs(`document.querySelector('.lock-check input').click()`);
await sleep(150);
await evalJs(`[...document.querySelectorAll('.lock-primary')].find(b=>/Continue/i.test(b.textContent)).click()`);
await sleep(2500);
await shot("lock-4-wallet");

console.log("5) open account menu (HD add + lock visible)");
await evalJs(`document.querySelector('.acct').click()`);
await sleep(300);
await shot("lock-5-acctmenu");

ws.close();
console.log("done.");
