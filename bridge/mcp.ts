// Browsteer MCP SHIM — what Claude Code spawns per session (one-time:
//   claude mcp add browsteer -- bun run "$PWD/bridge/mcp.ts"   # from the repo root
//
// It binds no port and holds no browser logic. It exposes the browser_* tools and
// forwards each call to the shared hub (hub.ts) over a control WebSocket. On first
// use it lazily spawns the hub DETACHED so the hub outlives this session and the
// extension stays paired. Many shims (sessions) share one hub.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn as nodeSpawn } from "node:child_process";

const HUB_URL = `ws://127.0.0.1:${process.env.BRIDGE_PORT ?? 8787}`;
const HUB_PATH = new URL("./hub.ts", import.meta.url).pathname;

let ws: WebSocket | null = null;
let ensuring: Promise<void> | null = null;
const pending = new Map<string, { resolve: (m: any) => void; timer: ReturnType<typeof setTimeout> }>();
let seq = 0;

function openControl(): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(HUB_URL);
    const to = setTimeout(() => { try { sock.close(); } catch {} reject(new Error("connect timeout")); }, 2000);
    sock.onopen = () => { clearTimeout(to); sock.send(JSON.stringify({ type: "hello", role: "control" })); ws = sock; resolve(); };
    sock.onmessage = (ev) => { let m: any; try { m = JSON.parse(String(ev.data)); } catch { return; } const p = pending.get(m.id); if (!p) return; clearTimeout(p.timer); pending.delete(m.id); p.resolve(m); };
    sock.onclose = () => { if (ws === sock) ws = null; };
    sock.onerror = () => { clearTimeout(to); reject(new Error("connect error")); };
  });
}

async function ensureHub(): Promise<void> {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (ensuring) return ensuring;
  ensuring = (async () => {
    try { await openControl(); return; } catch {}
    // Spawn the hub detached so it survives this session; singleton-guards itself.
    try { const c = nodeSpawn(process.execPath, ["run", HUB_PATH], { detached: true, stdio: "ignore" }); c.unref(); } catch {}
    const end = Date.now() + 5000;
    while (Date.now() < end) { try { await openControl(); return; } catch { await Bun.sleep(200); } }
    throw new Error("could not reach or start the browsteer hub");
  })().finally(() => { ensuring = null; });
  return ensuring;
}

async function forward(op: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  try { await ensureHub(); } catch (e: any) { return { ok: false, text: e?.message ?? "hub unavailable" }; }
  if (!ws) return { ok: false, text: "browsteer hub unavailable" };
  const id = `${op}-${++seq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, text: `hub timeout on '${op}'` }); }, 130_000);
    pending.set(id, { resolve: (m: any) => resolve({ ok: m.ok, text: m.text }), timer });
    ws!.send(JSON.stringify({ id, op, params: args }));
  });
}

const mcp = new McpServer({ name: "browsteer", version: "1.0.0" });
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

tool("browser_click", {
  title: "Click element",
  description: "Click the element with the given [ref] from the latest snapshot.",
  inputSchema: { ref: z.number().int().describe("Element ref from browser_snapshot") },
});

tool("browser_fill", {
  title: "Fill input",
  description: "Type a value into the textbox/textarea/select with the given [ref].",
  inputSchema: { ref: z.number().int().describe("Element ref from browser_snapshot"), value: z.string().describe("Text to enter") },
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
  description: "Read the text/value of a single element by [ref] without a full snapshot — cheap way to extract one field.",
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
    saveTo: z.string().optional().describe("Local file path to write the body to (e.g. ~/Downloads/export.json). Returns a short preview instead of the body."),
    maxBytes: z.number().int().positive().optional().describe("Inline return cap for text bodies (default 50000)"),
    preview: z.number().int().positive().optional().describe("With saveTo: how many leading bytes to echo (default 600)"),
    headers: z.record(z.string()).optional().describe("Extra request headers, e.g. {Accept:'application/json'}"),
    method: z.enum(["GET", "POST", "PUT", "PATCH"]).optional().describe("Default GET. Use another verb ONLY to replay a request the page itself fired (seen via browser_requests) — never to probe unknown endpoints with the user's session."),
    body: z.string().optional().describe("Request body for non-GET replays (raw string; set Content-Type in headers)"),
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
  inputSchema: { key: z.string().describe("Key name (Enter, ArrowDown, …) or a single character"), ref: z.number().int().optional().describe("Target element ref; omit to use the focused element") },
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
