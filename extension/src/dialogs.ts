// alert / confirm / prompt handling, shared by both browsers.
//
// alert() is information: answer it and report the text. confirm()/prompt() are
// decisions: they stay native (the tab waits for a person) unless the caller set
// a policy for the NEXT one with browser_dialogs. Policies are one-shot.
//
// The replacements have to live where the page's own scripts can call them:
//   Firefox — the content script exports them into the page (exportFunction).
//   Chrome  — a tiny script runs in the page's world (dialogs-main.ts) and the
//             content script talks to it over DOM events (see relay below).
export type DialogPolicy = "native" | "accept" | "dismiss";
export type PolicyState = { confirm: DialogPolicy; prompt: string | null };
/** How long after the last request a tab still counts as "Claude is working here". */
export const ACTIVE_MS = 60_000;

export function createDialogs(win: Window) {
  const log: string[] = [];
  let nextConfirm: DialogPolicy = "native";
  let nextPromptValue: string | null = null;
  const nativeAlert = win.alert.bind(win);
  const nativeConfirm = win.confirm.bind(win);
  const nativePrompt = win.prompt.bind(win);
  // Dialogs are only handled while Claude is working in the tab: each request
  // from the bridge extends this window. Outside it the page gets the browser's
  // own dialogs, exactly as if the extension were not installed.
  let activeUntil = 0;
  const active = () => Date.now() < activeUntil;

  return {
    touch(ms = ACTIVE_MS): void { activeUntil = Date.now() + ms; },
    alert(msg?: unknown): void {
      if (!active()) return nativeAlert(msg as any);
      log.push(`alert ${JSON.stringify(String(msg ?? ""))} → OK (auto)`);
    },
    confirm(msg?: unknown): boolean {
      const text = String(msg ?? "");
      if (!active()) return nativeConfirm(text);
      if (nextConfirm === "native") {
        const a = nativeConfirm(text);
        log.push(`confirm ${JSON.stringify(text)} → ${a ? "OK" : "Cancel"} (by user)`);
        return a;
      }
      const a = nextConfirm === "accept";
      nextConfirm = "native";
      log.push(`confirm ${JSON.stringify(text)} → ${a ? "OK" : "Cancel"} (policy)`);
      return a;
    },
    prompt(msg?: unknown, def?: unknown): string | null {
      const text = String(msg ?? "");
      if (!active()) return nativePrompt(text, def == null ? undefined : String(def));
      if (nextPromptValue === null) {
        const a = nativePrompt(text, def == null ? undefined : String(def));
        log.push(`prompt ${JSON.stringify(text)} → ${JSON.stringify(a)} (by user)`);
        return a;
      }
      const a = nextPromptValue;
      nextPromptValue = null;
      log.push(`prompt ${JSON.stringify(text)} → ${JSON.stringify(a)} (policy)`);
      return a;
    },
    setPolicy(p: { confirm?: DialogPolicy; prompt?: string | null }): PolicyState {
      if (p.confirm === "native" || p.confirm === "accept" || p.confirm === "dismiss") nextConfirm = p.confirm;
      if (p.prompt !== undefined) nextPromptValue = p.prompt === null ? null : String(p.prompt);
      return { confirm: nextConfirm, prompt: nextPromptValue };
    },
    drain(): string[] {
      return log.splice(0);
    },
  };
}

// ── Relay between the content script and the page-world script (Chrome) ──────
// DOM events dispatch synchronously across script worlds, so a request gets its
// answer before dispatchEvent returns. Payloads are JSON strings: objects do not
// cross worlds. A page can see and forge these events; all it gains is control
// over how its own dialogs are answered, which it already has.
export const REQ = "browsteer:dialogs:req";
export const RES = "browsteer:dialogs:res";
export type RelayReq = { policy?: { confirm?: DialogPolicy; prompt?: string | null }; drain?: boolean; touch?: boolean };
export type RelayRes = { policy: PolicyState; seen: string[] };

export function relay(doc: Document, req: RelayReq): RelayRes | null {
  let res: RelayRes | null = null;
  const onRes = (e: Event) => { try { res = JSON.parse((e as CustomEvent).detail); } catch {} };
  doc.addEventListener(RES, onRes);
  try { doc.dispatchEvent(new CustomEvent(REQ, { detail: JSON.stringify(req) })); }
  finally { doc.removeEventListener(RES, onRes); }
  return res;
}
