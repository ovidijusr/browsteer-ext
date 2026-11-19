// Integration tests for the hub's targeting behaviour — auto-pin and the
// drift refusal — with a FAKE extension socket, so no Firefox is needed:
//   bun test test/hub.test.ts
//
// The fake extension answers ops with canned results, including the tabId that
// background.ts now reports, which is what auto-pin and drift detection key off.
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8791 + Math.floor(Math.random() * 60);
const KEY = "bst-test-hub1-0001";
const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const wsUrl = () => `ws://127.0.0.1:${PORT}`;
/** The extension always connects with its Origin; local programs send none. */
const asExtension = (origin = EXT_ORIGIN) => new WebSocket(wsUrl(), { headers: { Origin: origin } } as any);
const token = () => readFileSync(join(DB_DIR, "token"), "utf8").trim();
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DB_DIR = mkdtempSync(join(tmpdir(), "browsteer-test-"));

let hub: ReturnType<typeof Bun.spawn>;
let ext: WebSocket;
let ctl: WebSocket;

/** What the fake extension should answer with next, per op. */
const canned: Record<string, any> = {};
/** Messages the hub sent the fake extension on its own ({type: "registered"}, {type: "jev"}). */
const notes: any[] = [];
const KEY_FILE = () => join(DB_DIR, "typesafe.env");
const seenOps: { op: string; params: any }[] = [];

const pending = new Map<string, (m: any) => void>();
let seq = 0;

function ask(op: string, params: Record<string, unknown> = {}): Promise<{ ok: boolean; text: string }> {
  const id = `t-${++seq}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ctl.send(JSON.stringify({ id, op, params }));
  });
}

async function waitOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws error"));
  });
}

beforeAll(async () => {
  // No Jev switch or API key from the machine running the tests: the key file is a temp one.
  const env: Record<string, string | undefined> = { ...process.env, BRIDGE_PORT: String(PORT), BROWSTEER_DB_DIR: DB_DIR, TYPESAFE_ENV_FILE: KEY_FILE() };
  delete env.BROWSTEER_JEV;
  delete env.TYPESAFE_API_KEY;
  hub = Bun.spawn(["bun", "run", "bridge/hub.ts"], {
    cwd: ROOT,
    env,
    stdout: "ignore",
    stderr: "ignore",
  });

  // Wait for the port to answer.
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}`);
      if (r.ok) break;
    } catch { await Bun.sleep(100); }
  }

  ext = asExtension();
  await waitOpen(ext);
  ext.onmessage = (ev) => {
    const req = JSON.parse(String(ev.data));
    if (req.type) { notes.push(req); return; }
    seenOps.push({ op: req.op, params: req.params });
    const result = canned[req.op] ?? { url: "https://example.com/", tabId: 7 };
    ext.send(JSON.stringify({ id: req.id, ok: true, result }));
  };
  ext.send(JSON.stringify({ type: "register", key: KEY }));

  ctl = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await waitOpen(ctl);
  ctl.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  };
  ctl.send(JSON.stringify({ type: "hello", role: "control", token: token() }));
  await Bun.sleep(150);

  expect((await ask("pair", { key: KEY })).text).toContain("Paired");
  // The browser hears that a session paired (the setup guide waits for it).
  await Bun.sleep(50);
  expect(notes.some((n) => n.type === "paired")).toBe(true);
});

afterAll(() => {
  try { ctl?.close(); ext?.close(); } catch {}
  try { hub?.kill(); } catch {}
  try { rmSync(DB_DIR, { recursive: true, force: true }); } catch {}
});

const snapResult = (url: string, tabId: number) => ({
  url, tabId, count: 3, tree: 'region\n  [1] button "Go"',
  applied: null, dropped: { subtrees: 0, textLines: 0 },
  chrome: 0, collapsed: 0, deduped: 0,
});

describe("auto-pin", () => {
  test("the first snapshot pins to the tab that served it and says so", async () => {
    canned.snapshot = snapResult("https://a.example/one", 42);
    const r = await ask("snapshot");
    expect(r.ok).toBe(true);
    expect(r.text).toContain("auto-pinned to tab 42");
  });

  test("once pinned, later ops carry the tabId to the extension", async () => {
    seenOps.length = 0;
    canned.snapshot = snapResult("https://a.example/one", 42);
    await ask("snapshot");
    expect(seenOps[0].params.tabId).toBe(42);
  });

  test("it only announces the pin once", async () => {
    canned.snapshot = snapResult("https://a.example/one", 42);
    const r = await ask("snapshot");
    expect(r.text).not.toContain("auto-pinned");
  });

  test("reduction counts are reported in the header", async () => {
    canned.snapshot = { ...snapResult("https://a.example/one", 42), collapsed: 30, deduped: 19, chrome: 2 };
    const r = await ask("snapshot");
    expect(r.text).toContain("Reduced: collapsed 30, deduped 19, chrome 2 regions");
    expect(r.text).toContain("raw:true");
  });
});

describe("drift refusal", () => {
  test("an explicit unpin turns auto-pinning off for the session", async () => {
    const r = await ask("pin", {});
    expect(r.text).toContain("auto-pinning stays off");
    canned.snapshot = snapResult("https://a.example/one", 42);
    const s = await ask("snapshot");
    expect(s.text).not.toContain("auto-pinned");
  });

  test("refuses the payload when an unpinned read lands on a different page", async () => {
    canned.snapshot = snapResult("https://a.example/DRIFTED", 99);
    const r = await ask("snapshot");
    expect(r.ok).toBe(false);
    expect(r.text).toContain("Refusing to return the snapshot");
    expect(r.text).toContain("https://a.example/one");
    expect(r.text).toContain("https://a.example/DRIFTED");
    // the wrong page's content is NOT in the response — that's the whole point
    expect(r.text).not.toContain('button "Go"');
  });

  test("a URL change right after a click is expected, not refused", async () => {
    await ask("pin", { tabId: 42 });           // clears state
    canned.snapshot = snapResult("https://a.example/one", 42);
    await ask("snapshot");
    await ask("pin", {});                       // unpin so the guard is live
    canned.snapshot = snapResult("https://a.example/one", 42);
    await ask("snapshot");

    canned.click = { url: "https://a.example/two", tabId: 42 };
    await ask("click", { ref: 1 });
    canned.snapshot = snapResult("https://a.example/two", 42);
    const r = await ask("snapshot");
    expect(r.ok).toBe(true);
    expect(r.text).toContain('button "Go"');
  });

  test("an explicit pin re-targets and clears the refusal", async () => {
    canned.snapshot = snapResult("https://a.example/three", 55);
    await ask("pin", { tabId: 55 });
    const r = await ask("snapshot");
    expect(r.ok).toBe(true);
  });
});

describe("browser_links", () => {
  test("formats label ⇢ url with the shared parts hoisted into the header", async () => {
    canned.links = {
      url: "https://a.example/list",
      tabId: 55,
      total: 3,
      scoped: false,
      prefix: "https://a.example/details?id=",
      suffix: "&ref=srp",
      links: [
        { text: "BMW i4 M50", url: "111" },
        { text: "BMW i4 eDrive40", url: "222" },
        { text: "BMW i4 eDrive35", url: "333" },
      ],
    };
    const r = await ask("links", {});
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Links: 3");
    expect(r.text).toContain('url = "https://a.example/details?id=" + <url> + "&ref=srp"');
    expect(r.text).toContain("BMW i4 M50 ⇢ 111");
  });

  test("reports the true total when a limit truncates", async () => {
    canned.links = {
      url: "https://a.example/list", tabId: 55, total: 137, scoped: false,
      prefix: "", suffix: "", links: [{ text: "one", url: "https://a.example/1" }],
    };
    const r = await ask("links", { limit: 1 });
    expect(r.text).toContain("Links: 1 of 137");
  });
});

describe("who may connect", () => {
  const probe = (origin?: string) =>
    fetch(`http://127.0.0.1:${PORT}`, { headers: origin ? { Origin: origin } : {} }).then((r) => r.status);

  test("a web page's origin is refused", async () => {
    expect(await probe("https://evil.example")).toBe(403);
    expect(await probe("http://localhost:3000")).toBe(403);
  });

  test("the extension and origin-less local clients are let in", async () => {
    expect(await probe("moz-extension://0b3c2d1e-aaaa-bbbb-cccc-000000000000")).toBe(200);
    expect(await probe("chrome-extension://abcdefghijklmnopabcdefghijklmnop")).toBe(200);
    expect(await probe()).toBe(200);
  });

  test("keep-alive pings from the extension are ignored, not answered", async () => {
    ext.send(JSON.stringify({ type: "ping" }));
    canned.links = { url: "https://a.example/", tabId: 55, total: 0, scoped: false, prefix: "", suffix: "", links: [] };
    expect((await ask("links", {})).ok).toBe(true);
  });
});

// The hub under test runs with no BROWSTEER_JEV and an empty config dir, i.e. the default.
describe("semantic targeting is off by default", () => {
  const page = (tree: string) => ({ ...snapResult("https://a.example/one", 42), tree });

  test("find still answers when the target names a control", async () => {
    canned.snapshot = page('region\n  [1] button "Go"\n  [2] link "Invoices"');
    const r = await ask("find", { target: "the Invoices link" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("lexical");
    expect(r.text).toContain("[2]");
  });

  test("find says so instead of calling out when nothing matches by name", async () => {
    canned.snapshot = page('region\n  [1] button "Go"\n  [2] link "Invoices"');
    const r = await ask("find", { target: "the thing that exports my data" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("Semantic targeting is off");
    expect(r.text).toContain("config.json");
  });

  test("pursue is unavailable and explains how to turn it on", async () => {
    const r = await ask("pursue", { goal: "open the invoices page" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("Semantic targeting is off");
  });

  test("a commitment-sounding control is not clicked without a judge", async () => {
    canned.snapshot = page('region\n  [1] button "Delete account"\n  [2] link "Invoices"');
    seenOps.length = 0;
    const r = await ask("find", { target: "the Delete account button", act: "click" });
    expect(seenOps.some((o) => o.op === "click")).toBe(false);
    expect(r.text).toMatch(/irreversible|browser_click/i);
  });
});

// Open a socket, send one message, report what the hub said back (or that it hung up).
async function knock(sock: WebSocket, first: object, then?: object): Promise<any> {
  await waitOpen(sock);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ silent: true }), 400);
    sock.onmessage = (ev) => { clearTimeout(t); resolve(JSON.parse(String(ev.data))); };
    sock.onclose = () => { clearTimeout(t); resolve({ closed: true }); };
    sock.send(JSON.stringify(first));
    if (then) setTimeout(() => { try { sock.send(JSON.stringify(then)); } catch {} }, 60);
  });
}

describe("authentication", () => {
  test("a controller without the token is turned away", async () => {
    const r = await knock(new WebSocket(wsUrl()), { type: "hello", role: "control" });
    expect(r.type).toBe("denied");
    const wrong = await knock(new WebSocket(wsUrl()), { type: "hello", role: "control", token: "0".repeat(64) });
    expect(wrong.type).toBe("denied");
  });

  test("shutdown needs the token too", async () => {
    const r = await knock(new WebSocket(wsUrl()), { type: "shutdown" });
    expect(r.type).toBe("denied");
    expect((await ask("list_filters", {})).ok).toBe(true); // still running
  });

  test("an extension cannot act as a controller, even with the token", async () => {
    const r = await knock(asExtension(), { type: "hello", role: "control", token: token() });
    expect(r.type).toBe("denied");
  });

  test("a local program cannot pose as a browser", async () => {
    const r = await knock(new WebSocket(wsUrl()), { type: "register", key: "bst-fake-fake-fake" });
    expect(r.type).toBe("denied");
  });

  test("a second, different extension is refused once the hub is bound to the first", async () => {
    const r = await knock(asExtension("chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"), { type: "register", key: "bst-rogu-rogu-rogu" });
    expect(r.type).toBe("denied");
    expect(r.reason).toContain("bound to another extension");
  });

  test("the bound extension is written to config.json", () => {
    expect(JSON.parse(readFileSync(join(DB_DIR, "config.json"), "utf8")).extensions).toEqual([EXT_ORIGIN]);
  });
});

describe("pairing is required", () => {
  test("an authenticated controller that has not paired gets no browser, and no list of keys", async () => {
    const c = new WebSocket(wsUrl());
    await waitOpen(c);
    c.send(JSON.stringify({ type: "hello", role: "control", token: token() }));
    await Bun.sleep(80);
    const snap: any = await new Promise((res) => { c.onmessage = (ev) => res(JSON.parse(String(ev.data))); c.send(JSON.stringify({ id: "x1", op: "snapshot", params: {} })); });
    expect(snap.ok).toBe(false);
    expect(snap.text).toContain("Not paired");
    const pair: any = await new Promise((res) => { c.onmessage = (ev) => res(JSON.parse(String(ev.data))); c.send(JSON.stringify({ id: "x2", op: "pair", params: { key: "bst-nope-nope-nope" } })); });
    expect(pair.ok).toBe(false);
    expect(pair.text).not.toContain(KEY);
    c.close();
  });
});

describe("site lock", () => {
  const on = (url: string) => ({ ...snapResult(url, 42) });

  test("a read on another site is refused and its content withheld", async () => {
    canned.snapshot = on("https://a.example/one");
    expect((await ask("snapshot", {})).ok).toBe(true);
    canned.snapshot = { ...on("https://mail.other.test/inbox"), tree: 'region\n  "SECRET INBOX TEXT"' };
    const r = await ask("snapshot", {});
    expect(r.ok).toBe(false);
    expect(r.text).toContain("locked to a.example");
    expect(r.text).not.toContain("SECRET INBOX TEXT");
  });

  test("navigating to another site is refused before it happens", async () => {
    seenOps.length = 0;
    const r = await ask("navigate", { url: "https://mail.other.test/compose" });
    expect(r.ok).toBe(false);
    expect(seenOps.some((o) => o.op === "navigate")).toBe(false);
  });

  test("the same site, including subdomains, keeps working", async () => {
    canned.snapshot = on("https://app.a.example/two");
    expect((await ask("snapshot", {})).ok).toBe(true);
  });

  test("the person can lift the lock from the popup", async () => {
    ext.send(JSON.stringify({ type: "unlock" }));
    await Bun.sleep(60);
    canned.snapshot = on("https://mail.other.test/inbox");
    expect((await ask("snapshot", {})).ok).toBe(true);
    // …and the session now belongs to the new site.
    canned.snapshot = on("https://a.example/one");
    expect((await ask("snapshot", {})).ok).toBe(false);
    ext.send(JSON.stringify({ type: "unlock" }));
    await Bun.sleep(60);
    expect((await ask("snapshot", {})).ok).toBe(true);
  });
});

describe("browser_fetch limits", () => {
  const body = { status: 200, contentType: "application/json", finalUrl: "https://a.example/api", size: 2, bodyBase64: btoa("{}") };

  test("reads on the session's site are allowed", async () => {
    canned.fetch = body;
    expect((await ask("fetch", { url: "https://a.example/api" })).ok).toBe(true);
  });

  test("other sites are refused without a request being made", async () => {
    seenOps.length = 0;
    const r = await ask("fetch", { url: "https://internal.other.test/admin" });
    expect(r.ok).toBe(false);
    expect(seenOps.some((o) => o.op === "fetch")).toBe(false);
  });

  test("anything but GET/HEAD is refused", async () => {
    seenOps.length = 0;
    const r = await ask("fetch", { url: "https://a.example/api", method: "POST", body: "{}" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("only reads");
    expect(seenOps.some((o) => o.op === "fetch")).toBe(false);
  });

  test("saveTo cannot leave the download folder", async () => {
    const r = await ask("fetch", { url: "https://a.example/api", saveTo: "~/.ssh/authorized_keys" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("must be inside");
  });
});

describe("review fixes", () => {
  const on = (url: string) => ({ ...snapResult(url, 42) });

  test("every request after the first carries the session's site for the extension to enforce", async () => {
    ext.send(JSON.stringify({ type: "unlock" })); await Bun.sleep(60);
    canned.snapshot = on("https://a.example/one");
    await ask("snapshot", {});
    seenOps.length = 0;
    canned.click = { url: "https://a.example/one", tabId: 42 };
    await ask("click", { ref: 1, settle: 0 });
    canned.requests = { requests: [], total: 0, now: Date.now() };
    await ask("requests", {});
    expect(seenOps.find((o) => o.op === "click")?.params.lockSite).toBe("a.example");
    expect(seenOps.find((o) => o.op === "requests")?.params.lockSite).toBe("a.example");
  });

  test("a fetch that ends on another site has its content discarded", async () => {
    canned.fetch = { status: 200, contentType: "application/json", finalUrl: "https://bank.other.test/api", size: 9, bodyBase64: btoa('{"iban":1}') };
    const r = await ask("fetch", { url: "https://a.example/redirect" });
    expect(r.ok).toBe(false);
    expect(r.text).not.toContain("iban");
  });

  test("fetch asks the extension not to follow redirects", async () => {
    seenOps.length = 0;
    canned.fetch = { status: 200, contentType: "text/plain", finalUrl: "https://a.example/x", size: 2, bodyBase64: btoa("ok") };
    await ask("fetch", { url: "https://a.example/x" });
    expect(seenOps.find((o) => o.op === "fetch")?.params.followRedirects).toBe(false);
  });

  test("confirm is passed through on press, and is false unless stated", async () => {
    seenOps.length = 0;
    canned.press = { url: "https://a.example/one", tabId: 42 };
    await ask("press", { key: "Enter" });
    await ask("press", { key: "Enter", confirm: true });
    expect(seenOps.filter((o) => o.op === "press").map((o) => o.params.confirm)).toEqual([false, true]);
  });

  test("a reply from a socket the request was not sent to is ignored", async () => {
    // A second connection from the same extension origin, registered under its own key.
    const other = asExtension();
    await waitOpen(other);
    other.send(JSON.stringify({ type: "register", key: "bst-othr-othr-othr" }));
    let stolen: string | null = null;
    const real = ext.onmessage!;
    ext.onmessage = (ev) => {
      const req = JSON.parse(String((ev as MessageEvent).data));
      if (req.op === "read") { stolen = req.id; other.send(JSON.stringify({ id: req.id, ok: true, result: { url: "https://a.example/one", text: "FORGED" } })); setTimeout(() => (real as any).call(ext, ev), 80); }
      else (real as any).call(ext, ev);
    };
    canned.read = { url: "https://a.example/one", tabId: 42, text: "genuine" };
    const r = await ask("read", { ref: 1 });
    ext.onmessage = real;
    other.close();
    expect(stolen).not.toBe(null);
    expect(r.text).toContain("genuine");
    expect(r.text).not.toContain("FORGED");
  });
});

// browser_upload reads only from the upload folder and sends the bytes to the extension.
describe("upload", () => {
  const UP = join(DB_DIR, "upload");
  const setDir = () => {
    const file = join(DB_DIR, "config.json");
    let cfg: any = {}; try { cfg = JSON.parse(readFileSync(file, "utf8")); } catch {}
    writeFileSync(file, JSON.stringify({ ...cfg, uploadDir: UP }));
  };

  test("a file from the folder reaches the extension as bytes; the log has no contents", async () => {
    setDir();
    mkdirSync(UP, { recursive: true });
    writeFileSync(join(UP, "icon.png"), "PNGDATA");
    canned.upload = { url: "https://a.example/edit", tabId: 7, how: "file field" };
    seenOps.length = 0;
    const r = await ask("upload", { ref: 4, file: "icon.png" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Uploaded icon.png (7 B)");
    const sent = seenOps.find((o) => o.op === "upload")!.params;
    expect(sent.files).toEqual([{ name: "icon.png", type: "image/png", b64: Buffer.from("PNGDATA").toString("base64") }]);
  });

  test("anything outside the folder is refused before the browser hears of it", async () => {
    setDir();
    writeFileSync(join(DB_DIR, "outside.txt"), "nope");
    seenOps.length = 0;
    const r = await ask("upload", { ref: 4, file: "../outside.txt" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("only be uploaded from");
    expect(seenOps.some((o) => o.op === "upload")).toBe(false);
  });
});

// Semantic targeting can be switched from the extension's own pages: the one hub
// setting the extension may change. Claude (a controller) cannot, and the API key
// never travels over the socket.
describe("semantic targeting switch", () => {
  const config = () => JSON.parse(readFileSync(join(DB_DIR, "config.json"), "utf8"));
  /** Send as the registered extension and wait for the hub's {type:"jev"} answer. */
  async function fromExtension(msg: object): Promise<any> {
    const before = notes.length;
    ext.send(JSON.stringify(msg));
    for (let i = 0; i < 40 && notes.length === before; i++) await Bun.sleep(25);
    return notes.slice(before).find((n) => n.type === "jev") ?? null;
  }

  test("registering reports the state: off, no key, no override", () => {
    const reg = notes.find((n) => n.type === "registered");
    expect(reg.jev).toEqual({ on: false, keyPresent: false, envOverride: false });
  });

  test("the extension can turn it on, and the hub saves it in config.json", async () => {
    const r = await fromExtension({ type: "setJev", on: true });
    expect(r).toMatchObject({ type: "jev", on: true, keyPresent: false });
    expect(config().jev).toBe(true);
    expect(config().extensions).toEqual([EXT_ORIGIN]); // the rest of the file is kept
  });

  test("a controller cannot change it, even with the token", async () => {
    ctl.send(JSON.stringify({ type: "setJev", on: false }));
    await Bun.sleep(120);
    expect(config().jev).toBe(true);
  });

  test("an extension socket that has not registered cannot change it", async () => {
    const r = await knock(asExtension(), { type: "setJev", on: false });
    expect(r.silent).toBe(true);
    expect(config().jev).toBe(true);
  });

  test("anything but a boolean is ignored", async () => {
    expect(await fromExtension({ type: "setJev", on: "false" })).toBe(null);
    expect(config().jev).toBe(true);
  });

  test("turning it off is saved too, and find stops asking Jev", async () => {
    const r = await fromExtension({ type: "setJev", on: false });
    expect(r.on).toBe(false);
    expect(config().jev).toBe(false);
    canned.snapshot = { ...snapResult("https://a.example/one", 42), tree: 'region\n  [1] button "Go"' };
    const f = await ask("find", { target: "the thing that exports my data" });
    expect(f.text).toContain("Semantic targeting is off");
  });

  test("whether a key exists is reported; the key itself never is", async () => {
    const secret = "tsk-test-SECRET-0123456789";
    writeFileSync(KEY_FILE(), `OTHER=1\nTYPESAFE_API_KEY=${secret}\n`);
    const before = notes.length;
    const r = await fromExtension({ type: "jevStatus" });
    expect(r).toEqual({ type: "jev", on: false, keyPresent: true, envOverride: false });
    expect(JSON.stringify(notes.slice(before))).not.toContain(secret);
  });

  test("a controller cannot set the API key", async () => {
    ctl.send(JSON.stringify({ type: "setJevKey", key: "tsk-from-claude-0000" }));
    await Bun.sleep(120);
    expect(readFileSync(KEY_FILE(), "utf8")).not.toContain("tsk-from-claude");
  });

  test("a key with spaces or line breaks is ignored", async () => {
    expect(await fromExtension({ type: "setJevKey", key: "tsk-a" + String.fromCharCode(10) + "EVIL=1" })).toBe(null);
    expect(readFileSync(KEY_FILE(), "utf8")).not.toContain("EVIL");
  });

  test("the Settings page can save a key: written to the key file, Jev on, other lines kept, never echoed", async () => {
    const secret = "tsk-new-SECRET-9876543210";
    const before = notes.length;
    const r = await fromExtension({ type: "setJevKey", key: secret });
    expect(r).toEqual({ type: "jev", on: true, keyPresent: true, envOverride: false });
    const file = readFileSync(KEY_FILE(), "utf8");
    expect(file).toContain(`TYPESAFE_API_KEY=${secret}`);
    expect(file).toContain("OTHER=1");
    expect(file.match(/TYPESAFE_API_KEY=/g)!.length).toBe(1);
    expect(config().jev).toBe(true);
    expect(JSON.stringify(notes.slice(before))).not.toContain(secret);
    await fromExtension({ type: "setJev", on: false }); // leave it off for later tests
  });

  test("the Settings page can remove the key: line gone, other lines kept, Jev off", async () => {
    await fromExtension({ type: "setJev", on: true });
    const r = await fromExtension({ type: "removeJevKey" });
    expect(r).toEqual({ type: "jev", on: false, keyPresent: false, envOverride: false });
    const file = readFileSync(KEY_FILE(), "utf8");
    expect(file).not.toContain("TYPESAFE_API_KEY");
    expect(file).toContain("OTHER=1");
  });
});

// One session, several browsers (say Edge and Firefox): pair with each key, then
// name the browser per call. The default is the last one paired.
describe("several browsers", () => {
  const KEY2 = "bst-ffff-gggg-hhhh";
  const ops2: string[] = [];
  let ext2: WebSocket;

  test("a second browser registers and pairs; the reply names both", async () => {
    ext.send(JSON.stringify({ type: "register", key: KEY, browser: "edge" }));
    ext2 = asExtension();
    await waitOpen(ext2);
    ext2.onmessage = (ev) => {
      const req = JSON.parse(String(ev.data));
      if (req.type) return;
      ops2.push(req.op);
      ext2.send(JSON.stringify({ id: req.id, ok: true, result: { ...snapResult("https://a.example/two", 99), tabId: 99 } }));
    };
    ext2.send(JSON.stringify({ type: "register", key: KEY2, browser: "firefox" }));
    await Bun.sleep(100);
    const r = await ask("pair", { key: KEY2 });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("firefox");
    expect(r.text).toContain("2 browsers");
  });

  test("the last paired browser is the default; browser: picks another for one call", async () => {
    canned.snapshot = snapResult("https://a.example/one", 42);
    seenOps.length = 0; ops2.length = 0;
    const onEdge = await ask("snapshot", { browser: "edge" });
    expect(onEdge.text.startsWith("[edge")).toBe(true);
    expect(seenOps.some((o) => o.op === "snapshot")).toBe(true);
    expect(ops2).toEqual([]);
    const byDefault = await ask("snapshot", {});
    expect(ops2).toContain("snapshot");
    expect(byDefault.text.startsWith("[")).toBe(false);
  });

  test("each browser keeps its own pinned tab", async () => {
    await ask("pin", { browser: "edge", tabId: 42 });
    await ask("pin", { tabId: 99 }); // the default browser, firefox
    seenOps.length = 0; ops2.length = 0;
    await ask("snapshot", { browser: "edge" });
    await ask("snapshot", {});
    expect(seenOps.find((o) => o.op === "snapshot")!.params.tabId).toBe(42);
  });

  test("an unknown name lists the paired browsers, never other keys", async () => {
    const r = await ask("snapshot", { browser: "safari" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("edge");
    expect(r.text).toContain("firefox");
  });

  test("calls in parallel on two browsers each reach their own", async () => {
    seenOps.length = 0; ops2.length = 0;
    const [a, b] = await Promise.all([ask("snapshot", { browser: "edge" }), ask("snapshot", { browser: "firefox" })]);
    expect(a.text.startsWith("[edge")).toBe(true);
    expect(b.text.startsWith("[firefox")).toBe(true);
    expect(seenOps.filter((o) => o.op === "snapshot").length).toBe(1);
    expect(ops2.filter((o) => o === "snapshot").length).toBe(1);
  });
});

// browser_compare: the same steps in each paired browser, then only what differs.
// Its own session and two fake browsers, so the state above does not leak in.
describe("compare", () => {
  const EDGE = "bst-cmpa-edge-0001", FOX = "bst-cmpb-fire-0002";
  type Answer = (op: string, params: any) => any;
  const sockets: WebSocket[] = [];
  const opsSeen: Record<string, string[]> = { edge: [], firefox: [] };
  const answers: Record<string, Answer> = {};
  const page = (form: string, extra: Record<string, unknown> = {}) => (op: string): any => {
    if (op === "form") return { url: "https://shop.example/checkout", tabId: 5, title: "Checkout", count: 3, problems: 0, text: form, ...extra };
    if (op === "snapshot") return { url: "https://shop.example/checkout", tabId: 5, count: 2, tree: 'main\n  heading "Checkout"\n  "Total: €42.00"\n  [1] button "Pay"', ...extra };
    return { url: "https://shop.example/checkout", tabId: 5 };
  };
  const FORM = 'form#pay\n  [1] textbox "Email" (email) = "a@b.c" *required\n  [2] combobox "Country" = "Lithuania" [LT]\n  [3] checkbox "Terms" *checked\n  → submit [4] "Pay"';

  async function fakeBrowser(key: string, name: string) {
    const s = asExtension();
    await waitOpen(s);
    s.onmessage = (ev) => {
      const req = JSON.parse(String(ev.data));
      if (req.type) return;
      opsSeen[name].push(req.op);
      try { s.send(JSON.stringify({ id: req.id, ok: true, result: answers[name](req.op, req.params) })); }
      catch (e: any) { s.send(JSON.stringify({ id: req.id, ok: false, error: e.message })); }
    };
    s.send(JSON.stringify({ type: "register", key, browser: name }));
    sockets.push(s);
  }

  let c: WebSocket;
  const waiting = new Map<string, (m: any) => void>();
  let n = 0;
  const call = (op: string, params: Record<string, unknown> = {}): Promise<{ ok: boolean; text: string }> => {
    const id = `c-${++n}`;
    return new Promise((res) => { waiting.set(id, res); c.send(JSON.stringify({ id, op, params })); });
  };

  beforeAll(async () => {
    answers.edge = page(FORM); answers.firefox = page(FORM);
    await fakeBrowser(EDGE, "edge");
    await fakeBrowser(FOX, "firefox");
    c = new WebSocket(wsUrl());
    await waitOpen(c);
    c.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); waiting.get(m.id)?.(m); waiting.delete(m.id); };
    c.send(JSON.stringify({ type: "hello", role: "control", token: token() }));
    await Bun.sleep(100);
  });
  afterAll(() => { for (const s of [...sockets, c]) try { s.close(); } catch {} });

  test("needs two paired browsers, and names only the session's own", async () => {
    expect((await call("pair", { key: EDGE })).ok).toBe(true);
    const r = await call("compare", {});
    expect(r.ok).toBe(false);
    expect(r.text).toContain("two or more paired browsers");
    expect(r.text).not.toContain(FOX);
    expect(r.text).not.toContain(KEY);
    const unknown = await call("compare", { browsers: ["edge", "firefox"] });
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain("No paired browser 'firefox'");
    expect(unknown.text).not.toContain(FOX);
  });

  test("the same page in both says so", async () => {
    expect((await call("pair", { key: FOX })).ok).toBe(true);
    const r = await call("compare", {});
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Compared 2 browsers (form)");
    expect(r.text).toContain("Same in all 2 browsers: URL (https://shop.example/checkout), title, form");
    expect(r.text).not.toContain("Differences");
  });

  test("ref numbers differing between browsers is not a difference", async () => {
    answers.firefox = page(FORM.replace(/\[(\d)\]/g, (_, d) => `[${Number(d) + 10}]`));
    const r = await call("compare", {});
    expect(r.text).toContain("Same in all 2 browsers");
  });

  test("runs the steps in each browser and diffs the form field by field", async () => {
    opsSeen.edge.length = 0; opsSeen.firefox.length = 0;
    answers.firefox = page(FORM
      .replace('= "a@b.c" *required', '= "a@b.c" *required ⚠ "Enter a valid email"')
      .replace('"Pay"', '"Pay" *disabled'), { title: "Checkout – Shop" });
    const r = await call("compare", { steps: [{ navigate: "https://shop.example/checkout" }, { press: "Tab" }] });
    expect(r.ok).toBe(true);
    for (const b of ["edge", "firefox"]) {
      expect(opsSeen[b]).toContain("navigate");
      expect(opsSeen[b]).toContain("press");
      expect(opsSeen[b]).toContain("form");
    }
    expect(r.text).toMatch(/edge \(bst-cmpa-edge-0001\): Done: 2 steps/);
    expect(r.text).toMatch(/firefox \(bst-cmpb-fire-0002\): Done: 2 steps/);
    expect(r.text).toContain("Differences (edge vs firefox)");
    expect(r.text).toContain('textbox "Email" (email)');
    expect(r.text).toContain('⚠ "Enter a valid email"');
    expect(r.text).toContain('→ submit "Pay"');
    expect(r.text).toContain("*disabled");
    expect(r.text).toContain("Checkout – Shop");
    // Fields that agree are not listed.
    expect(r.text).not.toContain('combobox "Country"');
    expect(r.text).toContain("Same in all 2 browsers: URL");
  });

  test("check:'text' adds the page text, showing only lines one browser lacks", async () => {
    answers.firefox = (op) => op === "snapshot"
      ? { url: "https://shop.example/checkout", tabId: 5, count: 1, tree: 'main\n  heading "Checkout"\n  "Total: €41.00"\n  [1] button "Pay"' }
      : page(FORM)(op);
    answers.edge = page(FORM);
    const r = await call("compare", { check: "text" });
    expect(r.text).toContain("text (2 lines differ)");
    expect(r.text).toContain('"Total: €42.00"  — only in edge');
    expect(r.text).toContain('"Total: €41.00"  — only in firefox');
    expect(r.text).not.toContain('heading "Checkout"  —');
    expect(r.text).toContain("Same in all 2 browsers: URL (https://shop.example/checkout), title, form");
  });

  test("a browser that refuses is reported as refusing, not as a difference", async () => {
    answers.edge = page(FORM);
    answers.firefox = () => { throw new Error("Browsteer is locked in this browser. Ask the user to open the page, click the Browsteer button and choose “Allow Claude on …” for that site."); };
    const r = await call("compare", {});
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/firefox \(bst-cmpb-fire-0002\): refused — Browsteer is locked/);
    expect(r.text).toContain("Nothing to compare: only edge answered");
    expect(r.text).not.toContain("Differences");
  });

  test("a refusal during the steps stops that browser only", async () => {
    answers.firefox = (op) => { if (op === "navigate") throw new Error("shop.example is not on the user's allowed list. Ask the user to open that page, then choose “Allow Claude on shop.example” in the Browsteer popup."); return page(FORM)(op); };
    opsSeen.firefox.length = 0;
    const r = await call("compare", { steps: [{ navigate: "https://shop.example/checkout" }] });
    expect(r.text).toMatch(/firefox \(bst-cmpb-fire-0002\): refused \(Stopped at step 1 of 1[^)]*\) — shop\.example is not on the user's allowed list/);
    expect(opsSeen.firefox).not.toContain("form");
  });

  test("the session's site lock covers every browser", async () => {
    answers.firefox = page(FORM, { url: "https://mail.other.test/inbox" });
    answers.edge = page(FORM);
    const r = await call("compare", {});
    expect(r.text).toMatch(/firefox \(bst-cmpb-fire-0002\): refused — This session is locked to shop\.example/);
    expect(r.text).not.toContain("mail.other.test/inbox");
  });

  test("afterwards the default browser is the one it was before", async () => {
    answers.edge = page(FORM); answers.firefox = page(FORM);
    opsSeen.edge.length = 0; opsSeen.firefox.length = 0;
    await call("form", {});
    expect(opsSeen.firefox).toContain("form");
    expect(opsSeen.edge).toEqual([]);
  });
});
