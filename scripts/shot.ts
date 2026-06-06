// Quick ad-hoc screenshot: bun run scripts/shot.ts <name> <waitMs> [navPath]
// Drives the debuggable Chrome on :9222, optionally navigates, waits, captures.
const CDP = "http://localhost:9222";
const [name = "shot", waitStr = "2000", path = ""] = Bun.argv.slice(2);

const list = (await (await fetch(`${CDP}/json`)).json()) as any[];
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map<number, any>();
await new Promise<void>((r) => (ws.onopen = () => r()));
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data as string);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
const send = (method: string, params: any = {}) =>
  new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await send("Page.enable");
if (path) {
  await send("Page.navigate", { url: `http://localhost:1420${path}` });
}
await new Promise((r) => setTimeout(r, Number(waitStr)));
const r = await send("Page.captureScreenshot", { format: "png" });
await Bun.write(`/tmp/ad-shots/${name}.png`, Buffer.from(r.data, "base64"));
console.log(`📸 ${name}.png`);
ws.close();
