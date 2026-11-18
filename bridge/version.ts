// The bridge's version, read once at startup from package.json (the single source of
// the version; the build writes the same number into both extension manifests).
// Read once on purpose: a hub or MCP shim that was started before `bun run update`
// keeps reporting the version of the code it is actually running.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const VERSION: string = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version;

/** Compare dotted numeric versions: <0 when a is older than b, 0 when equal, >0 when newer. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** What to tell the caller when the browser extension and the bridge disagree, or null when they match. */
export function extensionVersionNote(ext: string | null | undefined, bridge = VERSION): string | null {
  if (!ext) return `⚠ The browser extension did not report its version, so it is older than the bridge (v${bridge}). Update it (see "Updating" in the README).`;
  const d = cmpVersion(ext, bridge);
  if (d === 0) return null;
  if (d < 0) return `⚠ The browser extension is v${ext}, the bridge is v${bridge}. Firefox installs the new version by itself within a day (about:addons → ⚙ → Check for Updates does it now); a Chrome or temporary install needs a reload of the rebuilt extension.`;
  return `⚠ The browser extension is v${ext}, newer than the bridge (v${bridge}). Run \`bun run update\` in the Browsteer folder.`;
}
