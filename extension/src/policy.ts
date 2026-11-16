// The rules the person sets in the popup, and the checks the background applies
// to every request from the bridge before it reaches a page. Pure functions over
// plain data so they can be tested without a browser.

// ── Pairing key ──────────────────────────────────────────────────────────────
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alikes
export const KEY_RE = /^bst(-[a-z0-9]{4}){3}$/;

/** bst-xxxx-xxxx-xxxx from the browser's CSPRNG: 31^12 ≈ 7.9 × 10^17 possibilities. */
export function genKey(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const out: string[] = [];
  // Rejection sampling: 248 is the largest multiple of 31 below 256, so no letter is favoured.
  while (out.length < 12) for (const b of random(24)) if (b < 248 && out.length < 12) out.push(ALPHABET[b % 31]);
  return `bst-${out.slice(0, 4).join("")}-${out.slice(4, 8).join("")}-${out.slice(8).join("")}`;
}

// ── Settings ─────────────────────────────────────────────────────────────────
export interface Settings {
  /** Epoch ms until which Claude may work in this browser. 0 = locked. */
  armedUntil: number;
  /** Look, don't touch: reads only. */
  readOnly: boolean;
  /** "allow": only the listed sites. "block": every site except the listed ones. */
  siteMode: "allow" | "block";
  allow: string[];
  block: string[];
}
export const DEFAULT_SETTINGS: Settings = { armedUntil: 0, readOnly: false, siteMode: "allow", allow: [], block: [] };
export const ARM_MINUTES = 60;

export function isArmed(s: Settings, now = Date.now()): boolean {
  return s.armedUntil > now;
}

// ── Sites ────────────────────────────────────────────────────────────────────
/** Host of a web address, or null for anything that is not http(s). */
export function hostOf(url: string | undefined | null): string | null {
  try { const u = new URL(String(url)); return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase() : null; } catch { return null; }
}
/** An entry covers its own host and every subdomain of it. */
export function covers(entry: string, host: string): boolean {
  const e = entry.toLowerCase().replace(/^\*?\./, "");
  return !!e && (host === e || host.endsWith(`.${e}`));
}
export function siteAllowed(s: Settings, host: string | null): boolean {
  if (!host) return false;
  if (s.block.some((e) => covers(e, host))) return false; // a block always wins
  return s.siteMode === "block" || s.allow.some((e) => covers(e, host));
}

// ── Read-only ────────────────────────────────────────────────────────────────
const READS = new Set(["snapshot", "links", "form", "href", "scan", "read", "html", "options", "pulse", "tabs", "requests", "pageFetch", "fetch"]);
/** Does this op change the page, or anything on the site? */
export function isWrite(op: string, params: any): boolean {
  if (!READS.has(op)) return true;
  if (op === "fetch" || op === "pageFetch") { const m = String(params?.method ?? "GET").toUpperCase(); return m !== "GET" && m !== "HEAD"; }
  return false;
}

// ── The gate ─────────────────────────────────────────────────────────────────
// Every refusal is phrased for Claude to relay: what is blocked, and what the
// person (not Claude) can do about it. None of it can be changed from a page or
// through the bridge — only from the popup.
export function refusal(s: Settings, op: string, params: any, host: string | null, now = Date.now()): string | null {
  if (!isArmed(s, now))
    return "Browsteer is locked in this browser. Ask the user to open the Browsteer popup and choose “Allow Claude for 1 hour”.";
  if (s.readOnly && isWrite(op, params))
    return `This browser is in read-only mode, so '${op}' is refused. Reading (snapshot, read, links, form) still works. The user can turn off “Read only” in the Browsteer popup.`;
  if (op === "tabs" || op === "requests") return null; // filtered per entry instead
  if (!siteAllowed(s, host)) {
    if (!host) return "This address is not a web page Browsteer can work on.";
    return s.block.some((e) => covers(e, host))
      ? `${host} is on the user's blocked list. Browsteer will not read or operate it.`
      : `${host} is not on the user's allowed list. Ask the user to open that page, then choose “Allow ${host}” in the Browsteer popup.`;
  }
  return null;
}
