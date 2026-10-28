// Content script — runs in every page. Executes click/fill/read actions on
// behalf of the bridge and returns accessibility snapshots.
//
// The snapshot/serialisation core lives in ./snapshot.ts, which is pure
// DOM-in/string-out so it can be unit-tested without a browser. This file keeps
// the parts that genuinely need the page: actions, the element picker, and the
// extension message plumbing.
//
// `browser` is the global provided by @types/firefox-webext-browser.
import {
  snapshot, collectLinks, formReport, getRef, clean, isVisible,
  absoluteHref, type Filter,
} from "./snapshot";
import {
  scan, clickAt, realClick, typeInto, editableIn, setDialogPolicy, drainDialogs, installDialogHooks,
} from "./fallback";

installDialogHooks(window);

// ── Actions ──────────────────────────────────────────────────────────────────
function resolve(ref: number): Element {
  const el = getRef(ref);
  if (!el || !el.isConnected) {
    throw new Error(`No live element for ref ${ref}. The page changed — call browser_snapshot again.`);
  }
  return el;
}

// Settle detection lives in the HUB, not here: page timers (setTimeout /
// setInterval / rAF) are throttled to seconds in background tabs, so an
// in-page wait blew past its own cap. The page only keeps a mutation counter;
// the hub polls `pulse` over messaging (which is not throttled) and decides.
let mutations = 0;
try {
  new MutationObserver(() => { mutations++; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
} catch {}
function pulse() {
  return { url: location.href, mutations, ready: document.readyState };
}

function doClick(ref: number) {
  const el = resolve(ref) as HTMLElement;
  el.scrollIntoView({ block: "center" });
  const before = mutations;
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  realClick(hitTarget(el, x, y), x, y);
  return { url: location.href, mutations: before, pulse: true };
}

// A real click lands on the innermost element under the pointer and bubbles up.
// Dispatching on the ref itself skips handlers bound to its children: the
// usjticketing.com calendar ref is the outer day box, but Vue's @click sits on
// the inner .dateCell, so the day looked selected and "Add to cart" stayed
// disabled (2026-10). Hit-test the centre and use that element when it lies
// inside the ref; an overlay covering the ref is not what the caller meant.
function hitTarget(el: HTMLElement, x: number, y: number): HTMLElement {
  const hit = document.elementFromPoint(x, y);
  return hit instanceof HTMLElement && el.contains(hit) ? hit : el;
}

function doClickAt(x: number, y: number) {
  const before = mutations;
  const r = clickAt(document, x, y);
  return { url: location.href, mutations: before, pulse: true, hit: r.hit };
}

function doFill(ref: number, value: string) {
  const ref0 = resolve(ref);
  // A custom-element host (<gds-input>, <my-field>) is not the field; the input inside it is.
  const el = (ref0 instanceof HTMLSelectElement ? ref0 : editableIn(ref0)) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
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
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    // `value` is "on" either way — the state is what the caller is asking about.
    text = `${el.checked ? "checked" : "unchecked"}${el.value && el.value !== "on" ? ` (value ${el.value})` : ""}`;
  } else if (el instanceof HTMLSelectElement) {
    const opt = el.options[el.selectedIndex];
    text = opt ? `${clean(opt.text)}${opt.value ? ` (value ${opt.value})` : " (no value — placeholder)"}` : "";
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    text = el.value;
  } else {
    text = clean(el.textContent);
  }
  return { url: location.href, text };
}

// fetch AS THE PAGE: Firefox's `content.fetch` carries the page's Origin/Referer, so
// same-origin APIs that reject extension-origin requests (Booking's /dml/graphql → 403)
// answer normally. The background `fetch` op stays the default for cross-origin reads.
async function pageFetch(p: any) {
  const w: any = globalThis as any;
  const method = String(p.method ?? "GET").toUpperCase();
  const init = { method, credentials: "include", headers: p.headers ?? {}, body: method === "GET" || method === "HEAD" ? undefined : p.body };
  // Objects handed to the page's fetch must live in the page compartment (cloneInto), else
  // "Permission denied to access property 'constructor'". Read the body as text — a page-side
  // ArrayBuffer is just as unreachable. (Text-only is fine: this op exists for page APIs.)
  const res = w.content?.fetch && w.cloneInto ? await w.content.fetch(String(p.url), w.cloneInto(init, window)) : await fetch(String(p.url), init as RequestInit);
  const txt: string = await res.text();
  const bytes = new TextEncoder().encode(txt);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return { status: res.status, contentType: String(res.headers.get("content-type") ?? ""), finalUrl: String(res.url), size: bytes.length, bodyBase64: btoa(bin) };
}

// Escape hatch: raw HTML when the a11y snapshot flattens away needed detail.
// Scope to a `ref` (just that element's subtree) to keep it cheap.
function doHtml(ref: number | undefined, stripNoise = true, up = 0, offset = 0, maxBytes = 50_000) {
  let el = (ref != null ? resolve(ref) : document.documentElement) as HTMLElement;
  for (let i = 0; i < up && el.parentElement; i++) el = el.parentElement; // climb to a container
  let html: string;
  if (stripNoise) {
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
// autocomplete, ArrowDown to move a highlight.
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
    case "snapshot":
      return snapshot(document, {
        interactiveOnly: params?.interactiveOnly,
        filters: params?.filters as Filter[] | undefined,
        // `raw` turns off every reduction pass, not just the saved filters.
        chrome: params?.chrome,
        collapse: params?.collapse,
        dedup: params?.dedup,
      });
    case "links": {
      const root = params?.ref != null ? (resolve(params.ref) as Element) : undefined;
      const r = collectLinks(document, { root, limit: params?.limit });
      // Report whether the scoped element is still the one we were given.
      return { ...r, scoped: params?.ref != null };
    }
    case "form": {
      const root = params?.ref != null ? (resolve(params.ref) as Element) : undefined;
      return formReport(document, { root });
    }
    case "href": { const el = resolve(params.ref) as Element; return { url: location.href, href: absoluteHref(el, location.href) }; }
    case "click": return params?.ref == null && params?.x != null ? doClickAt(params.x, params.y) : doClick(params.ref);
    case "scan": {
      const root = params?.ref != null ? (resolve(params.ref) as Element) : undefined;
      return scan(document, { root, step: params?.step, limit: params?.limit });
    }
    case "type": return { url: location.href, ...typeInto(resolve(params.ref), String(params.value ?? ""), { commit: !!params.commit }) };
    case "dialogs": return { url: location.href, policy: setDialogPolicy({ confirm: params?.confirm, prompt: params?.prompt }), seen: drainDialogs() };
    case "pulse": return pulse();
    case "fill": return doFill(params.ref, params.value);
    case "select": return doSelect(params.ref, params.value);
    case "options": return doOptions(params.ref);
    case "read": return doRead(params.ref);
    case "html": return doHtml(params.ref, params.clean ?? true, params.up ?? 0, params.offset ?? 0, params.maxBytes ?? 50_000);
    case "press": return doPress(params.key, params.ref);
    case "pick": return startPicker(); // returns a Promise (waits for the user)
    case "pageFetch": return pageFetch(params);
    default: throw new Error(`Unknown op '${op}'`);
  }
}

// Re-exported so the bundle keeps the symbol even if a future op needs it.
void isVisible;

browser.runtime.onMessage.addListener(
  (msg: any, _sender: unknown, sendResponse: (r: unknown) => void) => {
    if (!msg || typeof msg.op !== "string") return false; // not for us (e.g. popup msgs)
    // handleOp may return a value or a Promise (pick waits for a click) — await both.
    Promise.resolve()
      .then(() => handleOp(msg.op, msg.params))
      .then((result) => {
        // alert() text raised by this op (or since the last one) rides back with any reply.
        const seen = msg.op === "dialogs" ? [] : drainDialogs();
        if (seen.length && result && typeof result === "object") (result as any)._dialogs = seen;
        sendResponse({ ok: true, result });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
    return true; // async response
  }
);
