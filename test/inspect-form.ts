import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const transport = new StdioClientTransport({ command: "bun", args: ["run", "bridge/index.ts"], cwd: ROOT, stderr: "inherit" });
const client = new Client({ name: "if", version: "0.0.0" });
await client.connect(transport);
const text = (r: any) => r.content?.map((c: any) => c.text).join("\n") ?? "";
const call = (n: string, a: Record<string, unknown> = {}) => client.callTool({ name: n, arguments: a });
const ff = Bun.spawn(["bunx", "web-ext", "run", "--source-dir", "extension", "--target", "firefox-desktop", "--url", "https://autoplius.lt/skelbimai/naudoti-automobiliai", "--no-reload"], { cwd: ROOT, stdout: "ignore", stderr: "ignore" });
for (let i = 0; i < 50; i++) { const r: any = await call("browser_snapshot", { interactiveOnly: true, raw: true }); if (!r.isError) break; await Bun.sleep(500); }
await Bun.sleep(6000);

const snap = text(await call("browser_snapshot", { raw: true }));
// grab refs of the first few comboboxes and the text search box
const lines = snap.split("\n");
const comboRefs = lines.filter((l: string) => /\bcombobox\b/.test(l)).slice(0, 2).map((l: string) => Number(l.match(/\[(\d+)\]/)?.[1]));
const txtRef = Number(lines.find((l: string) => /textbox/.test(l))?.match(/\[(\d+)\]/)?.[1]);
console.log("combobox refs:", comboRefs, "textbox ref:", txtRef);

for (const ref of [...comboRefs, txtRef].filter(Boolean)) {
  const html = text(await call("browser_html", { ref, clean: true }));
  console.log(`\n===== ref ${ref} (first 600 chars) =====`);
  console.log(html.slice(0, 600));
}
await client.close(); ff.kill(); process.exit(0);
