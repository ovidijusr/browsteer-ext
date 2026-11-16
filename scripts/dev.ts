// Dev loop: rebuild on save and reload the extension in a throwaway browser.
//
//   bun run dev            Firefox (web-ext run, auto-reload)
//   bun run dev chrome     rebuilds dist/chrome on save; reload it from chrome://extensions
//
// The bridge is NOT started here — Claude Code starts it through MCP.
import { watch } from "node:fs";
import { join } from "node:path";

const target = process.argv.includes("chrome") ? "chrome" : "firefox";
const ROOT = new URL("..", import.meta.url).pathname;
const build = () => Bun.spawnSync(["bun", "run", join(ROOT, "scripts/build.ts"), target, "--dev"], { stdout: "inherit", stderr: "inherit" });

build();
let timer: ReturnType<typeof setTimeout> | null = null;
watch(join(ROOT, "extension"), { recursive: true }, () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(build, 120);
});

if (target === "firefox") {
  const p = Bun.spawn(["bunx", "web-ext", "run", "--source-dir", join(ROOT, "dist/firefox"), "--target", "firefox-desktop"], { stdout: "inherit", stderr: "inherit" });
  process.on("SIGINT", () => { p.kill(); process.exit(0); });
  await p.exited;
  process.exit(0);
} else {
  console.log("Load dist/chrome once via chrome://extensions → Developer mode → Load unpacked, then press its reload button after changes.");
}
