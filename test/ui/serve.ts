// UI harness: serves the built popup and setup page with a stand-in extension API
// (test/ui/stub.js) and canned states, so they can be viewed, clicked and
// screenshotted in an ordinary browser tab, without loading the extension.
//
//   bun run build
//   bun run test/ui/serve.ts [--port 8790] [--dist dist/chrome]
//   open http://127.0.0.1:8790/            (index of every state, light and dark)
//
// Pages: /popup.html?state=<name>&theme=light|dark, /welcome.html?state=… (setup
// guide; use setup-1, setup-2, setup-3, setup-finished) and /options.html?state=…
// (&open=more opens every <details>). theme forces the colour scheme by rewriting
// the prefers-color-scheme block in ui.css, so both themes can be shot without
// changing the OS setting. --dist points at another build, e.g. a copy of main,
// for before/after comparisons. Nothing here is part of the extension.
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const arg = (flag: string, fallback: string) => {
  const i = process.argv.indexOf(flag);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT = Number(process.env.PORT || arg("--port", "8790"));
const DIST = resolve(ROOT, arg("--dist", "dist/chrome"));
const STUB = join(ROOT, "test", "ui", "stub.js");
// package.json is the one place the version is written; the stub gets it from here.
const VERSION: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

export const STATES = [
  "fresh", "setup-1", "setup-2", "setup-3", "setup-finished",
  "bridge-off", "locked", "locked-allowed", "ending", "jev-ready-on", "armed", "allowed", "blocked", "read-only", "mismatch", "bridge-old", "firefox-old",
  "no-site", "every-site", "always-on", "wide-open", "jev-on", "jev-no-key", "jev-key-off", "picked", "setup-done",
];

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".json": "application/json",
};

/** Force one theme: the dark block applies always (dark) or never (light). */
function themed(css: string, theme: string | null): string {
  if (theme !== "dark" && theme !== "light") return css;
  return css
    .replace(/@media\s*\(prefers-color-scheme:\s*dark\)/g, theme === "dark" ? "@media all" : "@media not all")
    .replace(/color-scheme:\s*light dark;/, `color-scheme: ${theme};`);
}

function page(file: string, url: URL): Response {
  const theme = url.searchParams.get("theme");
  let html = readFileSync(join(DIST, file), "utf8");
  html = html.replace('href="ui.css"', `href="ui.css${theme ? `?theme=${theme}` : ""}"`);
  // The stub must run before the page script picks up `chrome`.
  html = html.replace(/<script /, '<script src="/__stub.js"></script>\n  <script ');
  return new Response(html, { headers: { "content-type": TYPES[".html"] } });
}

function index(): Response {
  const links = (file: string) => STATES.map((s) =>
    `<li>${s}: <a href="/${file}?state=${s}&theme=light">light</a> · <a href="/${file}?state=${s}&theme=dark">dark</a></li>`).join("");
  return new Response(`<!doctype html><meta charset="utf-8"><title>Browsteer UI harness</title>
<body style="font:14px system-ui;margin:24px"><h1>Browsteer UI harness</h1><p>Serving ${DIST}</p>
<h2>Popup</h2><ul>${links("popup.html")}</ul><h2>Setup guide</h2><ul>${links("welcome.html")}</ul><h2>Settings</h2><ul>${links("options.html")}</ul>`,
    { headers: { "content-type": TYPES[".html"] } });
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    if (path === "/" ) return index();
    if (path === "/health") return new Response("browsteer ui harness");
    if (path === "/__stub.js") return new Response(readFileSync(STUB, "utf8").replace("__VERSION__", VERSION), { headers: { "content-type": TYPES[".js"] } });
    if (path === "/popup.html" || path === "/welcome.html" || path === "/options.html") return page(path.slice(1), url);
    const file = normalize(join(DIST, path));
    if (!file.startsWith(DIST) || !existsSync(file)) return new Response("not found", { status: 404 });
    const body = readFileSync(file);
    if (path === "/ui.css") return new Response(themed(body.toString("utf8"), url.searchParams.get("theme")), { headers: { "content-type": TYPES[".css"] } });
    return new Response(body, { headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream" } });
  },
});
console.log(`UI harness on http://127.0.0.1:${PORT}/ serving ${DIST}`);
