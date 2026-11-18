// Write artifacts/updates.json: the file Firefox reads (via update_url in the manifest)
// to learn that a newer signed version of the extension exists and where to get it.
//
//   bun run scripts/updates-json.ts artifacts/browsteer-firefox-2.0.0.xpi
//
// The release workflow uploads it to every GitHub release next to the .xpi, so
// releases/latest/download/updates.json always describes the newest one. The
// sha256 lets Firefox refuse a download that is not the file this release signed.
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const xpi = process.argv[2];
if (!xpi) { console.error("usage: bun run scripts/updates-json.ts <signed .xpi>"); process.exit(2); }

const version: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const manifest = JSON.parse(readFileSync(join(ROOT, "dist", "firefox", "manifest.json"), "utf8"));
const id: string = manifest.browser_specific_settings.gecko.id;
const minVersion: string = manifest.browser_specific_settings.gecko.strict_min_version;
const repo = process.env.GITHUB_REPOSITORY ?? "ovidijusr/browsteer-ext";
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`bad GITHUB_REPOSITORY: ${repo}`);

const sha = createHash("sha256").update(readFileSync(xpi)).digest("hex");
const updates = {
  addons: {
    [id]: {
      updates: [{
        version,
        update_link: `https://github.com/${repo}/releases/download/v${version}/${basename(xpi)}`,
        update_hash: `sha256:${sha}`,
        applications: { gecko: { strict_min_version: minVersion } },
      }],
    },
  },
};
mkdirSync(join(ROOT, "artifacts"), { recursive: true });
writeFileSync(join(ROOT, "artifacts", "updates.json"), JSON.stringify(updates, null, 2) + "\n");
console.log(`wrote artifacts/updates.json: ${id} v${version} → ${basename(xpi)} (sha256 ${sha.slice(0, 12)}…)`);
