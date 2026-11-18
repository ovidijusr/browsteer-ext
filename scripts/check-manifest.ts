// Fails the build if either built manifest asks for more than docs/PERMISSIONS.md
// explains. Run after `bun run build`. Adding a permission means changing the
// list below in the same commit as the documentation.
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ALLOWED = {
  permissions: ["alarms", "storage", "tabs", "webRequest"],
  host_permissions: ["<all_urls>"],
  csp: /^script-src 'self'; object-src 'self'; connect-src ws:\/\/127\.0\.0\.1:\d+ https:\/\/\*:\* http:\/\/\*:\*$/,
};

let bad = 0;
const fail = (msg: string) => { console.error(`✗ ${msg}`); bad++; };
const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

for (const target of ["chrome", "firefox"]) {
  const m = JSON.parse(readFileSync(join(ROOT, "dist", target, "manifest.json"), "utf8"));
  if (m.manifest_version !== 3) fail(`${target}: manifest_version is ${m.manifest_version}`);
  if (!same(m.permissions ?? [], ALLOWED.permissions)) fail(`${target}: permissions are [${m.permissions}] — expected [${ALLOWED.permissions}]`);
  if (!same(m.host_permissions ?? [], ALLOWED.host_permissions)) fail(`${target}: host_permissions are [${m.host_permissions}]`);
  if (m.optional_permissions?.length || m.optional_host_permissions?.length) fail(`${target}: optional permissions are not documented`);
  if (!ALLOWED.csp.test(m.content_security_policy?.extension_pages ?? "")) fail(`${target}: CSP changed: ${m.content_security_policy?.extension_pages}`);
  if (m.externally_connectable || m.web_accessible_resources) fail(`${target}: pages must not be able to reach the extension (externally_connectable / web_accessible_resources)`);
  for (const cs of m.content_scripts ?? []) if (cs.all_frames) fail(`${target}: content scripts must not run in frames`);
  // Updates may only come over https, and only from this project's own GitHub releases.
  const upd = m.browser_specific_settings?.gecko?.update_url;
  if (upd !== undefined && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/latest\/download\/updates\.json$/.test(upd)) fail(`${target}: update_url must point at GitHub releases over https: ${upd}`);
  const docs = readFileSync(join(ROOT, "docs", "PERMISSIONS.md"), "utf8");
  for (const p of m.permissions ?? []) if (!docs.includes(`\`${p}\``)) fail(`${target}: permission ${p} is not explained in docs/PERMISSIONS.md`);
  if (!bad) console.log(`✓ dist/${target}/manifest.json asks for exactly what is documented`);
}
process.exit(bad ? 1 : 0);
