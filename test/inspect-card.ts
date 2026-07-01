import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const ROOT = new URL("..", import.meta.url).pathname;
const transport = new StdioClientTransport({ command: "bun", args: ["run", "bridge/index.ts"], cwd: ROOT, stderr: "inherit" });
const client = new Client({ name: "ic", version: "0.0.0" });
await client.connect(transport);
const text = (r: any) => r.content?.map((c: any) => c.text).join("\n") ?? "";
const call = (n: string, a: Record<string, unknown> = {}) => client.callTool({ name: n, arguments: a });
const ff = Bun.spawn(["bunx", "web-ext", "run", "--source-dir", "extension", "--target", "firefox-desktop", "--url", "https://autoplius.lt/skelbimai/naudoti-automobiliai", "--no-reload"], { cwd: ROOT, stdout: "ignore", stderr: "ignore" });
for (let i = 0; i < 50; i++) { const r: any = await call("browser_snapshot", { interactiveOnly: true, raw: true }); if (!r.isError) break; await Bun.sleep(500); }
await Bun.sleep(6000);
const snap = text(await call("browser_snapshot", { raw: true }));
const line = snap.split("\n").find((l: string) => /\[\d+\] link /.test(l) && /€/.test(l) && /(19|20)\d\d/.test(l));
const ref = Number(line.match(/\[(\d+)\]/)[1]);
const html = text(await call("browser_html", { ref, clean: true })); // the <a> card itself
await Bun.write("/tmp/autoplius-card.html", html);
console.log("card ref", ref, "→ /tmp/autoplius-card.html\n");
console.log(html.slice(0, 3000));
await client.close(); ff.kill(); process.exit(0);
