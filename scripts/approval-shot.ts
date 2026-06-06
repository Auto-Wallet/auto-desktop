// One-off: screenshot the approval window UI in the browser by mocking Tauri's
// internal invoke bridge (so get_pending_requests returns a sample request).
// Verifies the light-theme re-skin of ApprovalView.css renders correctly.
// Requires the debuggable Chrome on :9222 and `bun run dev` on :1420.

const CDP = "http://localhost:9222";
const OUT = "/tmp/ad-shots";

const MOCK = `
  window.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => cb,
    invoke: (cmd) => {
      if (cmd === 'get_pending_requests') {
        return Promise.resolve([{
          id: 'demo-1',
          method: 'personal_sign',
          origin: 'https://app.uniswap.org',
          summary: 'Welcome to Uniswap!\\n\\nSign this message to verify ownership of your wallet. This request will not trigger a blockchain transaction or cost any gas.\\n\\nNonce: 8f3c2a91',
        }]);
      }
      return Promise.resolve(null);
    },
  };
`;

async function pickPageTarget(): Promise<string> {
  const list = (await (await fetch(`${CDP}/json`)).json()) as any[];
  const page = list.find((t) => t.type === "page") ;
  if (!page) throw new Error("no page target");
  return page.webSocketDebuggerUrl as string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ws = new WebSocket(await pickPageTarget());
  let id = 0;
  const pending = new Map<number, any>();
  await new Promise<void>((res) => (ws.onopen = () => res()));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data as string);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
    }
  };
  const send = (method: string, params: any = {}) =>
    new Promise<any>((resolve) => {
      const myId = ++id;
      pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });

  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK });
  await send("Page.navigate", { url: "http://localhost:1420/?view=approval" });
  await sleep(1500);
  const r = await send("Page.captureScreenshot", { format: "png" });
  await Bun.write(`${OUT}/approval.png`, Buffer.from(r.data, "base64"));
  console.log("  📸 approval.png");
  ws.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
