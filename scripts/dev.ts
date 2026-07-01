// Dev loop: rebuild the extension bundles on save + run a dev Firefox that
// hot-reloads the extension whenever dist/ changes.
//
// The BRIDGE itself is NOT started here — Claude Code spawns it over stdio
// (see README: `claude mcp add ...`). Running it here too would open a second
// WebSocket server on the same port. This script owns only the extension side,
// which is what you iterate on while tuning the snapshot.

const procs = [
  Bun.spawn(
    ["bun", "build", "extension/src/content.ts", "extension/src/background.ts", "extension/src/popup.ts",
     "--outdir", "extension/dist", "--target", "browser", "--watch"],
    { stdout: "inherit", stderr: "inherit" }
  ),
  Bun.spawn(
    ["bunx", "web-ext", "run", "--source-dir", "extension", "--target", "firefox-desktop"],
    { stdout: "inherit", stderr: "inherit" }
  ),
];

console.log("dev: bundler (watch) + web-ext (Firefox auto-reload) running.");
console.log("Bridge is launched by Claude Code via MCP — see README.");

const shutdown = () => { for (const p of procs) p.kill(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.all(procs.map((p) => p.exited));

export {};
