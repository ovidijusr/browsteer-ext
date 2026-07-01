// Verify the hub/shim split: spawn the shim (as Claude would), it should lazily
// start the hub and forward a DB-only tool (no browser needed).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const ROOT = new URL("..", import.meta.url).pathname;
const t = new StdioClientTransport({ command: "bun", args: ["run", "bridge/mcp.ts"], cwd: ROOT, stderr: "inherit" });
const c = new Client({ name: "verify", version: "0" });
await c.connect(t);
console.log("tools:", (await c.listTools()).tools.map((x) => x.name).join(", "));
const r: any = await c.callTool({ name: "browser_list_filters", arguments: {} });
console.log("\nlist_filters →\n" + r.content.map((x: any) => x.text).join("\n"));
await c.close();
process.exit(0);
