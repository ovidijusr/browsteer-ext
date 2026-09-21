// Browsteer HUB — the single shared daemon.
//
// Owns the WebSocket on :8787 and answers two kinds of clients:
//   • EXTENSIONS  — Firefox content/background, register with {type:"register",key}
//   • CONTROLLERS — per-session MCP shims (mcp.ts), say {type:"hello",role:"control"}
//                   then send {id,op,params}; we run the op and reply {id,ok,text}.
//
// One hub serves many controllers (Claude sessions) driving the browser(s).
// Singleton: if the port is already taken, another hub owns it → we exit.
// Persists across sessions so the extension stays paired (no reconnect lag).
//
// All logging goes to STDERR (stdout is unused here, but keep the habit).
import { logAction, upsertFilter, listFilters, deleteFilter } from "./db";
import { THRESHOLDS, findTarget, findMany, guardClick, needsGuard, warm, formatShortlist, pct, type Ranked } from "./jev";
import type { ServerWebSocket } from "bun";

const WS_PORT = Number(process.env.BRIDGE_PORT ?? 8787);
const CALL_TIMEOUT_MS = 15_000;

// Per-controller (per Claude session) state — pairings/pins don't leak across sessions.
interface Controller {
  activeKey: string | null;
  pinnedTabId: number | null;
  lastUrl: string | null;
  autoPinned: boolean;      // we pinned it, the caller didn't
  noAutoPin: boolean;       // caller explicitly unpinned — don't re-pin behind their back
  lastOpMayNavigate: boolean; // the previous op could legitimately change the URL
}
type SockData = { role: "extension" | "control" | null; key: string | null; ctl: Controller | null };
type Sock = ServerWebSocket<SockData>;

const browsers = new Map<string, Sock>(); // key → extension socket
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let seq = 0;

function newController(): Controller {
  return { activeKey: null, pinnedTabId: null, lastUrl: null, autoPinned: false, noAutoPin: false, lastOpMayNavigate: false };
}

// Ops that can legitimately change the URL — drift after one of these is expected.
const MAY_NAVIGATE = new Set(["navigate", "click", "press", "fill", "select", "find", "pursue"]);
// Ops whose payload is big enough that answering about the wrong page is a real cost.
const HEAVY_READ = new Set(["snapshot", "html", "links"]);

function noteUrl(ctl: Controller, url?: string): string {
  if (!url) return "";
  let warn = "";
  if (ctl.lastUrl && url !== ctl.lastUrl) {
    warn = `\n⚠ tab URL changed since last action: ${ctl.lastUrl} → ${url}` +
      (ctl.pinnedTabId == null ? "  (no tab pinned — focus may have moved; use browser_tabs + browser_pin to lock one)" : "");
  }
  ctl.lastUrl = url;
  return warn;
}

// Lock onto whichever tab served the first op, so a later call can't quietly
// answer about a tab the user happened to focus in the meantime.
function maybeAutoPin(ctl: Controller, tabId?: number): string {
  if (tabId == null || ctl.pinnedTabId != null || ctl.noAutoPin) return "";
  ctl.pinnedTabId = tabId;
  ctl.autoPinned = true;
  return `\nℹ auto-pinned to tab ${tabId} so later calls can't drift to another tab` +
    ` (browser_pin with no tabId to follow focus instead).`;
}

// The payload is already in hand here, but it is about a page nobody asked for.
// Returning an error instead of the tree is the whole point: the caller pays a
// line, not a few thousand tokens of the wrong document.
function driftRefusal(ctl: Controller, op: string, url: string | undefined, prevMayNavigate: boolean): string | null {
  if (!url || !HEAVY_READ.has(op)) return null;
  if (ctl.pinnedTabId != null) return null;      // caller owns the target explicitly
  if (!ctl.lastUrl || url === ctl.lastUrl) return null;
  if (prevMayNavigate) return null;              // we caused this change
  return `Refusing to return the ${op}: the target tab is not the page you were working on.\n` +
    `  was: ${ctl.lastUrl}\n  now: ${url}\n` +
    `Browser focus moved, so this payload would describe a page you did not ask for and it has NOT been sent. ` +
    `Re-target on purpose: browser_tabs → browser_pin({tabId}) for the page you want, then retry.`;
}

function targetSocket(ctl: Controller): Sock {
  if (ctl.activeKey) {
    const s = browsers.get(ctl.activeKey);
    if (!s) throw new Error(`Paired browser '${ctl.activeKey}' is no longer connected. Re-open it and run browser_pair again.`);
    return s;
  }
  if (browsers.size === 1) return [...browsers.values()][0];
  if (browsers.size === 0)
    throw new Error("No browser connected. Open Firefox with the Browsteer extension, then pair with its key via browser_pair.");
  throw new Error(`${browsers.size} browsers connected — call browser_pair with one of: ${[...browsers.keys()].join(", ")}`);
}

function callExtension(ctl: Controller, op: string, params: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<any> {
  let sock: Sock;
  try { sock = targetSocket(ctl); } catch (e) { return Promise.reject(e); }
  const id = `${op}-${++seq}`;
  const sendParams = ctl.pinnedTabId != null && op !== "tabs" ? { ...params, tabId: ctl.pinnedTabId } : params;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Extension timed out after ${timeoutMs}ms on '${op}'`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    sock.send(JSON.stringify({ id, op, params: sendParams }));
  });
}

// ── Jev helpers ───────────────────────────────────────────────────────────────
// Uncollapsed so every repeated control keeps its own ref and name; text nodes
// kept because targets are often described by nearby text. Retries briefly:
// right after a click the content script may not be injected yet.
async function jevSnapshot(ctl: Controller, withText: boolean): Promise<any> {
  let lastErr: any;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await callExtension(ctl, "snapshot", { interactiveOnly: !withText, filters: listFilters(), chrome: true, collapse: false, dedup: true });
      logAction({ tab_url: r.url, tool: "snapshot", ok: true, element_count: r.count, value: "jev" });
      return r;
    } catch (e) { lastErr = e; await Bun.sleep(700); }
  }
  throw lastErr;
}
// Guard only when the name smells like a commitment; otherwise 0 without a round trip.
async function maybeGuard(cand: Ranked, goal: string, url: string): Promise<{ g: number; asked: boolean }> {
  if (!needsGuard(cand)) return { g: 0, asked: false };
  return { g: await guardClick(cand, goal, url), asked: true };
}
// Click, then wait for the page to react by polling the content script's
// mutation counter from HERE (page timers are throttled in background tabs;
// extension messaging is not). Settled = URL changed, or no DOM mutations for
// QUIET_MS after at least MIN_MS, or the cap. A poll that fails means the
// document is unloading (full navigation): keep polling until the new document
// answers or the cap hits.
const QUIET_MS = 150, MIN_MS = 80, POLL_MS = 60;
async function settledClick(ctl: Controller, ref: number, maxMs = 1500): Promise<any> {
  const r = await callExtension(ctl, "click", { ref });
  ctl.lastOpMayNavigate = true;
  if (!r?.pulse) { await Bun.sleep(600); return { ...r, settled: { settledMs: 600, urlChanged: false, unloading: false, fallback: true } }; } // old content script
  const t0 = performance.now(); const startUrl = r.url;
  let last = r.mutations as number, lastChange = t0, unloading = false, url = startUrl;
  while (performance.now() - t0 < maxMs) {
    await Bun.sleep(POLL_MS);
    let pl: any;
    try { pl = await callExtension(ctl, "pulse", {}, 1500); } catch { unloading = true; continue; }
    url = pl.url;
    if (url !== startUrl && !unloading) break;              // SPA route change → reacted
    if (unloading && pl.ready !== "loading") break;         // new document is up
    if (pl.mutations !== last) { last = pl.mutations; lastChange = performance.now(); continue; }
    if (performance.now() - lastChange >= QUIET_MS && performance.now() - t0 >= MIN_MS) break;
  }
  return { url, settled: { settledMs: Math.round(performance.now() - t0), urlChanged: url !== startUrl, unloading } };
}
const fmtSettle = (r: any) => r?.settled ? ` settled ${r.settled.settledMs} ms${r.settled.unloading ? ", full navigation" : r.settled.urlChanged ? ", URL changed" : ""}` : "";
async function hrefOf(ctl: Controller, cand: Ranked): Promise<string> {
  if (cand.role !== "link") return "";
  try { const r = await callExtension(ctl, "href", { ref: cand.ref }); return r?.href ?? ""; } catch { return ""; }
}

type Res = { text: string; isError?: boolean };
const ok = (text: string): Res => ({ text });
const fail = (text: string): Res => ({ text, isError: true });

// The op bodies — identical behavior to the old per-tool MCP handlers, but with
// per-controller state and returning {text,isError} instead of MCP content.
async function execOp(ctl: Controller, op: string, p: any): Promise<Res> {
  // Read the previous op's intent before overwriting it — drift is only
  // suspicious when the op *before* this one couldn't have caused it.
  const prevMayNavigate = ctl.lastOpMayNavigate;
  ctl.lastOpMayNavigate = MAY_NAVIGATE.has(op);
  switch (op) {
    case "pair": {
      if (!browsers.has(p.key)) {
        const avail = [...browsers.keys()];
        return fail(avail.length
          ? `No browser with key '${p.key}'. Connected: ${avail.join(", ")}.`
          : `No browser with key '${p.key}', and none are connected. Open Firefox with the extension.`);
      }
      ctl.activeKey = p.key;
      return ok(`Paired with browser '${p.key}'.`);
    }
    case "snapshot": {
      try {
        const filters = p.raw ? [] : listFilters();
        // `raw` means genuinely unprocessed: no saved filter AND no reduction passes.
        // Per-pass overrides are for diagnosis/benchmarks; `raw` remains the documented all-off switch.
        const r = await callExtension(ctl, "snapshot", {
          interactiveOnly: p.interactiveOnly ?? false, filters: p.filters === false ? [] : filters,
          chrome: p.chrome ?? !p.raw, collapse: p.collapse ?? !p.raw, dedup: p.dedup ?? !p.raw,
        });
        const refuse = driftRefusal(ctl, "snapshot", r.url, prevMayNavigate);
        if (refuse) { logAction({ tab_url: r.url, tool: "snapshot", ok: false, error: "drift refused" }); return fail(refuse); }
        logAction({ tab_url: r.url, tool: "snapshot", ok: true, element_count: r.count });
        let header = `URL: ${r.url}\nActionable: ${r.count}`;
        const saved: string[] = [];
        if (r.collapsed) saved.push(`collapsed ${r.collapsed}`);
        if (r.deduped) saved.push(`deduped ${r.deduped}`);
        if (r.chrome) saved.push(`chrome ${r.chrome} region${r.chrome === 1 ? "" : "s"}`);
        if (saved.length) header += `\nReduced: ${saved.join(", ")} — pass raw:true for the unreduced page`;
        if (r.applied && r.extracted) header += `\nFilter: ${r.applied} (extraction — ${r.count} rows; legend on first line) — pass raw:true to bypass`;
        else if (r.applied) {
          const scope = r.rootApplied ? `scoped to '${r.rootApplied}', ` : "";
          header += `\nFilter: ${r.applied} (${scope}hid ${r.dropped.subtrees} regions, ${r.dropped.textLines} text lines) — pass raw:true to bypass`;
          if (r.rootMissing) header += `\n⚠ filter root selector matched nothing; showing whole page`;
        }
        header += maybeAutoPin(ctl, r.tabId);
        header += noteUrl(ctl, r.url);
        return ok(`${header}\n\n${r.tree}`);
      } catch (e: any) { logAction({ tool: "snapshot", ok: false, error: e.message }); return fail(e.message); }
    }
    case "links": {
      try {
        const r = await callExtension(ctl, "links", { ref: p.ref, limit: p.limit ?? 200 });
        const refuse = driftRefusal(ctl, "links", r.url, prevMayNavigate);
        if (refuse) return fail(refuse);
        logAction({ tab_url: r.url, tool: "links", ref: p.ref ?? null, ok: true, element_count: r.links.length });
        let header = `URL: ${r.url}\nLinks: ${r.links.length}${r.total > r.links.length ? ` of ${r.total} (raise limit for more)` : ""}`;
        if (r.scoped) header += ` — scoped to [${p.ref}]`;
        if (r.prefix || r.suffix) header += `\nurl = ${JSON.stringify(r.prefix)} + <url> + ${JSON.stringify(r.suffix)}`;
        header += maybeAutoPin(ctl, r.tabId);
        header += noteUrl(ctl, r.url);
        const body = r.links.map((l: any) => `${l.text} ⇢ ${l.url}`).join("\n");
        return ok(`${header}\n\n${body || "no links found"}`);
      } catch (e: any) { logAction({ tool: "links", ref: p.ref ?? null, ok: false, error: e.message }); return fail(e.message); }
    }
    case "click": try { const r = p.settle === 0 ? await callExtension(ctl, "click", { ref: p.ref }) : await settledClick(ctl, p.ref, p.settle ?? 800); logAction({ tab_url: r?.url, tool: "click", ref: p.ref, ok: true }); return ok(`Clicked [${p.ref}].${fmtSettle(r)} Re-snapshot to see the result.${maybeAutoPin(ctl, r?.tabId)}${noteUrl(ctl, r?.url)}`); } catch (e: any) { logAction({ tool: "click", ref: p.ref, ok: false, error: e.message }); return fail(e.message); }
    case "fill": try { const r = await callExtension(ctl, "fill", { ref: p.ref, value: p.value }); logAction({ tab_url: r?.url, tool: "fill", ref: p.ref, value: p.value, ok: true }); return ok(`Filled [${p.ref}] with ${JSON.stringify(p.value)}.${noteUrl(ctl, r?.url)}`); } catch (e: any) { logAction({ tool: "fill", ref: p.ref, value: p.value, ok: false, error: e.message }); return fail(e.message); }
    case "select": try { const r = await callExtension(ctl, "select", { ref: p.ref, value: p.value }); logAction({ tab_url: r?.url, tool: "select", ref: p.ref, value: p.value, ok: true }); return ok(`Selected "${r.selected}" in [${p.ref}].${noteUrl(ctl, r?.url)}`); } catch (e: any) { logAction({ tool: "select", ref: p.ref, value: p.value, ok: false, error: e.message }); return fail(e.message); }
    case "options": try { const r = await callExtension(ctl, "options", { ref: p.ref }); logAction({ tool: "options", ref: p.ref, ok: true }); return ok(r.options.join("\n")); } catch (e: any) { return fail(e.message); }
    case "read": try { const r = await callExtension(ctl, "read", { ref: p.ref }); logAction({ tab_url: r?.url, tool: "read", ref: p.ref, ok: true }); return ok(r.text ?? ""); } catch (e: any) { logAction({ tool: "read", ref: p.ref, ok: false, error: e.message }); return fail(e.message); }
    case "navigate": try { const r = await callExtension(ctl, "navigate", { url: p.url }); ctl.lastUrl = p.url; logAction({ tab_url: p.url, tool: "navigate", ok: true }); return ok(`Navigated to ${p.url}. Re-snapshot to see the page.${maybeAutoPin(ctl, r?.tabId)}`); } catch (e: any) { logAction({ tool: "navigate", ok: false, error: e.message }); return fail(e.message); }
    case "html": try {
      const r = await callExtension(ctl, "html", { ref: p.ref, clean: p.clean ?? true, up: p.up ?? 0, offset: p.offset ?? 0, maxBytes: p.maxBytes ?? 50_000 });
      const refuse = driftRefusal(ctl, "html", r?.url, prevMayNavigate);
      if (refuse) { logAction({ tab_url: r?.url, tool: "html", ok: false, error: "drift refused" }); return fail(refuse); }
      logAction({ tab_url: r?.url, tool: "html", ref: p.ref ?? null, ok: true });
      let header = `bytes ${r.offset}–${r.offset + r.returned} of ${r.total}`;
      header += maybeAutoPin(ctl, r?.tabId);
      if (r.truncated) header = `⚠ TRUNCATED — returned bytes ${r.offset}–${r.offset + r.returned} of ${r.total} total. This is NOT the whole element — page more with offset:${r.offset + r.returned}, or (better for list pages) use browser_snapshot / an extraction filter instead of raw HTML.\n` + header;
      return ok(`${header}${noteUrl(ctl, r?.url)}\n\n${r.html}`);
    } catch (e: any) { logAction({ tool: "html", ref: p.ref ?? null, ok: false, error: e.message }); return fail(e.message); }
    case "tabs": try { const r = await callExtension(ctl, "tabs"); const txt = r.tabs.map((t: any) => `[${t.tabId}]${t.active ? " *active" : ""}  ${t.title ?? ""}\n      ${t.url ?? ""}`).join("\n"); return ok(txt || "no tabs"); } catch (e: any) { return fail(e.message); }
    case "pin":
      if (p.tabId == null) {
        // Explicit unpin is a decision — don't quietly auto-pin again afterwards.
        ctl.pinnedTabId = null; ctl.autoPinned = false; ctl.noAutoPin = true; ctl.lastUrl = null;
        return ok("Unpinned — actions follow the active tab, and auto-pinning stays off for this session.");
      }
      ctl.pinnedTabId = p.tabId; ctl.autoPinned = false; ctl.noAutoPin = false; ctl.lastUrl = null;
      return ok(`Pinned to tab ${p.tabId}. Actions target it regardless of focus.`);
    case "press": try { const r = await callExtension(ctl, "press", { key: p.key, ref: p.ref }); logAction({ tab_url: r?.url, tool: "press", value: p.key, ref: p.ref ?? null, ok: true }); return ok(`Pressed ${p.key}.${noteUrl(ctl, r?.url)}`); } catch (e: any) { logAction({ tool: "press", value: p.key, ref: p.ref ?? null, ok: false, error: e.message }); return fail(e.message); }
    case "pick": try {
      const r = await callExtension(ctl, "pick", {}, 120_000);
      if (r?.cancelled) return ok("Pick cancelled (Esc).");
      logAction({ tab_url: r?.url, tool: "pick", value: r?.selector, ok: true });
      return ok(`Picked: ${r.selector}\nmatches: ${r.matchCount}× (${r.matchCount === 1 ? "container/root-like" : "repeating-item-like"})\ntag: ${r.tag}\ntext: ${JSON.stringify(r.text)}`);
    } catch (e: any) { logAction({ tool: "pick", ok: false, error: e.message }); return fail(e.message); }
    case "save_filter": try { const stored = upsertFilter({ name: p.name, match: p.match, root: p.root, drop: p.drop, dropText: p.dropText, extract: p.extract }); logAction({ tool: "save_filter", value: p.name, ok: true }); return ok(`Saved filter '${p.name}' (v${stored.version}) for ${p.match}. It now auto-applies on matching pages.`); } catch (e: any) { logAction({ tool: "save_filter", value: p.name, ok: false, error: e.message }); return fail(e.message); }
    case "list_filters": { const fs = listFilters(); return ok(fs.length ? fs.map((f) => `• ${f.name}  →  ${f.match}\n    root=${f.root ?? "—"}  drop=${f.drop?.length ?? 0}  dropText=${f.dropText?.length ?? 0}`).join("\n") : "No filters saved yet."); }
    case "delete_filter": { const okd = deleteFilter(p.name); logAction({ tool: "delete_filter", value: p.name, ok: okd }); return ok(okd ? `Deleted filter '${p.name}'.` : `No filter named '${p.name}'.`); }
    case "requests": try {
      const r = await callExtension(ctl, "requests", { filter: p.filter, limit: p.limit ?? 40, since: p.since, all: p.all ?? false, clear: p.clear ?? false });
      if (!r.requests.length) return ok(`No matching requests logged (${r.total} total${p.filter ? ` before filter '${p.filter}'` : ""}). Do the UI action first, then call again; the log keeps the last 300 XHR/fetch calls across tabs.`);
      const lines = r.requests.map((e: any) => {
        const age = Math.round((r.now - e.ts) / 1000);
        return `${e.method} ${e.url}\n    tab ${e.tabId} · ${age}s ago · ${e.status ?? "…"} ${e.mime ?? ""}${e.body ? `\n    body: ${e.body}` : ""}`;
      });
      return ok(`${r.requests.length} of ${r.total} requests (oldest first):\n${lines.join("\n")}`);
    } catch (e: any) { return fail(e.message); }
    case "fetch": try {
      const method = (p.method ?? "GET").toUpperCase();
      const r = await callExtension(ctl, "fetch", { url: p.url, headers: p.headers ?? {}, method, body: p.body }, 120_000);
      const buf = Buffer.from(r.bodyBase64 ?? "", "base64");
      const isText = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|.*\+(json|xml))/i.test(r.contentType ?? "");
      let head = `HTTP ${r.status} ${r.contentType || "(no content-type)"} ${buf.length} bytes` + (r.finalUrl && r.finalUrl !== p.url ? `\n→ ${r.finalUrl}` : "");
      if (p.saveTo) {
        const path = String(p.saveTo).replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
        await Bun.write(path, buf);
        logAction({ tab_url: p.url, tool: "fetch", value: path, ok: r.status < 400 });
        const preview = isText ? `\n--- first ${Math.min(buf.length, p.preview ?? 600)} bytes ---\n${buf.subarray(0, p.preview ?? 600).toString("utf8")}` : "";
        return (r.status < 400 ? ok : fail)(`${head}\nsaved → ${path}${preview}`);
      }
      logAction({ tab_url: p.url, tool: "fetch", ok: r.status < 400 });
      if (!isText) return fail(`${head}\nBinary body — call again with saveTo:"<path>" to write it to disk (then Read the file).`);
      const max = p.maxBytes ?? 50_000;
      const text = buf.subarray(0, max).toString("utf8");
      const trunc = buf.length > max ? `\n⚠ TRUNCATED at ${max} of ${buf.length} bytes — pass saveTo to get the whole body on disk.` : "";
      return (r.status < 400 ? ok : fail)(`${head}${trunc}\n${text}`);
    } catch (e: any) { logAction({ tool: "fetch", ok: false, error: e.message }); return fail(e.message); }

    // ── Jev-powered targeting (bridge/jev.ts holds the questions + thresholds) ──
    case "find": {
      const targets: string[] = Array.isArray(p.targets) ? p.targets.map(String).map((s: string) => s.trim()).filter(Boolean) : p.target ? [String(p.target).trim()] : [];
      if (!targets.length) return fail("find: pass `target` (one description) or `targets` (several, answered in one request).");
      const act: string = p.act ?? "none";
      if (act !== "none" && targets.length > 1) return fail("find: `act` works with a single `target`; with `targets` you get shortlists only.");
      if (act === "fill" && typeof p.value !== "string") return fail("find: act:'fill' needs `value`.");
      try {
        // Interactive-only state first (half the tokens → half the latency); one
        // retry with page text when nothing matched, since some targets are
        // described by nearby text rather than the control's own name.
        let snap = await jevSnapshot(ctl, false);
        const refuse = driftRefusal(ctl, "snapshot", snap.url, prevMayNavigate);
        if (refuse) { logAction({ tab_url: snap.url, tool: "find", value: targets.join(" | "), ok: false, error: "drift refused" }); return fail(refuse); }
        let results = await findMany({ targets, url: snap.url, title: snap.title, tree: snap.tree });
        let retried = false;
        if (results.every((r) => r.exists < THRESHOLDS.exists)) {
          snap = await jevSnapshot(ctl, true);
          const again = await findMany({ targets, url: snap.url, title: snap.title, tree: snap.tree });
          again[0].inputTokens += results[0].inputTokens; again[0].requests += results[0].requests;
          results = again; retried = true;
        }
        const tok = results[0].inputTokens, reqs = results[0].requests, model = results[0].model;
        let header = `URL: ${snap.url}\nJev: ${results[0].candidates} candidates, ${reqs} request${reqs === 1 ? "" : "s"}, ${tok} tok (${model})${retried ? ", retried with page text" : ""}`;
        header += maybeAutoPin(ctl, snap.tabId) + noteUrl(ctl, snap.url);
        const detail: any = { targets, results: results.map((r) => ({ target: r.target, exists: r.exists, confidence: r.confidence, top: r.ranked.slice(0, 3) })), tokens: tok, requests: reqs, model, retried };

        if (targets.length > 1) {
          const blocks = results.map((r) => r.exists < THRESHOLDS.exists
            ? `${JSON.stringify(r.target)}: nothing matches (exists ${pct(r.exists)}); closest ${r.ranked[0] ? `[${r.ranked[0].ref}] ${JSON.stringify(r.ranked[0].name)} ${pct(r.ranked[0].p)}` : "—"}`
            : `${JSON.stringify(r.target)} → [${r.ranked[0].ref}] ${r.ranked[0].role} ${JSON.stringify(r.ranked[0].name)}  ${pct(r.ranked[0].p)}, conf ${r.confidence.toFixed(2)}${r.ranked[1] ? `  (then [${r.ranked[1].ref}] ${pct(r.ranked[1].p)})` : ""}`);
          logAction({ tab_url: snap.url, tool: "find", value: targets.join(" | "), ok: true, element_count: results[0].candidates, detail: { ...detail, outcome: "multi" } });
          return ok(`${header}\n${blocks.join("\n")}\nAct with browser_click / browser_fill on those refs (same snapshot, refs are live until the DOM changes).`);
        }

        const r = results[0]; const target = r.target; const top = r.ranked[0];
        if (!top || r.exists < THRESHOLDS.exists) {
          logAction({ tab_url: snap.url, tool: "find", value: target, ok: false, error: "no match", element_count: r.candidates, detail: { ...detail, outcome: "no-match" } });
          return fail(`${header}\nNothing on this page matches ${JSON.stringify(target)} (exists ${pct(r.exists)}). Closest guesses:\n${formatShortlist(r.ranked)}\nUse browser_snapshot to look yourself, or rephrase the target.`);
        }
        header += `\nexists ${pct(r.exists)}, confidence ${r.confidence.toFixed(2)}`;
        const [href] = await Promise.all([hrefOf(ctl, top)]);
        const hrefLine = href ? `\n  → ${href}   (browser_navigate here to skip the click)` : "";
        if (act === "none") {
          logAction({ tab_url: snap.url, tool: "find", ref: top.ref, value: target, ok: true, element_count: r.candidates, detail: { ...detail, outcome: "shortlist" } });
          return ok(`${header}\nBest match for ${JSON.stringify(target)}:\n${formatShortlist(r.ranked)}${hrefLine}\nbrowser_click({ref:${top.ref}}) to act, or pass act:"click" next time.`);
        }
        if (r.confidence < THRESHOLDS.actConfidence) {
          logAction({ tab_url: snap.url, tool: "find", value: target, ok: true, element_count: r.candidates, detail: { ...detail, outcome: `shortlist:low-confidence:${act}` } });
          return ok(`${header}\nNot acting: confidence ${r.confidence.toFixed(2)} < ${THRESHOLDS.actConfidence}. Pick one yourself:\n${formatShortlist(r.ranked)}${hrefLine}`);
        }
        if (act === "fill") {
          const f = await callExtension(ctl, "fill", { ref: top.ref, value: p.value });
          ctl.lastOpMayNavigate = true;
          logAction({ tab_url: snap.url, tool: "find", ref: top.ref, value: target, ok: true, element_count: r.candidates, detail: { ...detail, outcome: "filled", fillValue: p.value } });
          return ok(`${header}\nFilled [${top.ref}] ${top.role} ${JSON.stringify(top.name)} (${pct(top.p)}) with ${JSON.stringify(p.value)}.${noteUrl(ctl, f?.url)}\nRunner-up: ${r.ranked[1] ? `[${r.ranked[1].ref}] ${JSON.stringify(r.ranked[1].name)} ${pct(r.ranked[1].p)}` : "none"}.`);
        }
        const { g, asked } = await maybeGuard(top, target, snap.url);
        if (g >= THRESHOLDS.guard) {
          logAction({ tab_url: snap.url, tool: "find", value: target, ok: true, element_count: r.candidates, detail: { ...detail, guard: g, outcome: "refused:guard" } });
          return ok(`${header}\nRefusing to click [${top.ref}] ${top.role} ${JSON.stringify(top.name)}: it may be irreversible (guard ${pct(g)}). Click it explicitly with browser_click if intended.\n${formatShortlist(r.ranked)}${hrefLine}`);
        }
        const c = await settledClick(ctl, top.ref);
        logAction({ tab_url: snap.url, tool: "find", ref: top.ref, value: target, ok: true, element_count: r.candidates, detail: { ...detail, guard: asked ? g : "skipped", outcome: "clicked", settled: c?.settled } });
        return ok(`${header}\nClicked [${top.ref}] ${top.role} ${JSON.stringify(top.name)} (${pct(top.p)}${asked ? `, guard ${pct(g)}` : ""}).${fmtSettle(c)}${noteUrl(ctl, c?.url)}\nRunner-ups: ${r.ranked.slice(1, 3).map((x) => `[${x.ref}] ${JSON.stringify(x.name)} ${pct(x.p)}`).join(", ") || "none"}. browser_find again for the next step.`);
      } catch (e: any) { logAction({ tool: "find", value: targets.join(" | "), ok: false, error: e.message }); return fail(e.message); }
    }
    case "pursue": {
      const goal = String(p.goal ?? "").trim();
      const maxSteps = Math.min(Math.max(Number(p.maxSteps ?? 6), 1), 12);
      if (!goal) return fail("pursue: `goal` is required.");
      const trail: string[] = [];
      let tokens = 0, jevMs = 0, settleMs = 0;
      const t0 = performance.now();
      const done = async (verdict: string, url: string, tabId?: number) => {
        let tail = "";
        if (p.finalSnapshot) {
          try { const s = await callExtension(ctl, "snapshot", { interactiveOnly: true, filters: listFilters(), chrome: true, collapse: true, dedup: true }); tail = `\n\nFinal page (interactive only, ${s.count} refs):\n${s.tree}`; } catch {}
        }
        const total = Math.round(performance.now() - t0);
        logAction({ tab_url: url, tool: "pursue", value: goal, ok: true, element_count: trail.length, detail: { goal, verdict, trail, tokens, ms: { total, jev: jevMs, settle: settleMs } } });
        return ok(`${verdict}\nURL: ${url}\nTrail (${trail.length} step${trail.length === 1 ? "" : "s"}; ${total} ms total, Jev ${Math.round(jevMs)} ms, page settle ${settleMs} ms, ${tokens} Jev tokens):\n${trail.map((t, i) => `  ${i + 1}. ${t}`).join("\n") || "  (none)"}${maybeAutoPin(ctl, tabId)}${tail}${p.finalSnapshot ? "" : "\nbrowser_find / browser_snapshot to continue (pass finalSnapshot:true to get the page inline)."}`);
      };
      try {
        let lastClick: any = null;
        for (let step = 1; step <= maxSteps; step++) {
          const snap = await jevSnapshot(ctl, true); // text needed for the `reached` verdict
          const tj = performance.now();
          const r = await findTarget({ target: goal, url: snap.url, title: snap.title, tree: snap.tree, pursue: true });
          jevMs += performance.now() - tj; tokens += r.inputTokens;
          const top = r.ranked[0];
          if ((r.reached ?? 0) >= THRESHOLDS.reached) return done(`Goal reached (${pct(r.reached!)}) after ${step - 1} click${step === 2 ? "" : "s"}.`, snap.url, snap.tabId);
          if ((r.blocked ?? 0) >= THRESHOLDS.blocked) return done(`Stopped: this page needs a human step (login/CAPTCHA/consent, ${pct(r.blocked!)}).`, snap.url, snap.tabId);
          if (!top || r.exists < THRESHOLDS.exists || r.confidence < THRESHOLDS.stuck)
            return done(`Stuck: no confident next step toward ${JSON.stringify(goal)} (exists ${pct(r.exists)}, confidence ${r.confidence.toFixed(2)}). Candidates:\n${formatShortlist(r.ranked)}`, snap.url, snap.tabId);
          const tg = performance.now();
          const { g, asked } = await maybeGuard(top, goal, snap.url);
          jevMs += performance.now() - tg;
          if (g >= THRESHOLDS.guard) return done(`Refusing to click [${top.ref}] ${top.role} ${JSON.stringify(top.name)}: may be irreversible (guard ${pct(g)}). Do it explicitly with browser_click if intended.`, snap.url, snap.tabId);
          lastClick = await settledClick(ctl, top.ref);
          settleMs += lastClick?.settled?.settledMs ?? 0;
          trail.push(`[${top.ref}] ${top.role} ${JSON.stringify(top.name)} (${pct(top.p)}, conf ${r.confidence.toFixed(2)}${asked ? `, guard ${pct(g)}` : ""}, willReach ${pct(r.willReach ?? 0)}) @ ${snap.url}${fmtSettle(lastClick)}`);
          // Speculative: Jev already judged that this click lands on the goal → skip the confirming snapshot+Jev round trip.
          if ((r.willReach ?? 0) >= THRESHOLDS.willReach) return done(`Goal reached (predicted ${pct(r.willReach!)} before the click) after ${step} click${step === 1 ? "" : "s"}.`, lastClick?.url ?? snap.url, snap.tabId);
        }
        const last = await jevSnapshot(ctl, false).catch(() => null);
        return done(`Step limit (${maxSteps}) reached without a confident "goal reached" verdict.`, last?.url ?? lastClick?.url ?? ctl.lastUrl ?? "?", last?.tabId);
      } catch (e: any) { logAction({ tool: "pursue", value: goal, ok: false, error: e.message, detail: { goal, trail, tokens } }); return fail(`${e.message}\nTrail so far:\n${trail.map((t, i) => `  ${i + 1}. ${t}`).join("\n")}`); }
    }
    default: return fail(`Unknown op '${op}'`);
  }
}

// ── --stop: ask a running hub to exit ─────────────────────────────────────────
if (process.argv.includes("--stop")) {
  const sock = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
  sock.onopen = () => { sock.send(JSON.stringify({ type: "shutdown" })); setTimeout(() => process.exit(0), 200); };
  sock.onerror = () => { console.error("[hub] no hub running"); process.exit(0); };
} else {
  try {
    Bun.serve<SockData>({
      port: WS_PORT,
      fetch(req, server) { if (server.upgrade(req, { data: { role: null, key: null, ctl: null } })) return; return new Response("browsteer hub", { status: 200 }); },
      websocket: {
        message(ws, raw) {
          let msg: any; try { msg = JSON.parse(String(raw)); } catch { return; }
          if (msg.type === "shutdown") { console.error("[hub] shutdown requested"); process.exit(0); }
          if (msg.type === "register" && typeof msg.key === "string") { ws.data.role = "extension"; ws.data.key = msg.key; browsers.set(msg.key, ws); console.error(`[hub] browser registered: ${msg.key}`); return; }
          if (msg.type === "hello" && msg.role === "control") { ws.data.role = "control"; ws.data.ctl = newController(); console.error("[hub] controller connected"); return; }
          if (ws.data.role === "extension") { const pr = pending.get(msg.id); if (!pr) return; clearTimeout(pr.timer); pending.delete(msg.id); if (msg.ok) pr.resolve(msg.result); else pr.reject(new Error(msg.error ?? "unknown extension error")); return; }
          if (ws.data.role === "control" && typeof msg.op === "string") { execOp(ws.data.ctl!, msg.op, msg.params ?? {}).then((r) => { try { ws.send(JSON.stringify({ id: msg.id, ok: !r.isError, text: r.text })); } catch {} }); return; }
        },
        close(ws) {
          if (ws.data.role === "extension" && ws.data.key && browsers.get(ws.data.key) === ws) { browsers.delete(ws.data.key); console.error(`[hub] browser disconnected: ${ws.data.key}`); }
        },
      },
    });
    console.error(`[hub] listening on ws://127.0.0.1:${WS_PORT}`);
    warm().then(() => console.error("[hub] jev connection warm")); // first find should not pay the TLS handshake
  } catch {
    console.error(`[hub] port ${WS_PORT} busy — another hub is running; exiting.`);
    process.exit(0);
  }
}
