// Drive autoplius's own search form: set a year range via browser_select, submit,
// read the auto-extracted results. Proves "use the UI as a CLI".
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const transport = new StdioClientTransport({ command: "bun", args: ["run", "bridge/index.ts"], cwd: ROOT, stderr: "inherit" });
const client = new Client({ name: "ff", version: "0.0.0" });
await client.connect(transport);
const text = (r: any) => r.content?.map((c: any) => c.text).join("\n") ?? "";
const call = (n: string, a: Record<string, unknown> = {}) => client.callTool({ name: n, arguments: a });
const ff = Bun.spawn(["bunx", "web-ext", "run", "--source-dir", "extension", "--target", "firefox-desktop", "--url", "https://autoplius.lt/skelbimai/naudoti-automobiliai", "--no-reload"], { cwd: ROOT, stdout: "ignore", stderr: "ignore" });
for (let i = 0; i < 50; i++) { const r: any = await call("browser_snapshot", { interactiveOnly: true, raw: true }); if (!r.isError) break; await Bun.sleep(500); }
await Bun.sleep(6000);

const snap = text(await call("browser_snapshot", { raw: true }));
const refOf = (re: RegExp) => { const l = snap.split("\n").find((x: string) => re.test(x)); return l ? Number(l.match(/\[(\d+)\]/)?.[1]) : undefined; };
const yearFrom = refOf(/combobox "make_date_from"/);
const yearTo = refOf(/combobox "make_date_to"/);
const search = refOf(/button .*Ieškoti/);
console.log(`refs → yearFrom=${yearFrom} yearTo=${yearTo} search=${search}`);

console.log(text(await call("browser_select", { ref: yearFrom, value: "2018" })));
console.log(text(await call("browser_select", { ref: yearTo, value: "2022" })));
console.log("→ clicking Search…");
console.log(text(await call("browser_click", { ref: search })));
await Bun.sleep(5000);

const res = text(await call("browser_snapshot"));
console.log("\n=== RESULTS after filtering 2018–2022 ===\n");
console.log(res);
await client.close(); ff.kill(); process.exit(0);
