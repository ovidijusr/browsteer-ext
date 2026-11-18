// Dump the full filtered snapshot (what the AI actually receives) to files.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const url = process.argv[2] ?? "https://autoplius.lt/skelbimai/naudoti-automobiliai";
const transport = new StdioClientTransport({ command: "bun", args: ["run", "bridge/index.ts"], cwd: ROOT, stderr: "inherit" });
const client = new Client({ name: "dump", version: "0.0.0" });
await client.connect(transport);
const text = (r: any) => r.content?.map((c: any) => c.text).join("\n") ?? "";
const call = (n: string, a: Record<string, unknown> = {}) => client.callTool({ name: n, arguments: a });

const ff = Bun.spawn(["bunx", "web-ext", "run", "--source-dir", "extension", "--target", "firefox-desktop", "--url", url, "--no-reload"],
  { cwd: ROOT, stdout: "ignore", stderr: "ignore" });
for (let i = 0; i < 50; i++) { const r: any = await call("browser_snapshot", { interactiveOnly: true }); if (!r.isError) break; await Bun.sleep(500); }
await Bun.sleep(6000);

const filtered = text(await call("browser_snapshot"));        // saved filter auto-applies
const raw = text(await call("browser_snapshot", { raw: true }));

await Bun.write("/tmp/autoplius-filtered.txt", filtered);
await Bun.write("/tmp/autoplius-raw.txt", raw);
console.log(`filtered → /tmp/autoplius-filtered.txt  (${filtered.length} B)`);
console.log(`raw      → /tmp/autoplius-raw.txt       (${raw.length} B)`);

await client.close();
ff.kill();
process.exit(0);
