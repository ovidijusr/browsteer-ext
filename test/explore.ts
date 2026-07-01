// Explore any real URL: launch a clean Firefox with the extension, navigate,
// and print the RAW snapshot + sizes so we can design a pruning filter.
//   bun run test/explore.ts "https://autoplius.lt/skelbimai/naudoti-automobiliai"
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = new URL("..", import.meta.url).pathname;
const url = process.argv[2] ?? "https://autoplius.lt/skelbimai/naudoti-automobiliai";

const transport = new StdioClientTransport({ command: "bun", args: ["run", "bridge/index.ts"], cwd: ROOT, stderr: "inherit" });
const client = new Client({ name: "explore", version: "0.0.0" });
await client.connect(transport);
const text = (r: any) => r.content?.map((c: any) => c.text).join("\n") ?? "";
const call = (n: string, a: Record<string, unknown> = {}) => client.callTool({ name: n, arguments: a });

const ff = Bun.spawn(
  ["bunx", "web-ext", "run", "--source-dir", "extension", "--target", "firefox-desktop", "--url", url, "--no-reload"],
  { cwd: ROOT, stdout: "ignore", stderr: "ignore" }
);

for (let i = 0; i < 50; i++) { const r: any = await call("browser_snapshot", { interactiveOnly: true }); if (!r.isError) break; await Bun.sleep(500); }
console.log("connected; letting the page settle…");
await Bun.sleep(6000);

const raw = text(await call("browser_snapshot", { raw: true }));
console.log(`\n=== RAW snapshot (${raw.length} bytes, ~${Math.round(raw.length / 4)} tokens) ===\n`);
console.log(raw);

await client.close();
ff.kill();
process.exit(0);
