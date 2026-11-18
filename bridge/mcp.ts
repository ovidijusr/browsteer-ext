// Browsteer MCP SHIM — what Claude Code spawns per session (one-time:
//   claude mcp add browsteer -- bun run "$PWD/bridge/mcp.ts"   # from the repo root
//
// It binds no port and holds no browser logic. It exposes the browser_* tools and
// forwards each call to the shared hub (hub.ts) over a control WebSocket. On first
// use it lazily spawns the hub DETACHED so the hub outlives this session and the
// extension stays paired. Many shims (sessions) share one hub.
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn as nodeSpawn } from "node:child_process";
import { readToken } from "./security";
import { VERSION, cmpVersion } from "./version";

const HUB_URL = `ws://127.0.0.1:${process.env.BRIDGE_PORT ?? 8787}`;
const HUB_PATH = fileURLToPath(new URL("./hub.ts", import.meta.url));

let ws: WebSocket | null = null;
let ensuring: Promise<void> | null = null;
const pending = new Map<string, { resolve: (m: any) => void; timer: ReturnType<typeof setTimeout> }>();
let seq = 0;
// Set when the hub runs newer code than this session loaded: every reply then says to restart the session.
let staleNote = "";
// A newer shim restarts an older hub once. Once only, so a checkout that went backwards cannot loop.
let restartedHub = false;

class Denied extends Error {}
const failAll = (text: string) => { for (const [id, w] of pending) { clearTimeout(w.timer); pending.delete(id); w.resolve({ id, ok: false, text }); } };

/** Connect and say hello. Resolves with the hub's version, or null for a hub too old to report one. */
function openControl(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(HUB_URL);
    let settled = false;
    const done = (v: string | null) => { if (settled) return; settled = true; clearTimeout(to); ws = sock; resolve(v); };
    const to = setTimeout(() => { try { sock.close(); } catch {} reject(new Error("connect timeout")); }, 2000);
    sock.onopen = () => {
      sock.send(JSON.stringify({ type: "hello", role: "control", token: readToken(), version: VERSION }));
      clearTimeout(to);
      // Hubs from before 2.0.0 never answer the hello; give a current one a moment to.
      setTimeout(() => done(null), 1500);
    };
    sock.onmessage = (ev) => {
      let m: any; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === "welcome") return done(typeof m.version === "string" ? m.version : null);
      if (m.type === "denied") {
        const text = `The Browsteer hub refused this session: ${m.reason} Restart the hub (bun run hub:stop) and try again.`;
        console.error(`[browsteer] ${text}`);
        if (!settled) { settled = true; clearTimeout(to); reject(new Denied(text)); } else failAll(text);
        return;
      }
      const p = pending.get(m.id); if (!p) return; clearTimeout(p.timer); pending.delete(m.id); p.resolve(m);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      // A hub restart (e.g. after an update) must not leave calls waiting for the 130 s timeout.
      failAll("The Browsteer hub restarted while this call was running. Run it again.");
    };
    sock.onerror = () => { clearTimeout(to); reject(new Error("connect error")); };
  });
}

function spawnHub() {
  // Detached so it survives this session; the hub singleton-guards itself.
  try { const c = nodeSpawn(process.execPath, ["run", HUB_PATH], { detached: true, stdio: "ignore" }); c.unref(); } catch {}
}

async function waitForHub(): Promise<string | null> {
  const end = Date.now() + 6000;
  while (Date.now() < end) { try { return await openControl(); } catch (e) { if (e instanceof Denied) throw e; await Bun.sleep(200); } }
  throw new Error("could not reach or start the browsteer hub");
}

/** The hub keeps running across sessions, so after `bun run update` it can be older or newer than this shim. */
async function checkVersion(hubVersion: string | null): Promise<void> {
  const d = hubVersion ? cmpVersion(hubVersion, VERSION) : -1;
  if (d > 0) {
    staleNote = `\n⚠ This Claude Code session loaded Browsteer v${VERSION}, but the hub runs v${hubVersion}. Start a new Claude Code session to get the current browser tools.`;
    return;
  }
  staleNote = "";
  if (d === 0 || restartedHub) return;
  // The hub runs older code than is on disk now: replace it with the current one.
  restartedHub = true;
  console.error(`[browsteer] hub is v${hubVersion ?? "<2.0.0"}, this session is v${VERSION}: restarting the hub`);
  try { ws?.send(JSON.stringify({ type: "shutdown", token: readToken() })); } catch {}
  ws = null;
  await Bun.sleep(400);
  spawnHub();
  const v = await waitForHub();
  if (v !== VERSION) console.error(`[browsteer] hub restarted but reports v${v ?? "?"}`);
}

async function ensureHub(): Promise<void> {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (ensuring) return ensuring;
  ensuring = (async () => {
    let v: string | null;
    try { v = await openControl(); } catch (e) { if (e instanceof Denied) throw e; spawnHub(); v = await waitForHub(); }
    await checkVersion(v);
  })().finally(() => { ensuring = null; });
  return ensuring;
}

async function forward(op: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  try { await ensureHub(); } catch (e: any) { return { ok: false, text: e?.message ?? "hub unavailable" }; }
  if (!ws) return { ok: false, text: "browsteer hub unavailable" };
  const id = `${op}-${++seq}`;
  const r = await new Promise<{ ok: boolean; text: string }>((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, text: `hub timeout on '${op}'` }); }, 130_000);
    pending.set(id, { resolve: (m: any) => resolve({ ok: m.ok, text: m.text }), timer });
    ws!.send(JSON.stringify({ id, op, params: args }));
  });
  return staleNote ? { ok: r.ok, text: r.text + staleNote } : r;
}

const mcp = new McpServer({ name: "browsteer", version: VERSION });
function tool(name: string, config: any) {
  const op = name.replace(/^browser_/, "");
  mcp.registerTool(name, config, async (args: any) => {
    const r = await forward(op, args ?? {});
    return { isError: !r.ok, content: [{ type: "text", text: r.text }] };
  });
}

tool("browser_pair", {
  title: "Pair with a browser",
  description: "Select which connected browser to drive, by its pairing key (shown in the Browsteer extension popup, e.g. 'bst-ab12-cd34'). Call this first.",
  inputSchema: { key: z.string().describe("Pairing key from the extension popup") },
});

tool("browser_snapshot", {
  title: "Snapshot page",
  description:
    "Capture a token-efficient accessibility snapshot of the active browser tab. " +
    "FORMAT (indentation = DOM nesting): a line `[N] role \"name\" =value` is an " +
    "ACTIONABLE element — only these have a [ref] you can click/fill. A bare " +
    '`"quoted"` line is page text (no ref needed; read it directly). States show ' +
    "as `=\"value\"`, `*disabled`, `*selected`, etc. Refs are valid ONLY until the " +
    "next navigation/snapshot — re-snapshot after each action. Set interactiveOnly " +
    "to drop all text and return just the actionable refs (cheapest; for pure action steps). " +
    "`[N] clickable \"…\"` is a pointer-only control (an <img>/<div>/<td> with cursor:pointer and no role, " +
    "e.g. calendar days and month arrows), named from its text or image file name; click it like a button. " +
    "A saved pruning filter whose URL pattern matches is applied automatically (chrome removed). " +
    "Three reductions also run by default and are reported in the header so you can audit them: " +
    "runs of 5+ look-alike sibling controls collapse to one ranged line `[13-43] button \"Weiter 1…31\" ×31 collapsed` " +
    "(every ref in the range is still individually clickable); a subtree repeated verbatim later on the page " +
    "becomes `↩ identical to an earlier block`; and universal chrome (footer/contentinfo, Google-Maps widgets, " +
    "consent containers) is dropped. Set raw:true to bypass filters AND all three reductions — " +
    "the fallback when something you expected seems to be missing.",
  inputSchema: {
    interactiveOnly: z.boolean().optional().describe("Only list actionable (clickable/fillable) elements; omit page text. Cheapest."),
    raw: z.boolean().optional().describe("Bypass saved filters and all reduction passes; return the unprocessed page (fallback)."),
  },
});

tool("browser_links", {
  title: "List links (cheap navigation)",
  description:
    "Return just the links under the page (or under one [ref] subtree) as `label ⇢ url`. " +
    "Use this instead of browser_html when you only need somewhere to navigate to — a snapshot " +
    "costs thousands of tokens and contains no URLs at all, and browser_html on a list page gets " +
    "truncated. The shared head/tail of the URLs is hoisted into the header once, so each row is " +
    "just the part that differs; join header prefix + row + header suffix to rebuild a full URL.",
  inputSchema: {
    ref: z.number().int().optional().describe("Scope to this element's subtree (e.g. one result card). Omit for the whole page."),
    limit: z.number().int().optional().describe("Max links to return (default 200)."),
  },
});

tool("browser_form", {
  title: "Inspect form state",
  description:
    "List every form control with the live state a validator reads — value, *checked, the chosen option of a " +
    "<select> (or 'nothing chosen'), *required, maxlength/pattern, *disabled — plus the error text the page shows " +
    "next to each field and each submit button's *disabled state. Includes hidden controls behind custom widgets " +
    "(the real <select> under a styled dropdown) and points at the visible widget. Passwords are masked. " +
    "Use it when a submit button stays disabled or a form won't advance: one call instead of snapshot + html " +
    "digging. Refs are reassigned (they replace the last snapshot's), so you can browser_fill/browser_select straight from it.",
  inputSchema: {
    ref: z.number().int().optional().describe("Scope to this element's subtree (e.g. one form). Omit for every control on the page."),
  },
});

tool("browser_click", {
  title: "Click element",
  description:
    "Click the element with the given [ref] from the latest snapshot/scan (a real-shaped click: pointer/mouse " +
    "down+up on the innermost element at its centre, then click). Or pass x,y instead of ref to click whatever " +
    "is on top at that viewport point (coordinates from browser_scan) — for canvas, overlays, anything without a ref. " +
    "If the reply says nothing changed, escalate to browser_scan rather than retrying the same ref.",
  inputSchema: {
    ref: z.number().int().optional().describe("Element ref from browser_snapshot or browser_scan"),
    confirm: z.boolean().optional().describe("Controls whose name sounds irreversible (delete, pay, send, sign out…) are refused unless this is true. Set it only after the user has said yes to this specific action."),
    x: z.number().optional().describe("Viewport x in CSS px (with y, instead of ref)"),
    y: z.number().optional().describe("Viewport y in CSS px"),
    settle: z.number().int().min(0).max(5000).optional().describe("Max ms to wait for the page to react (URL change / DOM quiet / unload) before returning; default 800, 0 = return immediately"),
  },
});

tool("browser_fill", {
  title: "Fill input",
  description:
    "Put a value into the textbox/textarea/select with the given [ref] (a custom-element host such as <gds-input> " +
    "resolves to the input inside it). Default is a fast value-set. Set type:true when a form ignores the filled " +
    "value (validation says empty, a duplicate/empty-name error, the model kept the old text): it types the way " +
    "a keyboard does (execCommand insertText, else per-key events) and reports whether the value stuck.",
  inputSchema: {
    ref: z.number().int().describe("Element ref from browser_snapshot"),
    value: z.string().describe("Text to enter"),
    type: z.boolean().optional().describe("Keyboard-style typing fallback (slower, works with framework-bound fields)"),
    commit: z.boolean().optional().describe("With type:true, blur the field afterwards (fires blur/focusout validators)"),
  },
});

tool("browser_scan", {
  title: "Visual scan (fallback)",
  description:
    "FALLBACK for when browser_snapshot/find don't show or can't operate a control. Hit-tests a grid over the " +
    "viewport (or one [ref]'s box) and lists every distinct thing actually on screen — declared or not: bare " +
    "<img>/<div>/<td> widgets, labels for hidden inputs, open shadow-DOM content — as `[N] tag.class \"text\" " +
    "@x,y WxH (flags)`. Refs work with browser_click/fill/read; @x,y works with browser_click({x,y}). " +
    "Costs more tokens than a snapshot: use it after a failure, scoped with ref when you can.",
  inputSchema: {
    ref: z.number().int().optional().describe("Scan only this element's box (scrolled into view first) — e.g. a dialog or calendar"),
    step: z.number().int().min(6).max(80).optional().describe("Grid spacing in px (default 16; smaller finds tinier targets)"),
    limit: z.number().int().min(10).max(400).optional().describe("Max targets listed (default 120)"),
  },
});

tool("browser_dialogs", {
  title: "Answer page dialogs",
  description:
    "alert() boxes are answered automatically and their text is appended to the next reply (⚠ Page dialog…). " +
    "confirm()/prompt() stay native — the tab waits for a person — unless you set an answer for the NEXT one " +
    "here (one-shot). Use it when an action timed out because the page asked a question, or before clicking " +
    "something you know will ask. Also returns dialog text seen since the last call.",
  inputSchema: {
    confirm: z.enum(["native", "accept", "dismiss"]).optional().describe("How to answer the next confirm()"),
    prompt: z.string().nullable().optional().describe("Text to answer the next prompt() with (null = native)"),
  },
});

tool("browser_select", {
  title: "Select a dropdown option",
  description:
    "Choose an option in a native <select> [ref] by visible label or value " +
    "(case-insensitive, exact then contains). Errors listing the options if no match. " +
    "For custom (non-<select>) dropdowns, use browser_click to open then click the option.",
  inputSchema: { ref: z.number().int().describe("combobox ref from browser_snapshot"), value: z.string().describe("Option label or value, e.g. '2018' or 'Dyzelinas'") },
});

tool("browser_options", {
  title: "List dropdown options",
  description: "List the option labels of a native <select> [ref] (so you know valid values before browser_select).",
  inputSchema: { ref: z.number().int().describe("combobox ref from browser_snapshot") },
});

tool("browser_read", {
  title: "Read element",
  description: "Read the text/value of a single element by [ref] without a full snapshot — cheap way to extract one field. Checkboxes/radios return checked/unchecked; a <select> returns its chosen option text (and value).",
  inputSchema: { ref: z.number().int().describe("Element ref from browser_snapshot") },
});

tool("browser_navigate", {
  title: "Navigate",
  description: "Load a URL in the active tab of the paired browser.",
  inputSchema: { url: z.string().url().describe("URL to load") },
});

tool("browser_fetch", {
  title: "Fetch a URL with the browser's cookies",
  description:
    "GET a URL from inside the paired browser, with the user's logged-in cookies, and return the body " +
    "(or save it to disk). Use for authenticated API/JSON/PDF/CSV endpoints that a snapshot can't read: " +
    "Firefox's JSON viewer and pdf.js pages have no content script, and the terminal has no session. " +
    "Text bodies are returned inline (truncated at maxBytes, default 50k); binary bodies and big exports " +
    "should use saveTo (a local path, ~ allowed) and then be Read from disk. Never use for state-changing " +
    "endpoints — it is GET-only by design.",
  inputSchema: {
    url: z.string().url().describe("Absolute URL to fetch"),
    saveTo: z.string().optional().describe("File name (or path) inside the download folder, ~/Downloads/browsteer by default; anything outside it is refused. Returns a short preview instead of the body."),
    maxBytes: z.number().int().positive().optional().describe("Inline return cap for text bodies (default 50000)"),
    preview: z.number().int().positive().optional().describe("With saveTo: how many leading bytes to echo (default 600)"),
    headers: z.record(z.string()).optional().describe("Extra request headers, e.g. {Accept:'application/json'}"),
    method: z.enum(["GET", "POST", "PUT", "PATCH"]).optional().describe("Default GET. Use another verb ONLY to replay a request the page itself fired (seen via browser_requests) — never to probe unknown endpoints with the user's session."),
    body: z.string().optional().describe("Request body for non-GET replays (raw string; set Content-Type in headers)"),
    fromPage: z.boolean().optional().describe("Run the request inside the pinned/active tab AS the page (page Origin + cookies). Use when a same-origin API 403s from the extension context (e.g. Booking /dml/graphql). The tab must be on that site."),
  },
});

tool("browser_requests", {
  title: "Recent XHR/fetch requests the page made",
  description:
    "List the API calls pages have fired (method, URL with query string, POST body, status, mime) — the " +
    "extension keeps the last 300 XHR/fetch requests across tabs. Use it to learn which endpoint and " +
    "parameters a UI action (filter form, pager, export button) actually hits, then replay it with " +
    "browser_fetch. Typical loop: browser_requests({clear:true}) → do the UI action → browser_requests({filter:'api/'}).",
  inputSchema: {
    filter: z.string().optional().describe("Regex matched against the URL, e.g. 'documents2|forList'"),
    limit: z.number().int().positive().optional().describe("Max entries, newest kept (default 40)"),
    since: z.number().optional().describe("Only requests after this epoch-ms timestamp"),
    all: z.boolean().optional().describe("Include page navigations (main_frame/sub_frame), not just XHR/fetch"),
    clear: z.boolean().optional().describe("Empty the log after returning — call before a UI action to isolate its traffic"),
  },
});

tool("browser_html", {
  title: "Get raw HTML (escape hatch)",
  description:
    "Return raw HTML when the accessibility snapshot flattens away detail you need " +
    "(hidden attributes, exact markup of a result card). EXPENSIVE — prefer " +
    "browser_snapshot. Pass a [ref] to scope to just that element's subtree (cheap); " +
    "omit it for the whole page. `clean` (default true) strips script/style/svg/etc. " +
    "Returns at most maxBytes (default 50k) and shouts ⚠ TRUNCATED with the true total.",
  inputSchema: {
    ref: z.number().int().optional().describe("Scope to this element's subtree (from browser_snapshot). Omit for whole page."),
    clean: z.boolean().optional().describe("Strip script/style/svg/link/iframe (default true)"),
    up: z.number().int().optional().describe("Climb N ancestors from the ref before grabbing HTML — e.g. up:2 from a 'Select' button to get its whole result card."),
    offset: z.number().int().optional().describe("Byte offset to start at (for paging large HTML; default 0)"),
    maxBytes: z.number().int().optional().describe("Max bytes to return (default 50000). Increase deliberately."),
  },
});

tool("browser_tabs", {
  title: "List open tabs",
  description: "List the browser's open tabs (tabId, title, url, which is active). Use with browser_pin to lock actions onto one tab so they don't drift to whatever the user focuses.",
  inputSchema: {},
});

tool("browser_pin", {
  title: "Pin / unpin the target tab",
  description:
    "Lock all actions onto a specific tab (from browser_tabs) so they stop following the " +
    "focused tab. Pass a tabId to pin; omit tabId to unpin (back to active-tab, and auto-pinning " +
    "stays off for the rest of the session). NOTE: the first op that reaches a tab auto-pins to it " +
    "and says so, so you normally don't need this — reach for it to move to a different tab, or " +
    "after a 'Refusing to return the snapshot' drift error.",
  inputSchema: { tabId: z.number().int().optional().describe("Tab id from browser_tabs; omit to unpin") },
});

tool("browser_press", {
  title: "Press a key",
  description:
    "Dispatch a key to a [ref] (or the focused element) — e.g. 'Enter' to commit an " +
    "autocomplete, 'ArrowDown' to move a dropdown highlight, 'Escape' to close. Keys: " +
    "Enter, Tab, Escape, ArrowUp/Down/Left/Right, Backspace, or a single character.",
  inputSchema: { key: z.string().describe("Key name (Enter, ArrowDown, …) or a single character"), ref: z.number().int().optional().describe("Target element ref; omit to use the focused element") , confirm: z.boolean().optional().describe("Enter or Space on a control that sounds irreversible (or in a form whose submit button does) is refused unless this is true. Set it only after the user agreed to this specific action.") },
});

tool("browser_pick", {
  title: "Pick an element (ask the user to click)",
  description:
    "Turn on a visual picker in the user's browser and wait for them to CLICK an " +
    "element. Returns its CSS selector, how many elements match (1 ≈ a container/root, " +
    ">1 ≈ a repeating item), tag, and a text sample. Use this to get reliable selectors " +
    "for a filter's root/item/fields instead of guessing. Waits up to 2 minutes for the click.",
  inputSchema: { hint: z.string().optional().describe("What to tell the user to click (for your reference; shown in chat, not the page)") },
});

tool("browser_save_filter", {
  title: "Save a pruning filter",
  description:
    "Store (or update) a reusable pruning filter for a page structure. After saving, " +
    "browser_snapshot auto-applies it whenever the URL matches, stripping chrome so only " +
    "meaningful content is returned. Calling again with the same name updates it (re-scan). " +
    "Filter = CSS selectors: `root` keeps only that subtree; `drop` removes matching subtrees; " +
    "`dropText` removes matching text; `extract` emits compact positional rows per item.",
  inputSchema: {
    name: z.string().describe("Stable id for this structure, e.g. 'godaddy-domains'"),
    match: z.string().describe("URL glob, e.g. 'godaddy.com/*/domainsearch/*'"),
    root: z.string().optional().describe("CSS selector to keep only (e.g. 'main')"),
    drop: z.array(z.string()).optional().describe("CSS selectors whose subtrees are removed"),
    dropText: z.array(z.string()).optional().describe("Regex/substrings; matching text removed"),
    extract: z.object({
      item: z.string().describe("CSS selector for each repeating item (e.g. 'a.announcement-item')"),
      fields: z.array(z.object({ name: z.string(), sel: z.string().optional() })).describe("Per-field selectors relative to the item; omit sel to use the item's own text"),
    }).optional().describe("Extraction mode: emit one compact positional row per item from DOM fields (no truncation). Each row also gets an implicit trailing `url` field (the item's own href or its first descendant link) with the shared head/tail factored into the legend — so you can navigate straight from a list without a browser_html detour. Overrides prune output."),
  },
});

tool("browser_find", {
  title: "Find (and optionally click/fill) elements by describing them",
  description:
    "Jev-powered targeting: describe the element in plain language and the bridge picks the matching [ref] " +
    "from a fresh snapshot for you — you get a 5-line shortlist instead of the whole tree. Prefer this over " +
    "browser_snapshot + browser_click whenever you can NAME the target ('the login button', 'next page', " +
    "'the listing titled …', 'the search box'). With act:'click' it also clicks the top match when confidence " +
    "is high and the element is not an irreversible action (buy/send/delete are refused — click those " +
    "explicitly). If the winner is a link, its URL is included so you can browser_navigate directly. " +
    "Not for numeric/date comparisons ('cheapest', 'newest'): use an extraction filter and sort yourself. " +
    "Still needs browser_snapshot when the page is unfamiliar or the result says nothing matched.",
  inputSchema: {
    target: z.string().optional().describe("What to find, as a user would say it, e.g. 'the Weiter / next page control'"),
    targets: z.array(z.string()).min(2).max(8).optional().describe("Several targets answered in ONE request (e.g. ['email field','password field','sign in button']); returns one ref per target, no act"),
    act: z.enum(["none", "click", "fill"]).optional().describe("'click' = click the top match if confident; 'fill' = type `value` into it (default 'none' = shortlist only). Single target only."),
    value: z.string().optional().describe("Text to type when act is 'fill'"),
    fresh: z.boolean().optional().describe("Bypass the memo store and ask Jev even if this host already resolved the target before (default false)"),
  },
});

tool("browser_do", {
  title: "Run a scripted sequence of steps in one call",
  description:
    "Several browser steps in ONE tool call (each Claude turn costs seconds; each step here costs ~0.3 s): " +
    "a list of {find, click|fill}, {press}, {navigate}, {pursue}, {wait} steps run hub-side with settle waits between, " +
    "returning one line per step plus the final page. Steps name targets, never refs. A bare {find} clicks; " +
    "{find, fill:'text'} types; {press:'Enter'}; {navigate:'https://…'}; {pursue:'goal'} walks multi-hop. " +
    "Stops at the first failed/refused/low-confidence step (its full reply is included) unless continue:true. " +
    "Example: [{find:'the email field', fill:'a@b.c'}, {find:'the password field', fill:'…'}, {find:'the sign in button'}, {pursue:'the invoices page'}].",
  inputSchema: {
    steps: z.array(z.object({
      find: z.string().optional().describe("Target to find; clicks it unless `fill` is given"),
      fill: z.string().optional().describe("Text to type into the found target"),
      click: z.boolean().optional().describe("Explicit click (default for a bare find)"),
      fresh: z.boolean().optional().describe("Bypass memo/lexical for this find"),
      press: z.string().optional().describe("Key to dispatch to the focused element, e.g. 'Enter'"),
      navigate: z.string().optional().describe("URL to load"),
      pursue: z.string().optional().describe("Multi-hop goal (click-only)"),
      maxSteps: z.number().int().min(1).max(12).optional(),
      wait: z.number().optional().describe("Sleep ms (max 5000) — for pages that animate after a click"),
    })).min(1).max(20),
    continue: z.boolean().optional().describe("Keep going after a failed step (default: stop and report)"),
    finalSnapshot: z.boolean().optional().describe("Append the final page (default true)"),
  },
});

tool("browser_memos", {
  title: "List or forget target memos",
  description:
    "Memos are the Jev bypass: after a confident browser_find, the host + target + matched role/name are stored, and later finds " +
    "of the same target on that host resolve by matching the fresh snapshot with no Jev call (0 tokens, ~50 ms). This lists them " +
    "(hits + last use) or forgets them — clear a host after a site redesign renames its controls.",
  inputSchema: {
    host: z.string().optional().describe("Only this host (e.g. 'music.ovi.lt')"),
    clear: z.union([z.boolean(), z.string()]).optional().describe("true = forget all memos; a host string = forget that host's"),
  },
});

tool("browser_pursue", {
  title: "Let Jev browse toward a goal (click-only, bounded)",
  description:
    "Multi-page navigation without a Claude turn per hop (~1 s per hop): the bridge snapshots, asks Jev which element leads " +
    "toward the goal, clicks it, and repeats (default 6 steps, max 12) until Jev judges the goal is on screen, " +
    "the page needs a human (login/CAPTCHA/consent), no step is confident, or the next click looks irreversible. " +
    "It NEVER types, selects, or presses keys — use browser_find({target, act:'fill', value}) or browser_fill for forms, then " +
    "pursue from the results. Returns the trail of clicks (with timings); finalSnapshot:true adds the final page. " +
    "Good goals name a destination: 'open the first BMW i4 listing', 'get to the invoices page', 'open the " +
    "documentation for the Python SDK'.",
  inputSchema: {
    goal: z.string().describe("Destination or outcome to reach, as a user would phrase it"),
    maxSteps: z.number().int().min(1).max(12).optional().describe("Click budget (default 6)"),
    finalSnapshot: z.boolean().optional().describe("Also return an interactive-only snapshot of the final page (default false — call browser_find/browser_snapshot yourself when needed)"),
  },
});

tool("browser_list_filters", {
  title: "List pruning filters",
  description: "List all saved pruning filters (name, URL pattern, rule counts).",
  inputSchema: {},
});

tool("browser_delete_filter", {
  title: "Delete a pruning filter",
  description: "Remove a saved pruning filter by name.",
  inputSchema: { name: z.string().describe("Filter name to delete") },
});

await mcp.connect(new StdioServerTransport());
console.error("[browsteer] MCP shim ready (forwards to hub)");
