// Self-contained end-to-end test.
//   1. spawn the real bridge over stdio (as Claude Code would)
//   2. THEN launch Firefox via web-ext (so the extension's first WS attempt
//      finds the bridge already listening)
//   3. discover the browser's pairing key, browser_pair, then drive the page
//
//   this client ──stdio/MCP──▶ bridge ──ws──▶ extension ──▶ fixture page
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = new URL("..", import.meta.url).pathname;

// 1. Bridge first.
const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", "bridge/index.ts"],
  cwd: ROOT,
  stderr: "inherit",
});
const client = new Client({ name: "e2e-test", version: "0.0.0" });
await client.connect(transport);

const text = (r: any) => r.content?.map((c: any) => c.text).join("\n") ?? "";
const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args });

console.log("\n=== tools ===");
console.log((await client.listTools()).tools.map((t) => t.name).join(", "));

// 2. Now launch Firefox with the extension on the fixture page.
console.log("\n=== launching Firefox (web-ext) ===");
const ff = Bun.spawn(
  ["bunx", "web-ext", "run", "--source-dir", "extension",
   "--target", "firefox-desktop", "--url", "http://127.0.0.1:8080", "--no-reload"],
  { cwd: ROOT, stdout: "ignore", stderr: "ignore" }
);

// 3. The bridge logs "browser registered: <key>" to its stderr (inherited above).
//    We just retry browser_pair against whatever connected. Discover the key by
//    pairing optimistically: with one browser, snapshot works without an explicit
//    key, but we still exercise pairing once we learn the key from the registry.
async function waitForBrowser(tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const r: any = await call("browser_snapshot");
    if (!r.isError) return;
    await Bun.sleep(500);
  }
  throw new Error("extension never connected");
}

console.log("\n=== waiting for the browser to connect ===");
await waitForBrowser();

console.log("\n=== browser_snapshot (compact) ===");
const snap: any = await call("browser_snapshot");
const compact = text(snap);
console.log(compact);
console.log(`\n[compact snapshot = ${compact.length} bytes]`);

console.log("\n=== browser_snapshot interactiveOnly ===");
const io: any = await call("browser_snapshot", { interactiveOnly: true });
const ioText = text(io);
console.log(ioText);
console.log(`\n[interactiveOnly = ${ioText.length} bytes]`);

const tree = text(snap);
const findRef = (re: RegExp) => {
  const line = tree.split("\n").find((l: string) => re.test(l));
  return line ? Number(line.match(/\[(\d+)\]/)?.[1]) : undefined;
};
const destRef = findRef(/searchbox/i);
const searchRef = findRef(/button "Search"/);
const selectRef = findRef(/button "Select/);
console.log(`\ndestRef=${destRef}  searchRef=${searchRef}  selectRef=${selectRef}`);

if (selectRef) {
  console.log(`\n=== browser_html: climb up:2 from Select button [${selectRef}] → its result card ===`);
  console.log(text(await call("browser_html", { ref: selectRef, up: 2 })));
}

if (destRef) {
  console.log("\n=== browser_fill dest='Kaunas' ===");
  console.log(text(await call("browser_fill", { ref: destRef, value: "Kaunas" })));
}
if (searchRef) {
  console.log("\n=== browser_click Search ===");
  console.log(text(await call("browser_click", { ref: searchRef })));
}

console.log("\n=== re-snapshot (status text should change) ===");
console.log(text(await call("browser_snapshot")));

await client.close();
ff.kill();
console.log("\n=== done ===");
process.exit(0);
