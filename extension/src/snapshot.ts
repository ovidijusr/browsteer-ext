// Snapshot core — pure DOM-in / string-out. No `browser.*` here on purpose, so
// `bun test` can drive it under happy-dom (see test/snapshot.test.ts).
//
// THE BIG IDEA: instead of shipping raw HTML, we reduce the page to its
// *accessibility* essence — the same semantic model a screen reader consumes:
//   • role         (button / textbox / link / heading / listitem / row / ...)
//   • accessible name (computed via a pragmatic subset of the ARIA accname algo)
//   • state        (expanded / selected / checked / current / disabled / value)
//
// On top of that, three structural passes cut the tokens that survive the a11y
// reduction but carry no information (see COLLAPSE / DEDUP / CHROME below).
// Every pass is reported in the result so the caller can audit what was hidden,
// and all three are switched off by `raw`.

// ── Ref table ────────────────────────────────────────────────────────────────
// Ephemeral ref → element map. Rebuilt on every snapshot. Refs are ONLY valid
// until the next snapshot/navigation (documented to Claude in the tool desc).
let refMap = new Map<number, Element>();

export function getRef(ref: number): Element | undefined {
  return refMap.get(ref);
}

// ── Roles ────────────────────────────────────────────────────────────────────
const IMPLICIT_ROLE: Record<string, string> = {
  A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox",
  NAV: "navigation", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo",
  ASIDE: "complementary", FORM: "form", SECTION: "region", ARTICLE: "article",
  H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading",
  UL: "list", OL: "list", LI: "listitem",
  TABLE: "table", TR: "row", TD: "cell", TH: "columnheader", IMG: "img",
};

export function roleOf(el: Element): string {
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
// descend into their children.
const NAME_IS_CONTENT = new Set([
  "button", "link", "heading", "tab", "option", "menuitem", "checkbox", "radio", "switch",
]);

const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "PATH", "HEAD", "META", "LINK",
]);

// ── CHROME: universal, site-agnostic noise ───────────────────────────────────
// Only structurally unambiguous things go here — landmark footers, the Google
// Maps widget (a dozen refs of zoom/Pegman/"Kartendaten" on every listing page),
// and consent-manager containers addressed by their own well-known ids. No fuzzy
// class matching: a false positive here silently hides real content, which is the
// one failure mode that costs an agent a wrong answer rather than a few tokens.
const CHROME_SELECTORS = [
  "footer", "[role=contentinfo]",
  ".gm-style", ".gmnoprint", ".gm-svpc",
  "#onetrust-consent-sdk", "#usercentrics-root", ".cc-window",
  '[id^="sp_message_container"]', "#CybotCookiebotDialog",
];

const COLLAPSE_MIN = 5;      // shortest run of look-alike siblings worth collapsing
const DEDUP_MIN_LINES = 3;   // smallest repeated subtree worth replacing with a marker

// A collapsed range is only honest if the reader can still tell what each member
// is from the summary line — true for "Weiter 1…Weiter 31", false for a run of
// search-result cards whose names differ in price and mileage. Digit-normalising
// alone is not enough: every listing digit-normalises to the same skeleton, so
// cap the name length (index-labelled controls are short, result cards are not)
// and never fold links, whose href carries information the summary would drop.
const COLLAPSE_MAX_NAME = 30;

// ── Accessible name (pragmatic ARIA accname subset, à la axe-core/Playwright) ──
export function clean(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

export function accessibleName(el: Element): string {
  const doc = el.ownerDocument;
  // 1. aria-labelledby → concatenated text of referenced nodes
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    const txt = labelledby
      .split(/\s+/)
      .map((id) => clean(doc.getElementById(id)?.textContent))
      .filter(Boolean)
      .join(" ");
    if (txt) return txt;
  }
  // 2. aria-label
  const label = clean(el.getAttribute("aria-label"));
  if (label) return label;
  // 3. form controls: associated <label>, then placeholder
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
    const ctl = el as HTMLInputElement;
    if (tag === "INPUT" && /^(submit|button|reset)$/.test(ctl.type) && ctl.value) return ctl.value;
    if (ctl.id) {
      const forLabel = doc.querySelector(`label[for="${cssEscape(ctl.id)}"]`);
      const t = clean(forLabel?.textContent);
      if (t) return t;
    }
    const wrap = clean(el.closest("label")?.textContent);
    if (wrap) return wrap;
    const ph = clean(ctl.placeholder);
    if (ph) return ph;
    // Last resort for unlabelled controls: name/id. Sites like autoplius use
    // descriptive names (make_date_from, price_to) that tell the agent exactly
    // what the control is — essential for driving forms.
    const attr = clean(el.getAttribute("name") || ctl.id);
    if (attr) return attr;
  }
  // 4. images
  if (tag === "IMG") {
    const alt = clean((el as HTMLImageElement).alt);
    if (alt) return alt;
  }
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

function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}

// ── State (compact) ──────────────────────────────────────────────────────────
export function stateOf(el: Element): string {
  const parts: string[] = [];
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    const ctl = el as HTMLInputElement;
    const isBtn = tag === "INPUT" && /^(submit|button|reset)$/.test(ctl.type);
    const v = clean(ctl.value);
    if (v && !isBtn) parts.push(`=${JSON.stringify(v.slice(0, 80))}`);
    if (ctl.disabled) parts.push("*disabled");
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
// A zero-size box means "invisible" only where a layout engine actually ran.
// Headless DOMs report 0×0 for every node, so probing <body> once tells us
// whether the rect check is evidence or noise.
const layoutCache = new WeakMap<Document, boolean>();
function hasLayout(doc: Document | null | undefined): boolean {
  if (!doc) return false;
  const cached = layoutCache.get(doc);
  if (cached !== undefined) return cached;
  const r = doc.body?.getBoundingClientRect?.();
  const has = !!r && (r.width > 0 || r.height > 0);
  layoutCache.set(doc, has);
  return has;
}

export function isVisible(el: Element): boolean {
  if (el.getAttribute("aria-hidden") === "true") return false;
  const doc = el.ownerDocument;
  const win = doc?.defaultView;
  if (win) {
    const style = win.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  if (hasLayout(doc)) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && el.childElementCount === 0) return false;
  }
  return true;
}

// ── Salience policy ──────────────────────────────────────────────────────────
type Decision = "emit" | "skip-subtree" | "transparent";

function classify(el: Element, role: string): Decision {
  if (SKIP_TAGS.has(el.tagName)) return "skip-subtree";
  if (el.getAttribute("aria-hidden") === "true") return "skip-subtree";
  if (role === "presentation" || role === "none") return "transparent";
  if (INTERACTIVE_ROLES.has(role) || STRUCTURAL_ROLES.has(role)) return "emit";
  if (el.hasAttribute("onclick") || el.getAttribute("tabindex") === "0") return "emit";
  return "transparent";
}

// ── Pruning filters ──────────────────────────────────────────────────────────
export interface Filter {
  name: string;
  match: string;        // URL glob, e.g. "godaddy.com/*/domainsearch/*"
  root?: string;        // CSS selector to start the walk at (keep only this subtree)
  drop?: string[];      // CSS selectors whose subtrees are removed
  dropText?: string[];  // regex/substring; matching text nodes are removed
  extract?: { item: string; fields: { name: string; sel?: string }[] };
}

function safeMatches(el: Element, sel: string): boolean {
  try { return el.matches(sel); } catch { return false; }
}

function safeMatchesAny(el: Element, sels: string[]): boolean {
  for (const s of sels) if (safeMatches(el, s)) return true;
  return false;
}

function globToRegex(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(esc);
}

/** Pick the filter whose URL glob matches; longest `match` wins. */
export function pickFilter(filters: Filter[], href: string): Filter | null {
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

// ── URL factoring ────────────────────────────────────────────────────────────
// List pages produce hrefs that are near-identical apart from an id, e.g.
// /details.html?id=459621723&con=USED&…&refId=<same-for-the-whole-search>.
// Printing all of them costs hundreds of tokens for a handful of differing
// characters, so we hoist the shared head and tail into the legend once.
export function factorUrls(urls: string[]): { prefix: string; suffix: string; mids: string[] } {
  const real = urls.filter(Boolean);
  if (real.length < 2) return { prefix: "", suffix: "", mids: urls.slice() };

  let prefix = real[0];
  for (const u of real.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < u.length && prefix[i] === u[i]) i++;
    prefix = prefix.slice(0, i);
  }
  const rest = real.map((u) => u.slice(prefix.length));
  let suffix = rest[0];
  for (const r of rest.slice(1)) {
    let i = 0;
    while (i < suffix.length && i < r.length && suffix[suffix.length - 1 - i] === r[r.length - 1 - i]) i++;
    suffix = suffix.slice(suffix.length - i);
  }
  // Never let the head and tail overlap on the shortest member.
  const shortest = Math.min(...rest.map((r) => r.length));
  if (suffix.length > shortest) suffix = suffix.slice(suffix.length - shortest);
  // Not worth the legend line if it saves nothing.
  if (prefix.length + suffix.length < 12) return { prefix: "", suffix: "", mids: urls.slice() };

  const mids = urls.map((u) =>
    u ? u.slice(prefix.length, suffix.length ? u.length - suffix.length : undefined) : ""
  );
  return { prefix, suffix, mids };
}

function absoluteHref(el: Element, baseHref: string): string {
  const a = el.tagName === "A" && el.hasAttribute("href") ? el : el.querySelector("a[href]");
  const raw = a?.getAttribute("href");
  if (!raw || raw.startsWith("#") || /^(javascript|mailto|tel):/i.test(raw)) return "";
  try { return new URL(raw, baseHref).href; } catch { return raw; }
}

// ── The tree ─────────────────────────────────────────────────────────────────
// The walk builds nodes rather than strings so the collapse/dedup passes can
// reason about structure, and so refs are numbered LAST — only visible lines get
// one, which keeps numbering dense after things are hidden.
interface TNode {
  kind: "el" | "text" | "collapsed" | "omitted";
  role?: string;
  name?: string;
  state?: string;
  text?: string;
  el?: Element;
  els?: Element[];      // collapsed run members, in document order
  interactive?: boolean;
  leafByName?: boolean; // name already encodes the content
  count?: number;       // collapsed run length / omitted line count
  firstName?: string;
  lastName?: string;
  children: TNode[];
}

export interface SnapshotResult {
  url: string;
  count: number;
  tree: string;
  applied: string | null;
  rootApplied?: string | null;
  dropped: { subtrees: number; textLines: number };
  chrome: number;         // universal-chrome subtrees removed
  collapsed: number;      // lines saved by run collapsing
  deduped: number;        // lines saved by subtree dedup
  rootMissing?: boolean;
  extracted?: boolean;
}

export interface SnapshotOpts {
  interactiveOnly?: boolean;
  filters?: Filter[];
  /** Universal chrome removal (footer/maps/consent). Default true. */
  chrome?: boolean;
  /** Collapse runs of look-alike siblings. Default true. */
  collapse?: boolean;
  /** Replace repeated identical subtrees with a marker. Default true. */
  dedup?: boolean;
}

/** Names that differ only by their numbers are "the same shape". */
function normName(name: string | undefined): string {
  return (name ?? "").replace(/\d+/g, "#");
}

// COLLAPSE — `[13-43] button "Weiter 1…31" ×31 collapsed`.
// Only childless siblings of the same role and same digit-normalised name, and
// only when their refs will end up contiguous, so a single range stays honest.
function collapseRuns(children: TNode[], stats: { collapsed: number }): TNode[] {
  const out: TNode[] = [];
  let i = 0;
  while (i < children.length) {
    const head = children[i];
    if (head.kind !== "el" || head.children.length || !head.interactive) { out.push(head); i++; continue; }
    let j = i + 1;
    if ((head.name ?? "").length > COLLAPSE_MAX_NAME || head.el!.hasAttribute("href")) {
      out.push(head); i++; continue;
    }
    while (
      j < children.length &&
      children[j].kind === "el" &&
      children[j].children.length === 0 &&
      children[j].interactive &&
      children[j].role === head.role &&
      (children[j].name ?? "").length <= COLLAPSE_MAX_NAME &&
      !children[j].el!.hasAttribute("href") &&
      normName(children[j].name) === normName(head.name)
    ) j++;
    const run = j - i;
    if (run >= COLLAPSE_MIN) {
      const members = children.slice(i, j);
      out.push({
        kind: "collapsed",
        role: head.role,
        els: members.map((m) => m.el!),
        count: run,
        firstName: head.name,
        lastName: members[run - 1].name,
        children: [],
      });
      stats.collapsed += run - 1; // one line stands in for the whole run
    } else {
      for (const m of children.slice(i, j)) out.push(m);
    }
    i = j;
  }
  for (const n of out) if (n.children.length) n.children = collapseRuns(n.children, stats);
  return out;
}

/** Ref-free rendering of a subtree — the identity used for dedup. */
function shapeOf(n: TNode): string {
  if (n.kind === "text") return `t:${n.text}`;
  if (n.kind === "collapsed") return `c:${n.role}:${normName(n.firstName)}:${n.count}`;
  if (n.kind === "omitted") return `o:${n.count}`;
  const self = `${n.role}|${n.name ?? ""}|${n.state ?? ""}`;
  return n.children.length ? `${self}(${n.children.map(shapeOf).join(",")})` : self;
}

function countLines(n: TNode): number {
  return 1 + n.children.reduce((a, c) => a + countLines(c), 0);
}

/** Interactive elements inside a subtree, document order — so an elided block
 *  keeps its refs and stays clickable instead of becoming a dead end. */
function interactiveEls(n: TNode, into: Element[] = []): Element[] {
  if (n.kind === "collapsed") into.push(...(n.els ?? []));
  else if (n.kind === "el" && n.interactive && n.el) into.push(n.el);
  for (const c of n.children) interactiveEls(c, into);
  return into;
}

// DEDUP — sites render the same block twice (autoplius ships its entire
// financing calculator top and bottom, verbatim). The second copy is paid for in
// full but adds nothing, so replace it with a one-line marker.
function dedupTree(root: TNode, stats: { deduped: number }): void {
  const seen = new Set<string>();
  const visit = (node: TNode) => {
    const kept: TNode[] = [];
    for (const child of node.children) {
      const lines = countLines(child);
      if (child.kind === "el" && lines >= DEDUP_MIN_LINES) {
        const shape = shapeOf(child);
        if (seen.has(shape)) {
          // Keep the refs: the copy is redundant to *read*, but its controls are
          // still real and may be the ones on screen. This also means a repeated
          // table stays reachable rather than vanishing behind the marker.
          kept.push({ kind: "omitted", count: lines, els: interactiveEls(child), children: [] });
          stats.deduped += lines - 1;
          continue;
        }
        seen.add(shape);
      }
      visit(child);
      kept.push(child);
    }
    node.children = kept;
  };
  visit(root);
}

// ── Serialisation + ref numbering ────────────────────────────────────────────
function render(root: TNode): { tree: string; count: number } {
  refMap = new Map();
  let ref = 0;
  const lines: string[] = [];

  const emit = (n: TNode, depth: number) => {
    const pad = "  ".repeat(depth);
    if (n.kind === "text") { lines.push(`${pad}${JSON.stringify(n.text)}`); return; }
    if (n.kind === "omitted") {
      const els = n.els ?? [];
      let span = "";
      if (els.length) {
        const first = ++ref;
        refMap.set(first, els[0]);
        for (let k = 1; k < els.length; k++) refMap.set(++ref, els[k]);
        span = els.length === 1 ? `, ref [${first}]` : `, refs [${first}-${ref}] still clickable`;
      }
      lines.push(`${pad}↩ identical to an earlier block (${n.count} lines omitted${span})`);
      return;
    }
    if (n.kind === "collapsed") {
      const first = ++ref;
      refMap.set(first, n.els![0]);
      for (let k = 1; k < n.els!.length; k++) refMap.set(++ref, n.els![k]);
      const last = ref;
      const span = n.firstName && n.lastName && n.firstName !== n.lastName
        ? ` "${n.firstName}…${n.lastName}"`
        : n.firstName ? ` "${n.firstName}"` : "";
      lines.push(`${pad}[${first}-${last}] ${n.role}${span} ×${n.count} collapsed`);
      return;
    }
    let line = pad;
    if (n.interactive) {
      const id = ++ref;
      refMap.set(id, n.el!);
      line += `[${id}] `;
    }
    line += (n.role || n.el!.tagName.toLowerCase()) + (n.name ? ` "${n.name}"` : "") + (n.state ?? "");
    lines.push(line);
    for (const c of n.children) emit(c, depth + 1);
  };

  for (const c of root.children) emit(c, 0);
  return { tree: lines.join("\n"), count: ref };
}

// ── Extraction mode ──────────────────────────────────────────────────────────
// One positional row per item, fields read from DOM nodes: `[id] v1;v2;…` with a
// leading legend. Items keep refs so click still works, and each row carries its
// href (factored) so following a result needs no extra round-trip.
function extractRows(filter: Filter, root: ParentNode, baseHref: string): { tree: string; count: number } {
  const ex = filter.extract!;
  const items = Array.from(root.querySelectorAll(ex.item)).filter((el) => isVisible(el));
  refMap = new Map();

  const rows = items.map((item, idx) => {
    refMap.set(idx + 1, item);
    return ex.fields.map((f) => {
      const el = f.sel ? item.querySelector(f.sel) : item;
      return clean(el?.textContent).replace(/;/g, ","); // guard the delimiter
    });
  });

  const hrefs = items.map((el) => absoluteHref(el, baseHref));
  const anyHref = hrefs.some(Boolean);
  const { prefix, suffix, mids } = anyHref ? factorUrls(hrefs) : { prefix: "", suffix: "", mids: hrefs };

  const names = ex.fields.map((f) => f.name);
  if (anyHref) names.push("url");
  let legend = `# ${filter.name} | ${items.length} items | id;${names.join(";")}`;
  if (anyHref && (prefix || suffix)) {
    legend += `\n# url = ${JSON.stringify(prefix)} + <url> + ${JSON.stringify(suffix)}`;
  }

  const lines = [legend];
  rows.forEach((vals, idx) => {
    const all = anyHref ? [...vals, mids[idx] ?? ""] : vals;
    lines.push(`[${idx + 1}] ${all.join(";")}`);
  });
  return { tree: lines.join("\n"), count: items.length };
}

// ── Entry point ──────────────────────────────────────────────────────────────
export function snapshot(doc: Document, opts: SnapshotOpts = {}): SnapshotResult {
  const interactiveOnly = !!opts.interactiveOnly;
  const useChrome = opts.chrome !== false;
  const useCollapse = opts.collapse !== false;
  const useDedup = opts.dedup !== false;
  const baseHref = doc.defaultView?.location?.href ?? doc.baseURI ?? "";

  const filter = pickFilter(opts.filters ?? [], baseHref);
  const dropSel = filter?.drop ?? [];
  const dropText = (filter?.dropText ?? []).map(textMatcher);
  let droppedSubtrees = 0;
  let droppedText = 0;
  let chromeDropped = 0;

  let rootNode: Element = doc.body;
  let rootMissing = false;
  if (filter?.root) {
    const r = doc.querySelector(filter.root);
    if (r) rootNode = r; else rootMissing = true;
  }

  // Extraction mode. Falls through to the normal walk if it finds zero items
  // (selector stale / wrong page variant).
  if (filter?.extract) {
    const res = extractRows(filter, rootNode, baseHref);
    if (res.count > 0) {
      return {
        url: baseHref, count: res.count, tree: res.tree,
        applied: filter.name, rootApplied: filter.root ?? null,
        dropped: { subtrees: 0, textLines: 0 },
        chrome: 0, collapsed: 0, deduped: 0,
        rootMissing, extracted: true,
      };
    }
  }

  const tree: TNode = { kind: "el", children: [] };

  const walk = (node: Node, into: TNode) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3 /* TEXT_NODE */) {
        if (interactiveOnly) continue;
        const t = clean(child.textContent);
        if (!t) continue;
        if (dropText.some((m) => m(t))) { droppedText++; continue; }
        into.children.push({ kind: "text", text: t.slice(0, 200), children: [] });
        continue;
      }
      if (child.nodeType !== 1 /* ELEMENT_NODE */) continue;
      const el = child as Element;
      if (!isVisible(el)) continue;
      if (useChrome && safeMatchesAny(el, CHROME_SELECTORS)) { chromeDropped++; continue; }
      if (dropSel.length && safeMatchesAny(el, dropSel)) { droppedSubtrees++; continue; }
      const role = roleOf(el);
      const decision = classify(el, role);
      if (decision === "skip-subtree") continue;
      if (decision !== "emit") { walk(el, into); continue; } // transparent wrapper
      const interactive = isInteractive(el, role);
      if (interactiveOnly && !interactive) { walk(el, into); continue; }
      const name = accessibleName(el);
      const n: TNode = {
        kind: "el", role, name, state: stateOf(el), el, interactive,
        leafByName: NAME_IS_CONTENT.has(role) && !!name,
        children: [],
      };
      into.children.push(n);
      if (!n.leafByName) walk(el, n);
    }
  };

  walk(rootNode, tree);

  const stats = { collapsed: 0, deduped: 0 };
  if (useCollapse) tree.children = collapseRuns(tree.children, stats);
  if (useDedup) dedupTree(tree, stats);

  const { tree: text, count } = render(tree);
  return {
    url: baseHref,
    count,
    tree: text,
    applied: filter?.name ?? null,
    rootApplied: filter?.root && !rootMissing ? filter.root : null,
    dropped: { subtrees: droppedSubtrees, textLines: droppedText },
    chrome: chromeDropped,
    collapsed: stats.collapsed,
    deduped: stats.deduped,
    rootMissing,
  };
}

// ── browser_links ────────────────────────────────────────────────────────────
// The cheap answer to "what can I navigate to from here". A snapshot costs
// thousands of tokens and still doesn't contain a single URL; this returns just
// label → href, with the shared head/tail hoisted out once.
export interface LinksResult {
  url: string;
  total: number;
  prefix: string;
  suffix: string;
  links: { text: string; url: string }[];
}

export function collectLinks(
  doc: Document,
  opts: { root?: Element; limit?: number } = {}
): LinksResult {
  const baseHref = doc.defaultView?.location?.href ?? doc.baseURI ?? "";
  const scope: ParentNode = opts.root ?? doc.body;
  const limit = opts.limit ?? 200;

  const seen = new Set<string>();
  const found: { text: string; href: string }[] = [];
  for (const a of Array.from(scope.querySelectorAll("a[href]"))) {
    if (!isVisible(a)) continue;
    const href = absoluteHref(a, baseHref);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    found.push({ text: clean(a.textContent).slice(0, 100) || clean(a.getAttribute("title")) || "—", href });
  }
  const total = found.length;
  const kept = found.slice(0, limit);
  const { prefix, suffix, mids } = factorUrls(kept.map((l) => l.href));
  return {
    url: baseHref,
    total,
    prefix,
    suffix,
    links: kept.map((l, i) => ({ text: l.text, url: mids[i] ?? l.href })),
  };
}
