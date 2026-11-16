// Background — owns the WebSocket link to the local bridge, registers this
// browser under its pairing key, and relays each op to the active tab.
//
//   bridge (ws) ──▶ background ──(tabs.sendMessage)──▶ content script ──▶ result
//
// Runs as an event page in Firefox and as a service worker in Chrome. Both can
// be suspended when idle, so nothing here relies on state surviving a restart
// except the pairing key (storage) — the link is simply re-established.
import { ext, isFirefox } from "./ext";

const BRIDGE_URL = "ws://127.0.0.1:8787";
let ws: WebSocket | null = null;

function log(...a: unknown[]) {
  console.log("[browsteer]", ...a);
}

// Observable connection state on the toolbar icon (no devtools needed).
function setBadge(state: "on" | "off" | "boot") {
  try {
    ext.action.setBadgeText({ text: state === "on" ? "✓" : state === "off" ? "×" : "…" });
    ext.action.setBadgeBackgroundColor({ color: state === "on" ? "#0b8f63" : "#56667a" });
  } catch {}
}
setBadge("boot");

// ── Pairing key: generated once, persisted, shown in the popup ────────────────
function genKey(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alikes
  const grp = (n: number) =>
    Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  return `bst-${grp(4)}-${grp(4)}`;
}

async function getKey(): Promise<string> {
  const { bridgeKey } = await ext.storage.local.get("bridgeKey");
  if (typeof bridgeKey === "string" && bridgeKey) return bridgeKey;
  const k = genKey();
  await ext.storage.local.set({ bridgeKey: k });
  return k;
}

async function regenerateKey(): Promise<string> {
  const k = genKey();
  await ext.storage.local.set({ bridgeKey: k });
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "register", key: k }));
  return k;
}

// ── Request log ──────────────────────────────────────────────────────────────
// Ring buffer of the XHR/fetch traffic pages make, so a caller can see exactly
// which API call a UI action fired (URL, method, query, POST body) and replay
// it with `fetch` — instead of asking the user to dig it out of DevTools.
type ReqEntry = { id: string; tabId: number; ts: number; method: string; url: string; type: string; body?: string; status?: number; mime?: string };
const REQ_MAX = 300;
const reqLog: ReqEntry[] = [];
const reqById = new Map<string, ReqEntry>();
function decodeBody(details: any): string | undefined {
  const rb = details.requestBody;
  if (!rb) return undefined;
  if (rb.formData) return JSON.stringify(rb.formData).slice(0, 4000);
  const raw = rb.raw?.[0]?.bytes;
  if (!raw) return undefined;
  try { return new TextDecoder().decode(new Uint8Array(raw)).slice(0, 4000); } catch { return `<${raw.byteLength} bytes>`; }
}
try {
  ext.webRequest.onBeforeRequest.addListener(
    (d: any) => {
      if (d.tabId < 0) return;
      const e: ReqEntry = { id: d.requestId, tabId: d.tabId, ts: d.timeStamp, method: d.method, url: d.url, type: d.type, body: decodeBody(d) };
      reqLog.push(e); reqById.set(e.id, e);
      while (reqLog.length > REQ_MAX) { const old = reqLog.shift(); if (old) reqById.delete(old.id); }
    },
    { urls: ["<all_urls>"], types: ["xmlhttprequest", "main_frame", "sub_frame"] },
    ["requestBody"],
  );
  ext.webRequest.onCompleted.addListener(
    (d: any) => { const e = reqById.get(d.requestId); if (e) { e.status = d.statusCode; e.mime = (d.responseHeaders ?? []).find((h: any) => h.name.toLowerCase() === "content-type")?.value; } },
    { urls: ["<all_urls>"] },
    ["responseHeaders"],
  );
} catch (e) { log("webRequest unavailable", e); }

// ── Tab lookup ────────────────────────────────────────────────────────────────
async function activeTabId(): Promise<number> {
  let [tab] = await ext.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab to drive.");
  return tab.id;
}

// Honor a pinned tab id (params.tabId) when present and still open; else active.
async function targetTabId(params: any): Promise<number> {
  if (params?.tabId != null) {
    try {
      const t = await ext.tabs.get(params.tabId);
      if (t?.id != null) return t.id;
    } catch {
      throw new Error(`Pinned tab ${params.tabId} is gone. Re-pin with browser_tabs + browser_pin.`);
    }
  }
  return activeTabId();
}

// No content script answered. Say why in terms Claude can act on, instead of the
// browser's "Receiving end does not exist".
async function unreachableTab(tabId: number, cause: any): Promise<string> {
  let url = "";
  try { url = (await ext.tabs.get(tabId)).url ?? ""; } catch {}
  if (/^(about|chrome|edge|brave|moz-extension|chrome-extension|view-source|devtools):/.test(url) || /^https:\/\/(chromewebstore\.google\.com|addons\.mozilla\.org)\//.test(url)) {
    return `This tab (${url}) is a browser page that extensions cannot read. Switch to a normal web page, or browser_navigate to one.`;
  }
  if (!/Receiving end does not exist|Could not establish connection/i.test(String(cause?.message ?? cause))) return String(cause?.message ?? cause);
  return `The page in this tab (${url || "unknown"}) has not loaded Browsteer yet — it was open before the extension was installed or updated, or is still loading. Reload the tab (browser_navigate to its URL) and try again.`;
}

// ── WebSocket link ────────────────────────────────────────────────────────────
// Retry quickly at first (the bridge usually starts seconds after the browser),
// then back off so an absent bridge costs one quiet attempt every 15 s.
const RETRY_MS = [1000, 2000, 5000, 15000];
let attempt = 0;
let pingTimer: ReturnType<typeof setInterval> | null = null;

function connect() {
  log("connecting to", BRIDGE_URL);
  ws = new WebSocket(BRIDGE_URL);

  ws.onopen = async () => {
    attempt = 0;
    const key = await getKey();
    ws?.send(JSON.stringify({ type: "register", key }));
    log("connected & registered as", key);
    setBadge("on");
    // Chrome suspends a service worker after 30 s without events, which would
    // drop the link mid-session; socket traffic counts as activity (Chrome 116+).
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}'); }, 20_000);
  };

  ws.onmessage = async (ev) => {
    let req: { id: string; op: string; params: any };
    try {
      req = JSON.parse(ev.data);
    } catch {
      return;
    }
    try {
      // browser-level ops (no content script needed)
      if (req.op === "tabs") {
        const tabs = await ext.tabs.query({});
        const list = tabs.map((t) => ({ tabId: t.id, title: t.title, url: t.url, active: t.active }));
        ws?.send(JSON.stringify({ id: req.id, ok: true, result: { tabs: list } }));
        return;
      }
      // fetch: GET a URL from the extension context — sends the user's cookies,
      // so authenticated JSON/PDF endpoints that content scripts and the terminal
      // can't reach (JSON viewer, pdf.js, TCC-protected cookie jar) come back as
      // raw bytes. Base64 keeps binary intact over the JSON websocket.
      if (req.op === "requests") {
        const p = req.params ?? {};
        let list = reqLog.filter((e) => e.type === "xmlhttprequest" || p.all);
        if (p.tabId != null) list = list.filter((e) => e.tabId === p.tabId);
        if (p.filter) { const re = new RegExp(String(p.filter), "i"); list = list.filter((e) => re.test(e.url)); }
        if (p.since) list = list.filter((e) => e.ts >= p.since);
        const out = list.slice(-(p.limit ?? 40));
        if (p.clear) { reqLog.length = 0; reqById.clear(); }
        ws?.send(JSON.stringify({ id: req.id, ok: true, result: { requests: out, total: list.length, now: Date.now() } }));
        return;
      }
      if (req.op === "fetch" && req.params?.fromPage) req.op = "pageFetch"; // run in the tab, as the page
      if (req.op === "fetch") {
        const method = String(req.params.method ?? "GET").toUpperCase();
        const res = await fetch(String(req.params.url), {
          method,
          credentials: "include",
          headers: req.params.headers ?? {},
          body: method === "GET" || method === "HEAD" ? undefined : req.params.body,
          redirect: "follow",
        });
        const bytes = new Uint8Array(await res.arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
        ws?.send(JSON.stringify({
          id: req.id, ok: true,
          result: { status: res.status, contentType: res.headers.get("content-type") ?? "", finalUrl: res.url, size: bytes.length, bodyBase64: btoa(bin) },
        }));
        return;
      }
      const tabId = await targetTabId(req.params);
      if (req.op === "navigate") {
        await ext.tabs.update(tabId, { url: req.params.url });
        ws?.send(JSON.stringify({ id: req.id, ok: true, result: { url: req.params.url, tabId } }));
        return;
      }
      let resp: any;
      try {
        resp = await ext.tabs.sendMessage(tabId, { op: req.op, params: req.params });
      } catch (e: any) {
        throw new Error(await unreachableTab(tabId, e));
      }
      // Tell the hub which tab actually served this op, so it can auto-pin and
      // detect drift instead of silently answering about a different page.
      if (resp?.ok && resp.result && typeof resp.result === "object") resp.result.tabId = tabId;
      ws?.send(JSON.stringify({ id: req.id, ...resp }));
    } catch (e: any) {
      ws?.send(JSON.stringify({ id: req.id, ok: false, error: String(e?.message ?? e) }));
    }
  };

  ws.onclose = () => {
    const wait = RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)];
    log(`bridge not reachable — next attempt in ${wait / 1000}s`);
    setBadge("off");
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    ws = null;
    setTimeout(ensureConnected, wait);
  };
  ws.onerror = (e) => {
    log("ws error", e);
    ws?.close();
  };
}

function ensureConnected() {
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) connect();
}

// MV3 keepalive: the background can be suspended when idle, killing the retry
// timer. An alarm wakes it so the link self-heals after the bridge (re)starts.
// Chrome enforces a 30 s minimum period; Firefox accepts 15 s.
ext.alarms.create("keepalive", { periodInMinutes: isFirefox ? 0.25 : 0.5 });
ext.alarms.onAlarm.addListener((a) => {
  if (a.name === "keepalive") ensureConnected();
});

log("background loaded");

// First run: open the setup page (start the bridge, pair, what is shared).
ext.runtime.onInstalled.addListener((d) => {
  if (d.reason === "install") ext.tabs.create({ url: ext.runtime.getURL("welcome.html") });
});

// ── Popup channel ─────────────────────────────────────────────────────────────
ext.runtime.onMessage.addListener((msg: any, _sender: unknown, send: (r: unknown) => void) => {
  if (msg?.type === "getStatus") {
    getKey().then((key) => send({ key, connected: ws?.readyState === WebSocket.OPEN }));
    return true; // async response
  }
  if (msg?.type === "regenerate") {
    regenerateKey().then((key) => send({ key }));
    return true;
  }
  if (msg?.type === "startPick") {
    activeTabId()
      .then((id) => ext.tabs.sendMessage(id, { op: "pick", params: {} }))
      .catch(() => {});
    send({ ok: true });
    return true;
  }
  return false;
});

ensureConnected();
