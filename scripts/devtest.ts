// Dependency-free visual E2E driver. Connects to a Chrome already running with
// --remote-debugging-port=9222 (see the launch command in the session), drives
// the shell UI over the DevTools Protocol, and writes screenshots to
// /tmp/ad-shots so the agent can actually LOOK at the rendered product.
//
// Run:  bun run scripts/devtest.ts
// (Requires: `bun run dev` serving :1420, and a debuggable Chrome on :9222.)

const CDP = "http://localhost:9222";
const APP = "http://localhost:1420/";
const OUT = "/tmp/ad-shots";

// A funded mainnet address (vitalik.eth) — used to verify non-zero balances and
// the add-watch-address flow render correctly. Watch-only; no keys involved.
const FUNDED = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

type Pending = { resolve: (v: any) => void; reject: (e: any) => void };

async function pickPageTarget(): Promise<string> {
  const list = (await (await fetch(`${CDP}/json`)).json()) as any[];
  const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"))
    ?? list.find((t) => t.type === "page");
  if (!page) throw new Error("no page target on :9222");
  return page.webSocketDebuggerUrl as string;
}

function connect(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map<number, Pending>();
  const ready = new Promise<void>((res) => (ws.onopen = () => res()));

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  };

  function send(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  }

  return { ready, send, close: () => ws.close() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const client = connect(await pickPageTarget());
  await client.ready;
  await client.send("Page.enable");
  await client.send("Runtime.enable");

  const evalJs = async (expression: string) => {
    const r = await client.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error("JS: " + JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };

  const shot = async (name: string) => {
    const r = await client.send("Page.captureScreenshot", { format: "png" });
    await Bun.write(`${OUT}/${name}.png`, Buffer.from(r.data, "base64"));
    console.log(`  📸 ${name}.png`);
  };

  const gotoFresh = async () => {
    await client.send("Page.navigate", { url: APP });
    await sleep(800);
    await evalJs("localStorage.clear()");
    await client.send("Page.reload");
    await sleep(1200);
  };

  // 1) Baseline — default (signer) account, balances loaded.
  console.log("1) baseline");
  await gotoFresh();
  await sleep(3500);
  await shot("01-baseline");

  // 2) Open the account switcher dropdown.
  console.log("2) open account menu");
  await evalJs(`document.querySelector('.acct').click()`);
  await sleep(400);
  await shot("02-menu-open");

  // 3) Reveal the add-address input.
  console.log("3) add-address input");
  await evalJs(`document.querySelector('.acct-menu-add').click()`);
  await sleep(300);
  await shot("03-add-input");

  // 4) Type an invalid address and submit -> expect inline error (no silent skip).
  console.log("4) invalid address -> error");
  await evalJs(`
    (() => {
      const el = document.querySelector('.add-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, 'not-an-address');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.add-go').click();
    })()
  `);
  await sleep(400);
  await shot("04-invalid-error");

  // 5) Replace with a funded address and submit -> switches to it, loads balances.
  console.log("5) funded watch address -> non-zero balances");
  await evalJs(`
    (() => {
      const el = document.querySelector('.add-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, '${FUNDED}');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.add-go').click();
    })()
  `);
  await sleep(4500);
  await shot("05-funded-balances");

  // 6) Re-open menu to confirm both accounts are listed.
  console.log("6) menu with two accounts");
  await evalJs(`document.querySelector('.acct').click()`);
  await sleep(400);
  await shot("06-two-accounts");

  // 7) Go to the dApps page (seeded cards, Uniswap pinned).
  console.log("7) dApps grid");
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('dApps')).click()`);
  await sleep(3500); // let the favicon <img>s load
  await shot("07-dapps-grid");

  // 8) Search filter.
  console.log("8) dApps search");
  await evalJs(`
    (() => {
      const el = document.querySelector('.search');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, 'aave');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(400);
  await shot("08-dapps-search");

  // 9) Clear search, open a dApp -> embedded browser chrome.
  console.log("9) open dApp -> browser view");
  await evalJs(`
    (() => {
      const el = document.querySelector('.search');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(300);
  await evalJs(`document.querySelector('.dapp-card').click()`);
  await sleep(2500);
  await shot("09-browser-view");

  client.close();
  console.log("done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
