// Inspect DOM around the car listings to find container/class selectors for a filter.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const url = "https://autoplius.lt/skelbimai/naudoti-automobiliai";
const transport = new StdioClientTransport({ command: "bun", args: ["run", "bridge/index.ts"], cwd: ROOT, stderr: "inherit" });
const client = new Client({ name: "inspect", version: "0.0.0" });
await client.connect(transport);
const text = (r: any) => r.content?.map((c: any) => c.text).join("\n") ?? "";
const call = (n: string, a: Record<string, unknown> = {}) => client.callTool({ name: n, arguments: a });

const ff = Bun.spawn(["bunx", "web-ext", "run", "--source-dir", "extension", "--target", "firefox-desktop", "--url", url, "--no-reload"],
  { cwd: ROOT, stdout: "ignore", stderr: "ignore" });
for (let i = 0; i < 50; i++) { const r: any = await call("browser_snapshot", { interactiveOnly: true }); if (!r.isError) break; await Bun.sleep(500); }
await Bun.sleep(6000);

// find a listing link ref: name has a 4-digit year AND a € price
const snap = text(await call("browser_snapshot", { raw: true }));
const line = snap.split("\n").find((l: string) => /\[\d+\] link /.test(l) && /\b(19|20)\d\d-\d\d\b/.test(l) && /€/.test(l));
const ref = line ? Number(line.match(/\[(\d+)\]/)?.[1]) : undefined;
console.log("listing ref:", ref, "\nline:", line, "\n");

for (const up of [1, 2, 3, 4]) {
  const r = text(await call("browser_html", { ref, up, clean: true }));
  // just show the opening tags (first ~400 chars) to reveal classes/ids of ancestors
  console.log(`\n===== up:${up} (opening) =====`);
  console.log(r.slice(0, 500));
}

await client.close();
ff.kill();
process.exit(0);
