// Package both builds into artifacts/:
//   browsteer-chrome-<version>.zip   upload to the Chrome Web Store, or unzip and "Load unpacked"
//   browsteer-firefox-<version>.zip  unsigned; `bun run sign:firefox` produces the installable .xpi
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const version: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const out = join(ROOT, "artifacts");
mkdirSync(out, { recursive: true });

await $`bun run ${join(ROOT, "scripts/build.ts")}`;
for (const target of ["chrome", "firefox"]) {
  const zip = join(out, `browsteer-${target}-${version}.zip`);
  rmSync(zip, { force: true });
  await $`zip -qr -X ${zip} .`.cwd(join(ROOT, "dist", target));
  console.log(`packaged artifacts/browsteer-${target}-${version}.zip`);
}
