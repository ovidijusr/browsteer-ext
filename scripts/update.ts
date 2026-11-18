// Bring this checkout up to date and put the new bridge in service:
//
//   bun run update
//
// 1. git pull (fast-forward only; stops if you have local commits or edits in the way)
// 2. install dependencies exactly as locked
// 3. rebuild both extensions
// 4. stop the running hub, so the next browser_* call starts the new one
//
// Sessions opened before the update keep their old browser tools; their replies say
// to start a new session. The signed Firefox extension updates itself from GitHub
// releases; a Chrome or temporary install needs a reload of the rebuilt dist/ folder.
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const version = () => JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
$.cwd(ROOT);

const before = version();
const head = (await $`git rev-parse --short HEAD`.text()).trim();
console.log(`Browsteer v${before} (${head}): pulling…`);
const pull = await $`git pull --ff-only`.nothrow();
if (pull.exitCode !== 0) {
  console.error("\ngit pull --ff-only failed (see above). Commit or stash your changes, or rebase, then run `bun run update` again.");
  process.exit(1);
}
const after = version();
const now = (await $`git rev-parse --short HEAD`.text()).trim();
if (now === head) { console.log("Already up to date."); process.exit(0); }

await $`bun install --frozen-lockfile`;
await $`bun run scripts/build.ts`;
await $`bun run bridge/hub.ts --stop`.nothrow();

console.log(`\nUpdated v${before} (${head}) → v${after} (${now}).`);
console.log("- The hub restarts with the new code on the next browser_* call.");
console.log("- Claude Code sessions that were already open: start a new session to get the new tools.");
if (after !== before) {
  console.log("- Firefox (signed install): updates itself within a day; about:addons → ⚙ → Check for Updates does it now.");
  console.log(`- Chrome or a temporary Firefox install: reload the extension from ${join(ROOT, "dist")}.`);
}
