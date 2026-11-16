// Integration tests for the hub's targeting behaviour — auto-pin and the
// drift refusal — with a FAKE extension socket, so no Firefox is needed:
//   bun test test/hub.test.ts
//
// The fake extension answers ops with canned results, including the tabId that
// background.ts now reports, which is what auto-pin and drift detection key off.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8791 + Math.floor(Math.random() * 60);
const KEY = "bst-test-hub";
const ROOT = new URL("..", import.meta.url).pathname;
const DB_DIR = mkdtempSync(join(tmpdir(), "browsteer-test-"));

let hub: ReturnType<typeof Bun.spawn>;
let ext: WebSocket;
let ctl: WebSocket;

/** What the fake extension should answer with next, per op. */
const canned: Record<string, any> = {};
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
  hub = Bun.spawn(["bun", "run", "bridge/hub.ts"], {
    cwd: ROOT,
    env: { ...process.env, BRIDGE_PORT: String(PORT), BROWSTEER_DB_DIR: DB_DIR },
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

  ext = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await waitOpen(ext);
  ext.onmessage = (ev) => {
    const req = JSON.parse(String(ev.data));
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
  ctl.send(JSON.stringify({ type: "hello", role: "control" }));
  await Bun.sleep(150);

  expect((await ask("pair", { key: KEY })).text).toContain("Paired");
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
