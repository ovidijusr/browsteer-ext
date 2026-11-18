// E2E for Phase 2 pruning filters. Spawns the bridge, launches Firefox on the
// fixture, then: raw snapshot → save_filter → filtered snapshot → assertions.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const transport = new StdioClientTransport({ command: "bun", args: ["run", "bridge/index.ts"], cwd: ROOT, stderr: "inherit" });
const client = new Client({ name: "scan-test", version: "0.0.0" });
await client.connect(transport);

const text = (r: any) => r.content?.map((c: any) => c.text).join("\n") ?? "";
const call = (n: string, a: Record<string, unknown> = {}) => client.callTool({ name: n, arguments: a });

const ff = Bun.spawn(
  ["bunx", "web-ext", "run", "--source-dir", "extension", "--target", "firefox-desktop",
   "--url", "http://127.0.0.1:8080", "--no-reload"],
  { cwd: ROOT, stdout: "ignore", stderr: "ignore" }
);

for (let i = 0; i < 40; i++) { const r: any = await call("browser_snapshot", { interactiveOnly: true }); if (!r.isError) break; await Bun.sleep(500); }

const assert = (cond: boolean, msg: string) => console.log(`${cond ? "✓" : "✗ FAIL"}  ${msg}`);

console.log("\n=== 1. raw snapshot (no filter) ===");
const raw = text(await call("browser_snapshot", { raw: true }));
console.log(`raw bytes: ${raw.length}`);
assert(/About Us/.test(raw), "raw includes footer nav ('About Us')");
assert(/FlyCheap Operating Company/.test(raw), "raw includes legal text");

console.log("\n=== 2. save_filter ===");
console.log(text(await call("browser_save_filter", {
  name: "flycheap-results",
  match: "127.0.0.1:8080*",
  root: "main",
  drop: ["footer", "nav[aria-label='Primary']"],
  dropText: ["©", "Terms of Use", "Fares are subject"],
})));

console.log("\n=== 3. filtered snapshot (auto-applied) ===");
const filteredResp: any = await call("browser_snapshot");
const filtered = text(filteredResp);
console.log(filtered);
const body = filtered.split("\n\n").slice(1).join("\n\n");
assert(/Filter: flycheap-results/.test(filtered), "header reports applied filter");
assert(!/About Us/.test(filtered), "footer nav removed");
assert(!/FlyCheap Operating Company/.test(filtered), "legal text removed");
assert(!/link "Home"/.test(filtered), "primary nav removed (root=main)");
assert(/€78/.test(filtered) && /button "Search"/.test(filtered), "results + search kept");
assert(body.length < raw.length, `filtered (${body.length}B) smaller than raw (${raw.length}B)`);

console.log("\n=== 4. raw bypass still returns full page ===");
const raw2 = text(await call("browser_snapshot", { raw: true }));
assert(/About Us/.test(raw2), "raw:true bypasses the filter");

console.log("\n=== 5. re-save (update) takes effect ===");
await call("browser_save_filter", { name: "flycheap-results", match: "127.0.0.1:8080*", root: "main", drop: [] });
const reapplied = text(await call("browser_snapshot"));
assert(/link "Home"/.test(reapplied) === false, "root=main still excludes primary nav after update");
assert(/€78/.test(reapplied), "results still present after update");
console.log("\n=== list ===");
console.log(text(await call("browser_list_filters")));

await client.close();
ff.kill();
process.exit(0);
