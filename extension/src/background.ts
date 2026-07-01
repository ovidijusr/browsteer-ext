// Background event page — owns the WebSocket link to the local bridge, registers
// this browser under its pairing key, and relays each op to the active tab.
//
//   bridge (ws) ──▶ background ──(tabs.sendMessage)──▶ content script ──▶ result
//
// `browser` is the global from @types/firefox-webext-browser.

const BRIDGE_URL = "ws://127.0.0.1:8787";
let ws: WebSocket | null = null;

function log(...a: unknown[]) {
  console.log("[browsteer]", ...a);
}

// Observable connection state on the toolbar icon (no devtools needed).
function setBadge(state: "on" | "off" | "boot") {
  try {
    browser.action.setBadgeText({ text: state === "on" ? "✓" : state === "off" ? "×" : "…" });
    browser.action.setBadgeBackgroundColor({ color: state === "on" ? "#16a34a" : "#9ca3af" });
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
  const { bridgeKey } = await browser.storage.local.get("bridgeKey");
  if (typeof bridgeKey === "string" && bridgeKey) return bridgeKey;
  const k = genKey();
  await browser.storage.local.set({ bridgeKey: k });
  return k;
}

async function regenerateKey(): Promise<string> {
  const k = genKey();
  await browser.storage.local.set({ bridgeKey: k });
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "register", key: k }));
  return k;
}

// ── Tab lookup ────────────────────────────────────────────────────────────────
async function activeTabId(): Promise<number> {
  let [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab to drive.");
  return tab.id;
}

// Honor a pinned tab id (params.tabId) when present and still open; else active.
async function targetTabId(params: any): Promise<number> {
  if (params?.tabId != null) {
    try {
      const t = await browser.tabs.get(params.tabId);
      if (t?.id != null) return t.id;
    } catch {
      throw new Error(`Pinned tab ${params.tabId} is gone. Re-pin with browser_tabs + browser_pin.`);
    }
  }
  return activeTabId();
}

// ── WebSocket link ────────────────────────────────────────────────────────────
function connect() {
  log("connecting to", BRIDGE_URL);
  ws = new WebSocket(BRIDGE_URL);

  ws.onopen = async () => {
    const key = await getKey();
    ws?.send(JSON.stringify({ type: "register", key }));
    log("connected & registered as", key);
    setBadge("on");
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
        const tabs = await browser.tabs.query({});
        const list = tabs.map((t) => ({ tabId: t.id, title: t.title, url: t.url, active: t.active }));
        ws?.send(JSON.stringify({ id: req.id, ok: true, result: { tabs: list } }));
        return;
      }
      const tabId = await targetTabId(req.params);
      if (req.op === "navigate") {
        await browser.tabs.update(tabId, { url: req.params.url });
        ws?.send(JSON.stringify({ id: req.id, ok: true, result: { url: req.params.url } }));
        return;
      }
      const resp: any = await browser.tabs.sendMessage(tabId, { op: req.op, params: req.params });
      ws?.send(JSON.stringify({ id: req.id, ...resp }));
    } catch (e: any) {
      ws?.send(JSON.stringify({ id: req.id, ok: false, error: String(e?.message ?? e) }));
    }
  };

  ws.onclose = () => {
    log("ws closed — retrying in 1s");
    setBadge("off");
    ws = null;
    setTimeout(connect, 1000);
  };
  ws.onerror = (e) => {
    log("ws error", e);
    ws?.close();
  };
}

function ensureConnected() {
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) connect();
}

// MV3 keepalive: the event page can be suspended when idle, killing the retry
// timer. An alarm wakes it so the link self-heals after the bridge (re)starts.
browser.alarms.create("keepalive", { periodInMinutes: 0.25 });
browser.alarms.onAlarm.addListener((a) => {
  if (a.name === "keepalive") ensureConnected();
});

log("background loaded");

// ── Popup channel ─────────────────────────────────────────────────────────────
browser.runtime.onMessage.addListener((msg: any, _sender: unknown, send: (r: unknown) => void) => {
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
      .then((id) => browser.tabs.sendMessage(id, { op: "pick", params: {} }))
      .catch(() => {});
    send({ ok: true });
    return true;
  }
  return false;
});

connect();
