// Measure, on your CURRENT active tab: compact snapshot vs interactiveOnly vs
// the real rendered DOM (raw and cleaned). Apples-to-apples, same page.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const transport = new StdioClientTransport({ command: "bun", args: ["run", "bridge/index.ts"], cwd: ROOT, stderr: "ignore" });
const client = new Client({ name: "measure", version: "0.0.0" });
await client.connect(transport);
const text = (r: any) => r.content?.map((c: any) => c.text).join("\n") ?? "";
const call = (n: string, a: Record<string, unknown> = {}) => client.callTool({ name: n, arguments: a });

for (let i = 0; i < 60; i++) { const r: any = await call("browser_snapshot", { interactiveOnly: true }); if (!r.isError) break; await Bun.sleep(500); }

const tok = (b: number) => Math.round(b / 4);
const full = text(await call("browser_snapshot"));
const io = text(await call("browser_snapshot", { interactiveOnly: true }));
const htmlClean = text(await call("browser_html", { clean: true }));   // whole page, scripts/styles stripped
const htmlRaw = text(await call("browser_html", { clean: false }));    // whole page, as-is
const bytesOf = (label: string, s: string, fromHeader = false) => {
  const b = fromHeader ? Number(s.match(/bytes:\s*(\d+)/)?.[1] ?? 0) : s.length;
  return { label, b };
};
const rows = [
  bytesOf("snapshot (compact)", full),
  bytesOf("snapshot (interactiveOnly)", io),
  bytesOf("rendered HTML (cleaned)", htmlClean, true),
  bytesOf("rendered HTML (raw)", htmlRaw, true),
];
const base = rows[2].b || 1;
console.log("\nURL:", full.split("\n")[0]);
console.log("\n" + "lens".padEnd(28) + "bytes".padStart(10) + "~tokens".padStart(10) + "   vs cleaned HTML");
for (const r of rows) {
  console.log(r.label.padEnd(28) + String(r.b).padStart(10) + String(tok(r.b)).padStart(10) +
    "   " + (r.b ? (r.b / base * 100).toFixed(1) + "%" : "-"));
}
console.log(`\nCompact snapshot is ~${(base / (rows[0].b || 1)).toFixed(0)}x smaller than the cleaned DOM.`);
await client.close();
process.exit(0);
