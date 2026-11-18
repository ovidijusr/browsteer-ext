import { readToken } from "./security";
// Tiny control client for the running hub — call any op from a shell without MCP.
//   bun run bridge/cli.ts <op> '<json params>' [--key bst-xxxx-yyyy] [--key bst-… (another browser)]
//   bun run bridge/cli.ts fetch '{"url":"https://…/forList?size=500","saveTo":"~/Downloads/forList.json"}' --key bst-dn5x-4ptm
// Prints the op's text result; exit code 1 on isError. Starts nothing — the hub must be up
// (any MCP call starts it, or `bun run bridge/hub.ts &`).
const PORT = Number(process.env.BRIDGE_PORT ?? 8787);
const [op, rawParams = "{}", ...rest] = process.argv.slice(2);
if (!op) { console.error("usage: cli.ts <op> '<json>' [--key bst-…]"); process.exit(2); }
// Several --key flags pair several browsers; the last is the default, and params can name another with "browser".
const keys = rest.flatMap((a, i) => (a === "--key" && rest[i + 1] ? [rest[i + 1]] : []));
const params = JSON.parse(rawParams);

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
let seq = 0;
const waits = new Map<string, (m: any) => void>();
function call(o: string, p: any): Promise<any> {
  const id = `${o}-${++seq}`;
  return new Promise((res) => { waits.set(id, res); ws.send(JSON.stringify({ id, op: o, params: p })); });
}
ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === "denied") { console.error(m.reason); process.exit(1); } waits.get(m.id)?.(m); waits.delete(m.id); };
ws.onerror = () => { console.error("hub not reachable on", PORT); process.exit(1); };
ws.onopen = async () => {
  ws.send(JSON.stringify({ type: "hello", role: "control", token: readToken() }));
  for (const key of keys) { const r = await call("pair", { key }); if (!r.ok) { console.error(r.text); process.exit(1); } }
  const r = await call(op, params);
  console.log(r.text);
  process.exit(r.ok ? 0 : 1);
};
