// Fallbacks — the site-agnostic layer for when the a11y snapshot is not enough.
//
// The snapshot sees what the page *declares* (roles, names, labels, cursors).
// Every failure in 2026-10 was a page that declared nothing: <img> arrows,
// <td> days, hidden radios behind labels, web-component inputs, alert() boxes.
// Each got a targeted fix in snapshot.ts, but the next site will declare
// nothing in some new way. These fallbacks rely only on what the browser
// itself guarantees for every page:
//
//   • scan   — what is actually ON SCREEN: hit-test a grid of points with
//              elementFromPoint, so anything visible gets a ref, declared or not.
//   • clickAt — a real-shaped click (pointer/mouse down/up + click) on the
//              topmost element at a viewport point, for canvas and overlays.
//   • type   — text entry the way a keyboard does it (execCommand insertText,
//              then per-key events), into the real <input> even when the ref
//              is a custom-element host, and it reports whether the value stuck.
//   • dialogs — window.alert/confirm/prompt answered by policy instead of
//              freezing the tab, with every message reported back.
//
// They cost more tokens than the snapshot, so the snapshot stays the default
// and these are reached for when an action visibly failed.
import {
  accessibleName, pointerName, hasPointer, refreshPointerRules, roleOf, setRefs, clean,
  REAL_CONTROL_SEL,
} from "./snapshot";

// ── Hit testing ──────────────────────────────────────────────────────────────
/** elementFromPoint that descends through open shadow roots. */
export function deepElementAt(doc: Document, x: number, y: number): Element | null {
  let el = doc.elementFromPoint(x, y);
  while (el?.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

/** The pointer/mouse sequence a real click produces, at (x, y), then the click. */
export function realClick(target: HTMLElement, x: number, y: number): void {
  const at = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };
  const down = { ...at, buttons: 1 };
  const P = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
  target.dispatchEvent(new P("pointerdown", { ...down, pointerType: "mouse", isPrimary: true } as PointerEventInit));
  target.dispatchEvent(new MouseEvent("mousedown", down));
  (target as HTMLElement).focus?.({ preventScroll: true } as FocusOptions);
  target.dispatchEvent(new P("pointerup", { ...at, pointerType: "mouse", isPrimary: true } as PointerEventInit));
  target.dispatchEvent(new MouseEvent("mouseup", at));
  target.click();
}

export function clickAt(doc: Document, x: number, y: number): { hit: string } {
  const hit = deepElementAt(doc, x, y);
  if (!(hit instanceof HTMLElement)) throw new Error(`Nothing clickable at (${x}, ${y}) — coordinates are viewport CSS pixels from browser_scan.`);
  realClick(hit, x, y);
  return { hit: describe(hit) };
}

// ── Visual scan ──────────────────────────────────────────────────────────────
const MEDIA = new Set(["IMG", "SVG", "CANVAS", "VIDEO", "PICTURE"]);

function ownText(el: Element): string {
  let t = "";
  for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) t += n.textContent ?? "";
  return clean(t);
}

/** From the leaf the pointer hit, the element a person would say they clicked. */
function targetFor(hit: Element): Element {
  const control = hit.closest(REAL_CONTROL_SEL);
  if (control) return control;
  if (hasPointer(hit)) {
    let el = hit;
    while (el.parentElement && el.parentElement !== el.ownerDocument.body && hasPointer(el.parentElement)) el = el.parentElement;
    return el;
  }
  let el: Element | null = hit;
  for (let i = 0; el && i < 4; i++, el = el.parentElement) {
    if (ownText(el) || MEDIA.has(el.tagName.toUpperCase())) return el;
  }
  return hit;
}

function describe(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const name = (accessibleName(el) || pointerName(el) || ownText(el)).slice(0, 60);
  const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
  return `${tag}${cls ? "." + cls : ""}${name ? ` "${name}"` : ""}`;
}

export interface ScanResult { url: string; count: number; tree: string; area: string; truncated: boolean }

export function scan(doc: Document, opts: { root?: Element; step?: number; limit?: number } = {}): ScanResult {
  const win = doc.defaultView!;
  const step = Math.max(6, opts.step ?? 16);
  const limit = opts.limit ?? 120;
  refreshPointerRules(doc);
  if (opts.root) opts.root.scrollIntoView({ block: "center", inline: "center" });
  const vw = win.innerWidth, vh = win.innerHeight;
  const r = opts.root?.getBoundingClientRect() ?? { left: 0, top: 0, right: vw, bottom: vh };
  const L = Math.max(0, r.left), T = Math.max(0, r.top), R = Math.min(vw, r.right), B = Math.min(vh, r.bottom);

  const found = new Map<Element, true>();
  for (let y = T + step / 2; y < B; y += step) {
    for (let x = L + step / 2; x < R; x += step) {
      const hit = deepElementAt(doc, x, y);
      if (!hit || hit === doc.body || hit === doc.documentElement) continue;
      const t = targetFor(hit);
      if (opts.root && !opts.root.contains(t) && t !== opts.root) continue;
      found.set(t, true);
    }
  }

  const screen = vw * vh;
  const rows: { el: Element; line: string; top: number; left: number }[] = [];
  for (const el of found.keys()) {
    const b = el.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) continue;
    const control = el.matches(REAL_CONTROL_SEL);
    const pointer = !control && hasPointer(el);
    const desc = describe(el);
    // A big box with nothing of its own to say is layout, not a target.
    if (!control && !pointer && !/"/.test(desc)) continue;
    if (!control && b.width * b.height > screen * 0.4) continue;
    const role = roleOf(el);
    const flags = [control ? role || "control" : "", pointer ? "pointer" : ""].filter(Boolean).join(",");
    const cx = Math.round(b.left + b.width / 2), cy = Math.round(b.top + b.height / 2);
    rows.push({ el, top: b.top, left: b.left, line: `${desc} @${cx},${cy} ${Math.round(b.width)}x${Math.round(b.height)}${flags ? ` (${flags})` : ""}` });
  }
  rows.sort((a, b) => (Math.abs(a.top - b.top) < 4 ? a.left - b.left : a.top - b.top));
  const kept = rows.slice(0, limit);
  setRefs(kept.map((k) => k.el));
  return {
    url: win.location.href,
    count: kept.length,
    tree: kept.map((k, i) => `[${i + 1}] ${k.line}`).join("\n"),
    area: `${Math.round(R - L)}x${Math.round(B - T)} at ${Math.round(L)},${Math.round(T)} of a ${vw}x${vh} viewport`,
    truncated: rows.length > kept.length,
  };
}

// ── Typing ───────────────────────────────────────────────────────────────────
type Editable = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

// DOM constructors from the node's own window (an Xray of the page window in a
// Firefox content script; happy-dom's window in unit tests, where the runtime's
// own global Event would be rejected by dispatchEvent), else the globals.
function ctor(node: Node, name: string): any {
  return (node.ownerDocument?.defaultView as any)?.[name] ?? (globalThis as any)[name];
}
const isField = (el: Element): el is HTMLInputElement | HTMLTextAreaElement =>
  el.tagName === "INPUT" || el.tagName === "TEXTAREA";

/** The element that actually takes text: the ref itself, or the input inside a
 * custom-element host / wrapper (open shadow root first, then light DOM). */
export function editableIn(el: Element): Editable {
  const SEL = "input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable=''], [contenteditable=true]";
  if (el.matches(SEL)) return el as Editable;
  const inner = el.shadowRoot?.querySelector(SEL) ?? el.querySelector(SEL);
  if (inner) return inner as Editable;
  throw new Error(`ref is a <${el.tagName.toLowerCase()}> with no text field inside it.`);
}

function valueOf(el: Editable): string {
  return isField(el) ? el.value : el.textContent ?? "";
}

function setNative(el: Editable, v: string) {
  if (isField(el)) {
    // The prototype setter, not el.value = — React/Vue track the instance property.
    const proto = ctor(el, el.tagName === "TEXTAREA" ? "HTMLTextAreaElement" : "HTMLInputElement")?.prototype;
    const set = proto && Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (set) set.call(el, v); else el.value = v;
  } else el.textContent = v;
}

export function typeInto(target: Element, value: string, opts: { commit?: boolean } = {}) {
  const el = editableIn(target);
  const doc = el.ownerDocument;
  el.focus();
  // Select whatever is there so the typed text replaces it.
  if (isField(el)) { try { el.select(); } catch {} }
  else { const rg = doc.createRange(); rg.selectNodeContents(el); const s = doc.getSelection(); s?.removeAllRanges(); s?.addRange(rg); }

  let how = "insertText";
  let ok = false;
  try { ok = !!doc.execCommand?.("insertText", false, value) && valueOf(el) === value; } catch {}
  if (!ok) {
    // Per-key fallback: what frameworks that ignore execCommand still hear.
    how = "keys";
    const InputEvent = ctor(el, "InputEvent") ?? ctor(el, "Event");
    const KeyboardEvent = ctor(el, "KeyboardEvent") ?? ctor(el, "Event");
    setNative(el, "");
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    let cur = "";
    for (const ch of value) {
      const k = { key: ch, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent("keydown", k));
      el.dispatchEvent(new KeyboardEvent("keypress", k));
      cur += ch;
      setNative(el, cur);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
      el.dispatchEvent(new KeyboardEvent("keyup", k));
    }
  }
  el.dispatchEvent(new (ctor(el, "Event"))("change", { bubbles: true }));
  if (opts.commit) el.blur();
  const now = valueOf(el);
  return { how, value: now, stuck: now === value, field: describe(el) };
}

// ── Dialogs ──────────────────────────────────────────────────────────────────
// alert() is information: answer it and report the text. confirm()/prompt() are
// decisions: they stay native (the tab waits for a person) unless the caller set
// a policy for the NEXT one with browser_dialogs. Policies are one-shot.
export type DialogPolicy = "native" | "accept" | "dismiss";
const dialogLog: string[] = [];
let nextConfirm: DialogPolicy = "native";
let nextPromptValue: string | null = null;

export function setDialogPolicy(p: { confirm?: DialogPolicy; prompt?: string | null }) {
  if (p.confirm) nextConfirm = p.confirm;
  if (p.prompt !== undefined) nextPromptValue = p.prompt;
  return { confirm: nextConfirm, prompt: nextPromptValue };
}

export function drainDialogs(): string[] {
  return dialogLog.splice(0);
}

export function installDialogHooks(win: Window): void {
  const exp = (globalThis as any).exportFunction as ((f: Function, t: object, o: { defineAs: string }) => void) | undefined;
  if (!exp) return; // not Firefox content-script land (tests, other engines)
  const nativeConfirm = win.confirm.bind(win);
  const nativePrompt = win.prompt.bind(win);
  try {
    exp((msg?: unknown) => { dialogLog.push(`alert ${JSON.stringify(String(msg ?? ""))} → OK (auto)`); }, win, { defineAs: "alert" });
    exp((msg?: unknown) => {
      const text = String(msg ?? "");
      if (nextConfirm === "native") { const a = nativeConfirm(text); dialogLog.push(`confirm ${JSON.stringify(text)} → ${a ? "OK" : "Cancel"} (by user)`); return a; }
      const a = nextConfirm === "accept";
      nextConfirm = "native";
      dialogLog.push(`confirm ${JSON.stringify(text)} → ${a ? "OK" : "Cancel"} (policy)`);
      return a;
    }, win, { defineAs: "confirm" });
    exp((msg?: unknown, def?: unknown) => {
      const text = String(msg ?? "");
      if (nextPromptValue === null) { const a = nativePrompt(text, def == null ? undefined : String(def)); dialogLog.push(`prompt ${JSON.stringify(text)} → ${JSON.stringify(a)} (by user)`); return a; }
      const a = nextPromptValue;
      nextPromptValue = null;
      dialogLog.push(`prompt ${JSON.stringify(text)} → ${JSON.stringify(a)} (policy)`);
      return a;
    }, win, { defineAs: "prompt" });
  } catch { /* page froze its window props — leave natives in place */ }
}
