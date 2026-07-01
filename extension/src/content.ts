// Content script — runs in every page. Builds a token-efficient accessibility
// snapshot and executes click/fill/read actions on behalf of the bridge.
//
// THE BIG IDEA: instead of shipping raw HTML, we reduce the page to its
// *accessibility* essence — the same semantic model a screen reader consumes:
//   • role         (button / textbox / link / heading / listitem / row / ...)
//   • accessible name (computed via a pragmatic subset of the ARIA accname algo)
//   • state        (expanded / selected / checked / current / disabled / value)
// We prune aria-hidden + presentational wrappers, which strips nav bars, cookie
// banners, ads, and footers — most of the tokens, and most of the noise.
//
// `browser` is the global provided by @types/firefox-webext-browser.

// Ephemeral ref → element map. Rebuilt on every snapshot. Refs are ONLY valid
// until the next snapshot/navigation (documented to Claude in the tool desc).
let refMap = new Map<number, Element>();

// ── Roles ────────────────────────────────────────────────────────────────────
const IMPLICIT_ROLE: Record<string, string> = {
  A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox",
  NAV: "navigation", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo",
  ASIDE: "complementary", FORM: "form", SECTION: "region", ARTICLE: "article",
  H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading",
  UL: "list", OL: "list", LI: "listitem",
  TABLE: "table", TR: "row", TD: "cell", TH: "columnheader", IMG: "img",
};

function roleOf(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit.trim().split(/\s+/)[0];
  if (el.tagName === "INPUT") {
    const t = (el as HTMLInputElement).type;
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    if (t === "button" || t === "submit" || t === "reset") return "button";
    if (t === "search") return "searchbox";
    if (t === "range") return "slider";
    if (t === "hidden") return "";
    return "textbox";
  }
  return IMPLICIT_ROLE[el.tagName] ?? "";
}

// Roles that are interactive (always worth a ref) vs structural (give shape).
const INTERACTIVE_ROLES = new Set([
  "link", "button", "textbox", "searchbox", "combobox", "checkbox", "radio",
  "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "slider",
  "switch", "spinbutton",
]);
const STRUCTURAL_ROLES = new Set([
  "heading", "listitem", "row", "cell", "columnheader", "rowheader",
  "article", "region", "main", "navigation", "search", "form", "list",
  "table", "dialog", "alert", "status",
]);

// Roles whose accessible name already captures their text content, so we don't
// descend into their children (avoids "[2] link \"Home\"" + redundant "[3] text \"Home\"").
const NAME_IS_CONTENT = new Set([
  "button", "link", "heading", "tab", "option", "menuitem", "checkbox", "radio", "switch",
]);

const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "PATH", "HEAD", "META", "LINK",
]);

// ── Accessible name (pragmatic ARIA accname subset, à la axe-core/Playwright) ──
function clean(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function accessibleName(el: Element): string {
  // 1. aria-labelledby → concatenated text of referenced nodes
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    const txt = labelledby
      .split(/\s+/)
      .map((id) => clean(document.getElementById(id)?.textContent))
      .filter(Boolean)
      .join(" ");
    if (txt) return txt;
  }
  // 2. aria-label
  const label = clean(el.getAttribute("aria-label"));
  if (label) return label;
  // 3. form controls: associated <label>, then placeholder
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    // submit/button/reset inputs: their value attribute is the accessible name
    if (el instanceof HTMLInputElement && /^(submit|button|reset)$/.test(el.type) && el.value) return el.value;
    if (el.id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const t = clean(forLabel?.textContent);
      if (t) return t;
    }
    const wrap = clean(el.closest("label")?.textContent);
    if (wrap) return wrap;
    const ph = clean((el as HTMLInputElement).placeholder);
    if (ph) return ph;
    // Last resort for unlabelled form controls: the name/id attribute. Sites
    // like autoplius use descriptive names (make_date_from, price_to) that tell
    // the agent exactly what the control is — essential for driving forms.
    const attr = clean(el.getAttribute("name") || el.id);
    if (attr) return attr;
  }
  // 4. images
  if (el instanceof HTMLImageElement && clean(el.alt)) return clean(el.alt);
  // 5. title attribute
  const title = clean(el.getAttribute("title"));
  if (title) return title;
  // 6. buttons/links/headings: their own visible text (capped)
  const role = roleOf(el);
  if (role === "button" || role === "link" || role === "heading" || role === "option" || role === "tab") {
    return clean(el.textContent).slice(0, 120);
  }
  return "";
}

// ── State (compact) ──────────────────────────────────────────────────────────
// value → `="Vilnius"`, boolean states → `*expanded` `*disabled` `*current`.
function stateOf(el: Element): string {
  const parts: string[] = [];
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const isBtn = el instanceof HTMLInputElement && /^(submit|button|reset)$/.test(el.type);
    const v = clean(el.value);
    if (v && !isBtn) parts.push(`=${JSON.stringify(v.slice(0, 80))}`); // btn value is already the name
    if (el.disabled) parts.push("*disabled");
  }
  for (const a of ["aria-expanded", "aria-selected", "aria-checked", "aria-current"]) {
    const v = el.getAttribute(a);
    if (v && v !== "false") parts.push(`*${a.replace("aria-", "")}${v === "true" ? "" : "=" + v}`);
  }
  return parts.length ? " " + parts.join(" ") : "";
}

/** Actionable = worth a ref (click/fill targets). Text/containers get no ref. */
function isInteractive(el: Element, role: string): boolean {
  return INTERACTIVE_ROLES.has(role) || el.hasAttribute("onclick") || el.getAttribute("tabindex") === "0";
}

// ── Visibility ───────────────────────────────────────────────────────────────
function isVisible(el: Element): boolean {
  if (el.getAttribute("aria-hidden") === "true") return false;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && el.childElementCount === 0) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// classify() — THE salience policy. This single function decides, for every
// element, whether it becomes a line in the snapshot ("emit"), is dropped along
// with its whole subtree ("skip-subtree"), or is treated as a transparent
// wrapper we descend through without emitting ("transparent").
//
//   ── This is the highest-leverage knob in the whole project. ──
//   Too inclusive  → bloated snapshots, wasted tokens, Claude distracted by chrome.
//   Too exclusive  → we miss the booking price / the "Select" button / the field.
//
// The default below keeps interactive + structural roles, drops scripts/hidden,
// and collapses anonymous wrapper divs. Tune the heuristics here as you learn
// what real booking pages need (e.g. emit elements with data-testid, treat
// price-like text specially, keep [tabindex]/[onclick] divs, ...).
// ─────────────────────────────────────────────────────────────────────────────
type Decision = "emit" | "skip-subtree" | "transparent";

function classify(el: Element, role: string): Decision {
  if (SKIP_TAGS.has(el.tagName)) return "skip-subtree";
  if (el.getAttribute("aria-hidden") === "true") return "skip-subtree";
  if (role === "presentation" || role === "none") return "transparent";
  if (INTERACTIVE_ROLES.has(role) || STRUCTURAL_ROLES.has(role)) return "emit";
  // Custom interactive widgets that lack a role but behave like controls:
  if (el.hasAttribute("onclick") || el.getAttribute("tabindex") === "0") return "emit";
  return "transparent";
}

// ── Pruning filters (Phase 2) ─────────────────────────────────────────────────
// A filter is CSS-selectors-in-JSON that removes chrome (footer/nav/legal) during
// the walk, so the snapshot ships only meaningful content. Auto-picked by URL.
interface Filter {
  name: string;
  match: string;        // URL glob, e.g. "godaddy.com/*/domainsearch/*"
  root?: string;        // CSS selector to start the walk at (keep only this subtree)
  drop?: string[];      // CSS selectors whose subtrees are removed
  dropText?: string[];  // regex/substring; matching text nodes are removed
  // Extraction mode: emit one positional row per `item`, reading each field's
  // text from a selector relative to the item. Reads real DOM nodes (no prose
  // re-parsing, no truncation). When present, overrides the prune/walk output.
  extract?: { item: string; fields: { name: string; sel?: string }[] };
}

function safeMatches(el: Element, sel: string): boolean {
  try { return el.matches(sel); } catch { return false; }
}

function globToRegex(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(esc);
}

/** Pick the filter whose URL glob matches; longest `match` wins. */
function pickFilter(filters: Filter[], href: string): Filter | null {
  const u = href.replace(/^[a-z]+:\/\//i, "");
  let best: Filter | null = null;
  for (const f of filters) {
    if (f.match && globToRegex(f.match).test(u) && (!best || f.match.length > best.match.length)) best = f;
  }
  return best;
}

function textMatcher(pat: string): (t: string) => boolean {
  try { const re = new RegExp(pat, "i"); return (t) => re.test(t); }
  catch { const low = pat.toLowerCase(); return (t) => t.toLowerCase().includes(low); }
}

// ── The walker ───────────────────────────────────────────────────────────────
interface SnapshotResult {
  url: string;
  count: number;
  tree: string;
  applied: string | null;                      // name of the filter that ran (if any)
  rootApplied?: string | null;                 // filter.root selector that scoped the walk
  dropped: { subtrees: number; textLines: number };
  rootMissing?: boolean;                       // filter.root selector matched nothing
  extracted?: boolean;                         // positional extraction was used
}

// Extraction mode: one positional row per item, fields read from DOM nodes.
// `[id] v1;v2;…` with a leading legend line. Items get refs so click/open still work.
function extractRows(filter: Filter, root: ParentNode): { tree: string; count: number } {
  const ex = filter.extract!;
  const items = Array.from(root.querySelectorAll(ex.item)).filter((el) => isVisible(el));
  const legend = `# ${filter.name} | ${items.length} items | id;${ex.fields.map((f) => f.name).join(";")}`;
  const lines = [legend];
  let ref = 0;
  for (const item of items) {
    const id = ++ref;
    refMap.set(id, item);
    const vals = ex.fields.map((f) => {
      const el = f.sel ? item.querySelector(f.sel) : item;
      return clean(el?.textContent).replace(/;/g, ","); // guard the delimiter
    });
    lines.push(`[${id}] ${vals.join(";")}`);
  }
  return { tree: lines.join("\n"), count: ref };
}

// Compact format to minimise tokens:
//   • only ACTIONABLE elements get a `[ref]` (click/fill targets)
//   • bare `"quoted"` lines are page text — no ref, no "text" keyword
//   • indentation = DOM nesting
//   • interactiveOnly mode drops all text → just the actionable refs
//   • a matching pruning filter removes chrome (root/drop/dropText) during the walk
function snapshot(opts: { interactiveOnly?: boolean; filters?: Filter[] } = {}): SnapshotResult {
  refMap = new Map();
  let ref = 0;
  const lines: string[] = [];
  const interactiveOnly = !!opts.interactiveOnly;

  const filter = pickFilter(opts.filters ?? [], location.href);
  const dropSel = filter?.drop ?? [];
  const dropText = (filter?.dropText ?? []).map(textMatcher);
  let droppedSubtrees = 0;
  let droppedText = 0;

  let rootNode: Element = document.body;
  let rootMissing = false;
  if (filter?.root) {
    const r = document.querySelector(filter.root);
    if (r) rootNode = r; else rootMissing = true;
  }

  // Extraction mode: positional rows from DOM fields. Falls through to the
  // normal walk if it finds zero items (selector stale / wrong page variant).
  if (filter?.extract) {
    const res = extractRows(filter, rootNode);
    if (res.count > 0) {
      return {
        url: location.href, count: res.count, tree: res.tree,
        applied: filter.name, rootApplied: filter.root ?? null,
        dropped: { subtrees: 0, textLines: 0 }, rootMissing, extracted: true,
      };
    }
  }

  const walk = (node: Node, depth: number) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (interactiveOnly) continue;
        const t = clean(child.textContent);
        if (!t) continue;
        if (dropText.some((m) => m(t))) { droppedText++; continue; }
        lines.push(`${"  ".repeat(depth)}${JSON.stringify(t.slice(0, 200))}`);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      if (!isVisible(el)) continue;
      if (dropSel.length && dropSel.some((sel) => safeMatches(el, sel))) { droppedSubtrees++; continue; }
      const role = roleOf(el);
      const decision = classify(el, role);
      if (decision === "skip-subtree") continue;
      if (decision !== "emit") {
        walk(el, depth); // transparent wrapper — descend without a line
        continue;
      }
      const interactive = isInteractive(el, role);
      if (interactiveOnly && !interactive) {
        walk(el, depth); // skip the line but keep hunting for actionable descendants
        continue;
      }
      const name = accessibleName(el);
      let line = "  ".repeat(depth);
      if (interactive) {
        const id = ++ref;
        refMap.set(id, el);
        line += `[${id}] `;
      }
      line += (role || el.tagName.toLowerCase()) + (name ? ` "${name}"` : "") + stateOf(el);
      lines.push(line);
      // Skip children when the name already encodes the content (leaf-like).
      if (!(NAME_IS_CONTENT.has(role) && name)) walk(el, depth + 1);
    }
  };

  walk(rootNode, 0);
  return {
    url: location.href,
    count: ref,
    tree: lines.join("\n"),
    applied: filter?.name ?? null,
    rootApplied: filter?.root && !rootMissing ? filter.root : null,
    dropped: { subtrees: droppedSubtrees, textLines: droppedText },
    rootMissing,
  };
}

// ── Actions ──────────────────────────────────────────────────────────────────
function resolve(ref: number): Element {
  const el = refMap.get(ref);
  if (!el || !el.isConnected) {
    throw new Error(`No live element for ref ${ref}. The page changed — call browser_snapshot again.`);
  }
  return el;
}

function doClick(ref: number) {
  const el = resolve(ref) as HTMLElement;
  el.scrollIntoView({ block: "center" });
  el.click();
  return { url: location.href };
}

function doFill(ref: number, value: string) {
  const el = resolve(ref) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  el.focus();
  // Use the native value setter so React/Vue/etc. detect the change.
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { url: location.href };
}

function doSelect(ref: number, value: string) {
  const el = resolve(ref);
  if (!(el instanceof HTMLSelectElement)) {
    throw new Error(`ref ${ref} is not a <select> (it's ${el.tagName.toLowerCase()}). Use browser_fill for text inputs or browser_click for custom dropdowns.`);
  }
  const want = value.trim().toLowerCase();
  const opts = Array.from(el.options);
  // match by visible label or by value: exact first, then contains
  const match =
    opts.find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want) ??
    opts.find((o) => o.text.trim().toLowerCase().includes(want) || o.value.toLowerCase().includes(want));
  if (!match) {
    const list = opts.map((o) => o.text.trim()).filter(Boolean).slice(0, 40).join(", ");
    throw new Error(`No option matching "${value}" in select [${ref}]. Options: ${list}`);
  }
  el.focus();
  el.value = match.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { url: location.href, selected: match.text.trim() };
}

function doOptions(ref: number) {
  const el = resolve(ref);
  if (!(el instanceof HTMLSelectElement)) throw new Error(`ref ${ref} is not a <select>.`);
  return { options: Array.from(el.options).map((o) => o.text.trim()).filter(Boolean) };
}

function doRead(ref: number) {
  const el = resolve(ref);
  let text = "";
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    text = el.value;
  } else {
    text = clean(el.textContent);
  }
  return { url: location.href, text };
}

// Escape hatch: raw HTML when the a11y snapshot flattens away needed detail.
// Scope to a `ref` (just that element's subtree) to keep it cheap; `clean`
// strips script/style/svg/etc. Capped so we never dump a megabyte at Claude.
function doHtml(ref: number | undefined, clean = true, up = 0, offset = 0, maxBytes = 50_000) {
  let el = (ref != null ? resolve(ref) : document.documentElement) as HTMLElement;
  for (let i = 0; i < up && el.parentElement; i++) el = el.parentElement; // climb to a container (e.g. the result card)
  let html: string;
  if (clean) {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("script,style,noscript,svg,link,template,iframe").forEach((n) => n.remove());
    html = clone.outerHTML;
  } else {
    html = el.outerHTML;
  }
  const total = html.length;
  const slice = html.slice(offset, offset + maxBytes);
  return {
    url: location.href,
    total,
    offset,
    returned: slice.length,
    truncated: offset + slice.length < total,
    html: slice,
  };
}

// Dispatch a key to a ref (or the focused element) — e.g. Enter to commit an
// autocomplete, ArrowDown to move a highlight. Synthetic but with key/code/keyCode
// set so most sites' handlers fire.
const KEYS: Record<string, string> = {
  Enter: "Enter", Tab: "Tab", Escape: "Escape", Backspace: "Backspace",
  ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
};
function doPress(key: string, ref?: number) {
  const el = ((ref != null ? resolve(ref) : document.activeElement) as HTMLElement) ?? document.body;
  el.focus?.();
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : (KEYS[key] ?? key);
  const keyCode =
    key === "Enter" ? 13 : key === "Tab" ? 9 : key === "Escape" ? 27 :
    key === "ArrowUp" ? 38 : key === "ArrowDown" ? 40 : key === "ArrowLeft" ? 37 : key === "ArrowRight" ? 39 :
    key === "Backspace" ? 8 : key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
  const init: KeyboardEventInit = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true } as any;
  el.dispatchEvent(new KeyboardEvent("keydown", init));
  if (key.length === 1) el.dispatchEvent(new KeyboardEvent("keypress", init));
  el.dispatchEvent(new KeyboardEvent("keyup", init));
  return { url: location.href, pressed: key };
}

// ── Element picker ────────────────────────────────────────────────────────────
// User clicks the toolbar / AI calls browser_pick → hover highlights elements,
// a click captures one and we compute a CSS selector + how many it matches
// (matchCount 1 ≈ a container/root; >1 ≈ a repeating item). No guessing selectors.
function stableClasses(el: Element): string[] {
  return Array.from(el.classList).filter(
    (c) => c.length > 2 && !/^(is-|js-|has-|active$|selected$|open$|hover)/.test(c) && !/\d{3,}/.test(c)
  );
}

function selectorFor(el: Element): string {
  if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
  const cls = stableClasses(el);
  if (cls.length) {
    const s = el.tagName.toLowerCase() + cls.map((c) => `.${CSS.escape(c)}`).join("");
    if (document.querySelectorAll(s).length > 0) return s;
  }
  // fallback: short nth-of-type path
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && parts.length < 4) {
    let p = cur.tagName.toLowerCase();
    const sc = stableClasses(cur);
    if (sc.length) p += "." + sc.map((c) => CSS.escape(c)).join(".");
    else {
      const sibs = Array.from(cur.parentElement?.children ?? []).filter((c) => c.tagName === cur!.tagName);
      if (sibs.length > 1) p += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
    }
    parts.unshift(p);
    if (document.querySelectorAll(parts.join(" > ")).length === 1) break;
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}

let pickerActive = false;
function startPicker(): Promise<any> {
  return new Promise((resolve) => {
    if (pickerActive) return resolve({ cancelled: true, error: "picker already active" });
    pickerActive = true;
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;z-index:2147483647;border:2px solid #2563eb;background:rgba(37,99,235,.12);pointer-events:none;border-radius:2px";
    const tip = document.createElement("div");
    tip.style.cssText = "position:fixed;z-index:2147483647;top:0;left:0;background:#111;color:#fff;font:12px/1.4 ui-monospace,monospace;padding:4px 7px;border-radius:5px;pointer-events:none;max-width:92vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    tip.textContent = "Browsteer: click an element to select · Esc to cancel";
    document.body.append(box, tip);
    let current: Element | null = null;

    const onMove = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === box || el === tip) return;
      current = el;
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px` });
      const sel = selectorFor(el);
      tip.textContent = `${sel}  ·  ${document.querySelectorAll(sel).length}×`;
      const tr = Math.max(0, r.top - 22);
      Object.assign(tip.style, { top: `${tr}px`, left: `${Math.max(0, r.left)}px` });
    };
    const finish = (result: any) => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      box.remove(); tip.remove();
      pickerActive = false;
      if (result && result.selector) {
        try { browser.storage.local.set({ lastPick: result }); } catch {}
        toast(`Selected: ${result.selector} (${result.matchCount}×)`);
      }
      resolve(result);
    };
    const onClick = (e: MouseEvent) => {
      e.preventDefault(); e.stopPropagation(); (e as any).stopImmediatePropagation?.();
      if (!current) return;
      const sel = selectorFor(current);
      finish({
        selector: sel,
        matchCount: document.querySelectorAll(sel).length,
        tag: current.tagName.toLowerCase(),
        text: clean(current.textContent).slice(0, 80),
        url: location.href,
      });
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") finish({ cancelled: true }); };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  });
}

function toast(msg: string) {
  const t = document.createElement("div");
  t.textContent = msg;
  t.style.cssText = "position:fixed;z-index:2147483647;bottom:16px;left:50%;transform:translateX(-50%);background:#16a34a;color:#fff;font:13px/1.4 system-ui;padding:8px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3)";
  document.body.append(t);
  setTimeout(() => t.remove(), 2500);
}

// ── Bridge message handler (relayed by the background service worker) ─────────
function handleOp(op: string, params: any): unknown {
  switch (op) {
    case "snapshot": return snapshot({ interactiveOnly: params?.interactiveOnly, filters: params?.filters });
    case "click": return doClick(params.ref);
    case "fill": return doFill(params.ref, params.value);
    case "select": return doSelect(params.ref, params.value);
    case "options": return doOptions(params.ref);
    case "read": return doRead(params.ref);
    case "html": return doHtml(params.ref, params.clean ?? true, params.up ?? 0, params.offset ?? 0, params.maxBytes ?? 50_000);
    case "press": return doPress(params.key, params.ref);
    case "pick": return startPicker(); // returns a Promise (waits for the user)
    default: throw new Error(`Unknown op '${op}'`);
  }
}

browser.runtime.onMessage.addListener(
  (msg: any, _sender: unknown, sendResponse: (r: unknown) => void) => {
    if (!msg || typeof msg.op !== "string") return false; // not for us (e.g. popup msgs)
    // handleOp may return a value or a Promise (pick waits for a click) — await both.
    Promise.resolve()
      .then(() => handleOp(msg.op, msg.params))
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
    return true; // async response
  }
);
