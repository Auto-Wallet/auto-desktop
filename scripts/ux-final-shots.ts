// Final verification loop: wallet light/dark, token-row hover via REAL mouse,
// activity tab, defi section, explore light/dark, settings.
const CDP = `http://localhost:${process.env.CDP_PORT ?? 9333}`;
const APP = "http://localhost:1420/";
const OUT = "/tmp/ad-ux-final";

async function pageWs() {
  const list = (await (await fetch(`${CDP}/json`)).json()) as any[];
  let p =
    list.find((t) => t.type === "page" && t.url.includes("localhost:1420")) ??
    list.find((t) => t.type === "page");
  if (!p) {
    await fetch(`${CDP}/json/new?${APP}`, { method: "PUT" });
    p = ((await (await fetch(`${CDP}/json`)).json()) as any[]).find(
      (t) => t.type === "page",
    );
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
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails)
    throw new Error("JS: " + JSON.stringify(r.exceptionDetails));
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
  height: 860,
  deviceScaleFactor: 2,
  mobile: false,
});
await send("Page.navigate", { url: APP });
await sleep(900);
await evalJs(
  `localStorage.clear(); localStorage.setItem('autodesktop.lang','zh'); localStorage.setItem('autodesktop.theme','light')`,
);
await send("Page.reload");
await sleep(1500);

// unlock demo wallet
await evalJs(`(async () => {
  const set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
  const opt = [...document.querySelectorAll('.opt')][0];
  if (!opt) return;
  opt.click();
  await new Promise(r => setTimeout(r, 400));
  const ins = [...document.querySelectorAll('.lock-input-wrap input')];
  set(ins[0], 'password123'); set(ins[1], 'password123');
  await new Promise(r => setTimeout(r, 150));
  [...document.querySelectorAll('.btn-aurora')].pop().click();
  await new Promise(r => setTimeout(r, 500));
  document.querySelector('.reveal-mnemonic')?.click();
  await new Promise(r => setTimeout(r, 150));
  document.querySelector('.lock-check input')?.click();
  await new Promise(r => setTimeout(r, 120));
  [...document.querySelectorAll('.btn-aurora')].pop().click();
  await new Promise(r => setTimeout(r, 1800));
})()`);
await sleep(1500);
console.log("on wallet:", await evalJs(`!!document.querySelector('.hero')`));

// scroll token list into view, hover the 2nd token row with REAL mouse
await evalJs(`document.querySelector('.token-row:nth-child(2)')?.scrollIntoView({block:'center'})`);
await sleep(400);
const rect = await evalJs(`(()=>{const r=document.querySelector('.token-row:nth-child(2)').getBoundingClientRect(); return {x:r.left+360,y:r.top+r.height/2};})()`);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
await sleep(450);
await shot("01-row-hover-light");
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 40, y: 700 });
await sleep(250);

// defi section
await evalJs(`document.querySelector('.defi-section')?.scrollIntoView({block:'start'})`);
await sleep(500);
await shot("02-defi-light");

// activity tab
await evalJs(`[...document.querySelectorAll('.seg button')].find(b=>/活动|Activity/.test(b.textContent))?.click()`);
await sleep(700);
await shot("03-activity-light");
await evalJs(`[...document.querySelectorAll('.seg button')].find(b=>/代币|Tokens/.test(b.textContent))?.click()`);
await sleep(300);

// dark wallet
await evalJs(`localStorage.setItem('autodesktop.theme','dark');document.documentElement.dataset.theme='dark'`);
await sleep(350);
await evalJs(`window.scrollTo(0,0);document.querySelector('.page')?.scrollTo(0,0)`);
await sleep(200);
await shot("04-wallet-dark");
await evalJs(`document.querySelector('.token-row:nth-child(2)')?.scrollIntoView({block:'center'})`);
await sleep(300);
const rect2 = await evalJs(`(()=>{const r=document.querySelector('.token-row:nth-child(2)').getBoundingClientRect(); return {x:r.left+360,y:r.top+r.height/2};})()`);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect2.x, y: rect2.y });
await sleep(450);
await shot("05-row-hover-dark");
await evalJs(`localStorage.setItem('autodesktop.theme','light');document.documentElement.dataset.theme='light'`);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 40, y: 700 });

// explore dark
await evalJs(`localStorage.setItem('autodesktop.theme','dark');document.documentElement.dataset.theme='dark'`);
await evalJs(`[...document.querySelectorAll('.nav-item')].find(b=>/探索|Explore/.test(b.textContent))?.click()`);
await sleep(800);
await shot("06-explore-dark");
await evalJs(`localStorage.setItem('autodesktop.theme','light');document.documentElement.dataset.theme='light'`);

console.log("done");
ws.close();
