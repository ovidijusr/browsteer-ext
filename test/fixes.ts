// Verify the 3 fixes: browser_tabs, browser_pin, browser_html truncation, browser_press.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const transport = new StdioClientTransport({ command: "bun", args: ["run", "bridge/index.ts"], cwd: ROOT, stderr: "inherit" });
const client = new Client({ name: "fx", version: "0" });
await client.connect(transport);
const text = (r: any) => r.content?.map((c: any) => c.text).join("\n") ?? "";
const call = (n: string, a: Record<string, unknown> = {}) => client.callTool({ name: n, arguments: a });
const ff = Bun.spawn(["bunx", "web-ext", "run", "--source-dir", "extension", "--target", "firefox-desktop", "--url", "https://autoplius.lt/skelbimai/naudoti-automobiliai", "--no-reload"], { cwd: ROOT, stdout: "ignore", stderr: "ignore" });
for (let i = 0; i < 50; i++) { const r: any = await call("browser_snapshot", { interactiveOnly: true, raw: true }); if (!r.isError) break; await Bun.sleep(500); }
await Bun.sleep(6000);

console.log("=== browser_tabs ===");
const tabs = text(await call("browser_tabs"));
console.log(tabs);
const tabId = Number(tabs.match(/\[(\d+)\]/)?.[1]);

console.log("\n=== browser_pin ===");
console.log(text(await call("browser_pin", { tabId })));

console.log("\n=== browser_html maxBytes:3000 (expect ⚠ TRUNCATED) ===");
console.log(text(await call("browser_html", { maxBytes: 3000 })).split("\n").slice(0, 3).join("\n"));

console.log("\n=== fill text search 'Audi' + press Enter ===");
const snap = text(await call("browser_snapshot", { raw: true }));
const txtRef = Number(snap.split("\n").find((l: string) => /textbox/.test(l))?.match(/\[(\d+)\]/)?.[1]);
console.log("textbox ref:", txtRef);
if (txtRef) {
  console.log(text(await call("browser_fill", { ref: txtRef, value: "Audi" })));
  console.log(text(await call("browser_press", { key: "Enter", ref: txtRef })));
  await Bun.sleep(4000);
  const res = text(await call("browser_snapshot"));
  console.log(res.split("\n").slice(0, 6).join("\n"));
}
await client.close(); ff.kill(); process.exit(0);
