// Bench runner: one control socket, a pinned tab, timed ops.
//   bun run test/bench-jev.ts --key bst-… --tab 1 '<json array of {op, params, label?}>'
// Prints per step: label, ms, bytes returned (≈tokens = bytes/4), first line(s) of the result.
const PORT = Number(process.env.BRIDGE_PORT ?? 8787);
const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const key = opt("--key"); const tab = opt("--tab"); const show = Number(opt("--show") ?? 6);
const steps: { op: string; params?: any; label?: string; sleep?: number }[] = JSON.parse(argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--key" && argv[i - 1] !== "--tab" && argv[i - 1] !== "--show")[0] ?? "[]");

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
let seq = 0; const waits = new Map<string, (m: any) => void>();
const call = (op: string, params: any = {}) => new Promise<any>((res) => { const id = `${op}-${++seq}`; waits.set(id, res); ws.send(JSON.stringify({ id, op, params })); });
ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); waits.get(m.id)?.(m); waits.delete(m.id); };
ws.onerror = () => { console.error("hub not reachable"); process.exit(1); };
ws.onopen = async () => {
  ws.send(JSON.stringify({ type: "hello", role: "control" }));
  if (key) { const r = await call("pair", { key }); if (!r.ok) { console.error(r.text); process.exit(1); } }
  if (tab) await call("pin", { tabId: Number(tab) });
  const rows: string[] = [];
  for (const s of steps) {
    const t0 = performance.now();
    const r = await call(s.op, s.params ?? {});
    const ms = Math.round(performance.now() - t0);
    const bytes = r.text.length;
    rows.push(`| ${s.label ?? s.op} | ${ms} ms | ${bytes} B (~${Math.round(bytes / 4)} tok) | ${r.ok ? "ok" : "ERR"} |`);
    console.log(`\n=== ${s.label ?? s.op}  ${ms} ms  ${bytes} bytes ${r.ok ? "" : "ERROR"}\n${r.text.split("\n").slice(0, show).join("\n")}${r.text.split("\n").length > show ? "\n  …" : ""}`);
    if (s.sleep) await Bun.sleep(s.sleep);
  }
  console.log("\n| step | wall time | payload to Claude | status |\n|---|---|---|---|\n" + rows.join("\n"));
  process.exit(0);
};
