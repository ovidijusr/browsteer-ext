// End-to-end: the real Chrome extension in a real Chromium-family browser, driven
// by a real hub, the way Claude Code drives it. Not part of `bun test`:
//
//   bun run test:e2e                      (Edge on Windows, Playwright's Chromium elsewhere)
//   E2E_CHANNEL=chromium bun run test:e2e (Playwright's Chromium: `bunx playwright install chromium`)
//   E2E_HEADED=1 bun run test:e2e         (watch it)
//
// Everything runs on its own port (E2E_PORT, default 8799) with its own data folder,
// extension build and browser profile, all in a temp folder removed afterwards: the
// hub on 8787, ~/.browsteer and dist/ are never touched. If the port is taken the
// run stops before starting anything.
//
// Steps: build → hub → test page → browser with the unpacked extension → popup shows
// Locked → allow the test site and open access (messages from the extension's own
// page, as the popup sends them) → controller (token from the temp folder) pairs with
// the browser's key → snapshot / fill / click on the test page → Settings › Activity
// lists those actions without the typed text, and only the Settings page may ask.
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PORT = Number(process.env.E2E_PORT ?? 8799);
const CHANNEL = process.env.E2E_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chromium");
const BUDGET_MS = 180_000;
const TMP = mkdtempSync(join(tmpdir(), "browsteer-e2e-"));
const DATA = join(TMP, "data"), BUILD = join(TMP, "build"), PROFILE = join(TMP, "profile");
const EXT_DIR = join(BUILD, "chrome");
const TYPED = "Ada Lovelace";

const t0 = performance.now();
const results: { name: string; ms: number; ok: boolean; note?: string }[] = [];
let hub: ReturnType<typeof Bun.spawn> | null = null;
let hubLog = "";
let ctx: BrowserContext | null = null;
let site: ReturnType<typeof Bun.serve> | null = null;
let ctl: WebSocket | null = null;

class Failed extends Error {}
function check(cond: unknown, what: string): asserts cond { if (!cond) throw new Failed(what); }
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const s = performance.now();
  try {
    const r = await fn();
    results.push({ name, ms: Math.round(performance.now() - s), ok: true });
    console.log(`  ✓ ${name} (${Math.round(performance.now() - s)} ms)`);
    return r;
  } catch (e: any) {
    results.push({ name, ms: Math.round(performance.now() - s), ok: false, note: e?.message ?? String(e) });
    console.log(`  ✗ ${name}: ${e?.message ?? e}`);
    throw e;
  }
}
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 15_000, every = 150): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T; } catch (e) { last = e; }
    await Bun.sleep(every);
  }
  throw new Failed(`timed out waiting for ${what}${last ? ` (last error: ${(last as Error).message ?? last})` : ""}`);
}

async function cleanup() {
  try { ctl?.close(); } catch {}
  try { await ctx?.close(); } catch {}
  try { hub?.kill(); await hub?.exited; } catch {}
  try { site?.stop(true); } catch {}
  for (let i = 0; i < 5; i++) { try { rmSync(TMP, { recursive: true, force: true }); break; } catch { await Bun.sleep(300); } }
}
const watchdog = setTimeout(async () => {
  console.error(`\n✗ e2e: over the ${BUDGET_MS / 1000} s budget, giving up`);
  await cleanup();
  process.exit(1);
}, BUDGET_MS);

// ── The test page: a small form, served over http so the content script runs ──
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Browsteer e2e form</title></head>
<body><main><h1>Contact</h1>
<form id="f" onsubmit="return false">
  <label>Name <input id="name" name="name" autocomplete="off"></label>
  <label>Topic <select id="topic"><option>General</option><option>Billing</option></select></label>
  <button type="button" id="greet">Show greeting</button>
</form>
<p id="out" role="status"></p>
<script>document.getElementById("greet").onclick = () => { document.getElementById("out").textContent = "Hello, " + document.getElementById("name").value + "!"; };</script>
</main></body></html>`;

// ── A controller, the way bridge/cli.ts and the MCP shim talk to the hub ──
const waits = new Map<string, (m: any) => void>();
let seq = 0;
function call(op: string, params: Record<string, unknown> = {}): Promise<{ ok: boolean; text: string }> {
  const id = `e2e-${++seq}`;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { waits.delete(id); reject(new Failed(`${op}: no answer from the hub`)); }, 20_000);
    waits.set(id, (m) => { clearTimeout(t); resolve(m); });
    ctl!.send(JSON.stringify({ id, op, params }));
  });
}
/** Run a message the way the extension's own pages send it, from one of its pages. */
const fromPage = (page: Page, msg: Record<string, unknown>) =>
  page.evaluate((m) => (globalThis as any).chrome.runtime.sendMessage(m), msg) as Promise<any>;

async function main() {
  console.log(`Browsteer e2e — ${CHANNEL}, bridge port ${PORT}, temp ${TMP}`);

  await step("port is free", async () => {
    const taken = await fetch(`http://127.0.0.1:${PORT}`).then(() => true, () => false);
    check(!taken, `port ${PORT} is in use; set E2E_PORT to a free one (nothing was started)`);
  });

  await step("build the Chrome extension for this port", async () => {
    const p = Bun.spawnSync(["bun", "run", "scripts/build.ts", "chrome", "--out", BUILD], { cwd: ROOT, env: { ...process.env, BRIDGE_PORT: String(PORT) }, stderr: "pipe", stdout: "pipe" });
    check(p.exitCode === 0, `build failed: ${p.stderr.toString()}`);
    const m = JSON.parse(readFileSync(join(EXT_DIR, "manifest.json"), "utf8"));
    check(m.content_security_policy.extension_pages.includes(`ws://127.0.0.1:${PORT}`), "the build does not point at the test port");
  });

  await step("start a hub with its own data folder", async () => {
    const env: Record<string, string | undefined> = { ...process.env, BRIDGE_PORT: String(PORT), BROWSTEER_DB_DIR: DATA, TYPESAFE_ENV_FILE: join(TMP, "typesafe.env"), BROWSTEER_KEYS_FILE: join(TMP, "keys.env") };
    for (const k of ["BROWSTEER_JEV", "TYPESAFE_API_KEY", "NEXOS_API_KEY", "OPENROUTER_API_KEY", "OLLAMA_API_KEY", "BROWSTEER_CUSTOM_API_KEY"]) delete env[k];
    hub = Bun.spawn(["bun", "run", "bridge/hub.ts"], { cwd: ROOT, env, stdout: "ignore", stderr: "pipe" });
    (async () => { for await (const chunk of hub!.stderr as ReadableStream<Uint8Array>) hubLog += new TextDecoder().decode(chunk); })();
    await until("the hub to listen", () => fetch(`http://127.0.0.1:${PORT}`).then((r) => r.ok, () => false));
  });

  const pageUrl = await step("serve the test page", async () => {
    site = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }) });
    return `http://127.0.0.1:${site.port}/contact`;
  });

  const extId = await step(`launch ${CHANNEL} with the unpacked extension`, async () => {
    ctx = await chromium.launchPersistentContext(PROFILE, {
      channel: CHANNEL,
      headless: !process.env.E2E_HEADED,
      args: [
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
        // Branded Chrome and Edge builds ignore --load-extension unless this is off.
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
    return new URL(sw.url()).host;
  });

  const popup = await step("the popup renders the locked state", async () => {
    const p = await ctx!.newPage();
    await p.goto(`chrome-extension://${extId}/popup.html`);
    await p.waitForFunction(() => document.getElementById("bar")?.dataset.tone === "locked", null, { timeout: 10_000 });
    const state = await p.locator("#sState").textContent();
    check(state === "Locked", `popup says "${state}", expected "Locked"`);
    return p;
  });

  const key = await step("the extension registers with the hub", async () => {
    const s = await until("the extension to connect", async () => { const s = await fromPage(popup, { type: "getStatus" }); return s?.connected ? s : null; }, 20_000, 300);
    check(/^bst(-[a-z0-9]{4}){3}$/.test(s.key), `odd pairing key ${s.key}`);
    check(!s.armed, "access is open before anyone opened it");
    return s.key as string;
  });

  const target = await step("open the test page", async () => {
    const p = await ctx!.newPage();
    await p.goto(pageUrl);
    await p.waitForSelector("#greet");
    return p;
  });

  await step("allow the test site and open access (from the extension's page)", async () => {
    const s = await fromPage(popup, { type: "allowSite", host: "127.0.0.1", open: true });
    check(s?.armed === true, "access did not open");
    check(s.settings.allow.includes("127.0.0.1"), "the site was not allowed");
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById("bar")?.dataset.tone === "open", null, { timeout: 10_000 });
  });

  const tabId = await step("controller connects with the token and pairs", async () => {
    const token = readFileSync(join(DATA, "token"), "utf8").trim();
    ctl = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise<void>((res, rej) => { ctl!.onopen = () => res(); ctl!.onerror = () => rej(new Failed("controller could not connect")); });
    ctl.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === "denied") console.error(`  hub denied: ${m.reason}`); waits.get(m.id)?.(m); waits.delete(m.id); };
    ctl.send(JSON.stringify({ type: "hello", role: "control", token }));
    const paired = await call("pair", { key });
    check(paired.ok && paired.text.includes("Paired"), `pair: ${paired.text}`);
    const tabs: any[] = await popup.evaluate(() => (globalThis as any).chrome.tabs.query({}));
    const tab = tabs.find((t) => String(t.url).startsWith(pageUrl));
    check(tab?.id != null, "test page tab not found");
    const pin = await call("pin", { tabId: tab.id });
    check(pin.ok, `pin: ${pin.text}`);
    return tab.id as number;
  });

  const refs = await step("snapshot shows the form", async () => {
    // The content script loads with the page; give it a moment on a slow machine.
    const r = await until("a snapshot", async () => { const r = await call("snapshot"); return r.ok ? r : null; }, 15_000, 400);
    const name = /\[(\d+)\] textbox "Name"/.exec(r.text);
    const greet = /\[(\d+)\] button "Show greeting"/.exec(r.text);
    check(name && greet, `snapshot lacks the form:\n${r.text}`);
    check(/combobox "Topic/.test(r.text), `snapshot lacks the select:
${r.text}`);
    return { name: Number(name[1]), greet: Number(greet[1]) };
  });

  await step("fill types into the field", async () => {
    const r = await call("fill", { ref: refs.name, value: TYPED });
    check(r.ok, `fill: ${r.text}`);
    check(await target.inputValue("#name") === TYPED, "the field does not hold the text");
  });

  await step("click runs the page's handler", async () => {
    const r = await call("click", { ref: refs.greet });
    check(r.ok, `click: ${r.text}`);
    await target.waitForFunction(() => document.getElementById("out")?.textContent === "Hello, Ada Lovelace!", null, { timeout: 5_000 });
    const snap = await call("snapshot");
    check(snap.text.includes("Hello, Ada Lovelace!"), "the snapshot does not show the result");
  });

  await step("a controller is refused on a site that is not allowed", async () => {
    const other = await ctx!.newPage();
    await other.goto(pageUrl.replace("127.0.0.1", "localhost"));
    const tabs: any[] = await popup.evaluate(() => (globalThis as any).chrome.tabs.query({}));
    const t = tabs.find((x) => String(x.url).includes("localhost"));
    await call("pin", { tabId: t.id });
    const r = await call("snapshot");
    check(!r.ok, "a snapshot of a site that is not allowed came back");
    check(/allowed list|locked to/.test(r.text), `unexpected refusal: ${r.text}`);
    await other.close();
    await call("pin", { tabId });
  });

  await step("Settings › Activity lists the actions, without the typed text", async () => {
    const settings = await ctx!.newPage();
    await settings.goto(`chrome-extension://${extId}/options.html`);
    const s = await fromPage(settings, { type: "activity" });
    const items: any[] = s?.reply?.items ?? [];
    check(items.length >= 4, `expected the actions in the log, got ${JSON.stringify(s?.reply ?? null).slice(0, 300)}`);
    const words = items.map((i) => i.action);
    check(words.includes(`Filled [${refs.name}] textbox “Name” (${TYPED.length} characters)`), `no fill row: ${words.join(" | ")}`);
    check(words.includes(`Clicked [${refs.greet}] button “Show greeting”`), `no click row: ${words.join(" | ")}`);
    check(words.includes("Read the page"), "no snapshot row");
    check(items.some((i) => i.outcome !== "ok"), "the refused snapshot is not listed");
    check(items.every((i) => i.browser === (CHANNEL === "msedge" ? "edge" : "chrome") && i.thisBrowser && i.session), "browser or session missing");
    check(items.every((i) => !i.site || i.site.startsWith("127.0.0.1") || i.site.startsWith("localhost")), "unexpected site");
    check(!JSON.stringify(s.reply).includes("Ada"), "the typed text reached the Settings page");
    // And the page draws it.
    await settings.waitForSelector("#actList .act-rows li", { timeout: 10_000 });
    const drawn = await settings.locator("#actList").innerText();
    check(drawn.includes("Show greeting") && !drawn.includes("Ada"), "the Activity list is not drawn as expected");
    // Only the Settings page may ask: the popup gets nothing.
    const fromPopup = await fromPage(popup, { type: "activity" });
    check(!fromPopup?.reply, "the popup was given the activity");
  });
}

let failed = false;
try { await main(); }
catch (e: any) {
  failed = true;
  if (!(e instanceof Failed)) console.error(e);
  if (hubLog) console.error(`\n--- hub log ---\n${hubLog.trim().split("\n").slice(-30).join("\n")}`);
}
clearTimeout(watchdog);
await cleanup();
const total = Math.round((performance.now() - t0) / 100) / 10;
const passed = results.filter((r) => r.ok).length;
console.log(`\ne2e ${failed ? "FAILED" : "passed"}: ${passed}/${results.length} steps in ${total} s (${CHANNEL}, port ${PORT})`);
process.exit(failed ? 1 : 0);
