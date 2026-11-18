// Build the extension for one browser or both:
//
//   bun run scripts/build.ts                 → dist/firefox and dist/chrome
//   bun run scripts/build.ts chrome --dev    → dist/chrome, unminified
//
// Each output directory is a complete, loadable extension. The two differ only
// in the manifest (how the background runs, browser-specific keys) and in one
// extra page-world script that Chrome needs for dialog handling.
import { fileURLToPath } from "node:url";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Target = "firefox" | "chrome";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "extension");

const args = process.argv.slice(2);
const dev = args.includes("--dev");
const wanted = args.filter((a) => a === "firefox" || a === "chrome") as Target[];
const targets: Target[] = wanted.length ? wanted : ["firefox", "chrome"];

// The bridge port is baked in: the extension can only ever talk to this one address.
const port = String(Number(process.env.BRIDGE_PORT ?? 8787));
const version: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
// Releases are listed on addons.mozilla.org, and Firefox updates listed add-ons from AMO.
// AMO rejects listed versions that carry update_url, so the build has none by default.
// A self-distributed (unlisted) build can set BROWSTEER_UPDATE_URL to the https address of
// its own updates.json (see scripts/updates-json.ts and docs/RELEASING.md).
const updateUrl = process.env.BROWSTEER_UPDATE_URL ?? "";
if (updateUrl && !updateUrl.startsWith("https://")) throw new Error("BROWSTEER_UPDATE_URL must be https://");

function manifest(target: Target) {
  const base = JSON.parse(readFileSync(join(SRC, "manifest.base.json"), "utf8"));
  base.version = version; // package.json is the single source of the version
  base.content_security_policy.extension_pages = base.content_security_policy.extension_pages.replace("127.0.0.1:8787", `127.0.0.1:${port}`);
  if (target === "firefox") {
    return {
      ...base,
      background: { scripts: ["background.js"] },
      browser_specific_settings: {
        gecko: {
          id: "browsteer-cc@ovi.lt",
          strict_min_version: "140.0", // 140 (ESR) is the first with data_collection_permissions
          data_collection_permissions: { required: ["none"] },
          ...(updateUrl ? { update_url: updateUrl } : {}),
        },
      },
    };
  }
  return {
    ...base,
    // 116: an open WebSocket keeps the service worker alive. 111: "world": "MAIN".
    minimum_chrome_version: "116",
    background: { service_worker: "background.js" },
    content_scripts: [
      ...base.content_scripts,
      { matches: ["<all_urls>"], js: ["dialogs-main.js"], run_at: "document_start", world: "MAIN", all_frames: false },
    ],
  };
}

for (const target of targets) {
  const out = join(ROOT, "dist", target);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const entries = ["background", "content", "popup", "welcome", "options", ...(target === "chrome" ? ["dialogs-main"] : [])];
  const res = await Bun.build({
    entrypoints: entries.map((e) => join(SRC, "src", `${e}.ts`)),
    outdir: out,
    target: "browser",
    format: "iife", // classic scripts: content scripts and service workers are not modules
    minify: !dev,
    sourcemap: "none",
    define: { BRIDGE_PORT: JSON.stringify(port) },
  });
  if (!res.success) { for (const l of res.logs) console.error(l); process.exit(1); }

  for (const f of ["popup.html", "welcome.html", "options.html", "ui.css"]) cpSync(join(SRC, f), join(out, f));
  cpSync(join(SRC, "icons"), join(out, "icons"), { recursive: true });
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest(target), null, 2) + "\n");
  console.log(`built dist/${target}  v${version}${dev ? "  (dev)" : ""}${port === "8787" ? "" : `  (bridge port ${port})`}`);
}
