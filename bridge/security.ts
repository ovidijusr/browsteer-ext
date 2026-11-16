// Hub security: who may connect, and what a connected session may reach.
// Pure helpers plus the small amount of state kept under ~/.browsteer. hub.ts
// decides when to call them; nothing here talks to the browser.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export const DATA_DIR = process.env.BROWSTEER_DB_DIR || join(homedir(), ".browsteer");

// ── Config ───────────────────────────────────────────────────────────────────
// ~/.browsteer/config.json. Every switch defaults to the strict setting; a
// missing or unreadable file means "all defaults".
export interface Config {
  /** Send page outlines to TypeSafe for semantic targeting (see jev.ts). */
  jev: boolean;
  /** Extension origins allowed to register as a browser. Empty = remember the first one seen. */
  extensions: string[];
  /** Keep a session on the site it started on. */
  siteLock: boolean;
  /** browser_fetch: allow methods other than GET/HEAD. */
  fetchWrite: boolean;
  /** browser_fetch: allow URLs outside the session's site. */
  fetchAnySite: boolean;
  /** The only folder browser_fetch({saveTo}) may write into. */
  downloadDir: string;
  /** Days of action log to keep. */
  logDays: number;
}
const DEFAULTS: Config = {
  jev: false, extensions: [], siteLock: true, fetchWrite: false, fetchAnySite: false,
  downloadDir: join(homedir(), "Downloads", "browsteer"), logDays: 30,
};
const CONFIG_PATH = join(DATA_DIR, "config.json");

export function loadConfig(): Config {
  let raw: any = {};
  try { raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch {}
  const c: Config = { ...DEFAULTS };
  for (const k of ["jev", "siteLock", "fetchWrite", "fetchAnySite"] as const) if (typeof raw[k] === "boolean") c[k] = raw[k];
  if (Array.isArray(raw.extensions)) c.extensions = raw.extensions.filter((x: unknown) => typeof x === "string");
  if (typeof raw.downloadDir === "string" && raw.downloadDir) c.downloadDir = expandHome(raw.downloadDir);
  if (Number.isFinite(raw.logDays) && raw.logDays > 0) c.logDays = raw.logDays;
  return c;
}

/** Merge keys into config.json, keeping whatever else the user wrote there. */
export function updateConfig(patch: Partial<Config>): void {
  let raw: any = {};
  try { raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch {}
  writePrivate(CONFIG_PATH, JSON.stringify({ ...raw, ...patch }, null, 2) + "\n");
}

export function expandHome(p: string): string {
  return p.replace(/^~(?=\/|\\|$)/, homedir());
}

/** Create/overwrite a file only this user can read. */
export function writePrivate(path: string, data: string): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(path, data, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {} // mode above only applies on create
}

/** Tighten the data folder and anything already in it (database, WAL files). */
export function lockDownDataDir(files: string[]): void {
  try { chmodSync(DATA_DIR, 0o700); } catch {}
  for (const f of files) { try { if (existsSync(f)) chmodSync(f, 0o600); } catch {} }
}

// ── Control token ────────────────────────────────────────────────────────────
// Anything that drives the hub (the MCP shim, cli.ts, `hub --stop`) must present
// this secret. It lives in a file only this user can read, so another account
// on the machine, or a process that cannot read the home folder, cannot drive
// the browser even though it can reach 127.0.0.1.
const TOKEN_PATH = join(DATA_DIR, "token");

export function readToken(): string | null {
  try { const t = readFileSync(TOKEN_PATH, "utf8").trim(); return t.length >= 32 ? t : null; } catch { return null; }
}
export function ensureToken(): string {
  const have = readToken();
  if (have) { try { chmodSync(TOKEN_PATH, 0o600); } catch {} return have; }
  const t = randomBytes(32).toString("hex");
  writePrivate(TOKEN_PATH, t + "\n");
  return t;
}
export function tokenMatches(expected: string, given: unknown): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(expected), b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Origins ──────────────────────────────────────────────────────────────────
export type Peer = "extension" | "local" | "refused";
/**
 * Browsers always send an Origin on WebSocket handshakes. A web page (http/https
 * origin) is refused outright. An extension origin may only ever act as a
 * browser; a client with no Origin (a local program) may only ever act as a
 * controller, and needs the token for that.
 */
export function classifyOrigin(origin: string | null): Peer {
  if (!origin) return "local";
  return /^(moz|chrome)-extension:\/\/[a-z0-9-]+$/i.test(origin) ? "extension" : "refused";
}
/** Is this extension the one this hub belongs to? With no list yet, the first to register is remembered. */
export function extensionAllowed(origin: string, allowed: string[]): "yes" | "first" | "no" {
  if (!allowed.length) return "first";
  return allowed.includes(origin) ? "yes" : "no";
}

// ── Sites ────────────────────────────────────────────────────────────────────
const MULTI_PART_TLD = /\.(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/;
/** Registrable domain, approximately: enough to tell app.example.com and example.com are one site. */
export function siteOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return null; host = u.hostname.toLowerCase(); } catch { return null; }
  if (/^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return host; // IP or single label
  const parts = host.split(".");
  return parts.slice(MULTI_PART_TLD.test(host) ? -3 : -2).join(".");
}
export function sameSite(a: string | null | undefined, b: string | null | undefined): boolean {
  const sa = siteOf(a), sb = siteOf(b);
  return !!sa && sa === sb;
}

// ── Downloads ────────────────────────────────────────────────────────────────
/** Resolve a saveTo path; it must land inside the download folder. Bare names are placed there. */
export function resolveSavePath(saveTo: string, downloadDir: string): { path: string } | { error: string } {
  const dir = resolve(downloadDir);
  const wanted = expandHome(saveTo);
  const path = resolve(dir, wanted);
  if (path !== dir && path.startsWith(dir + sep)) return { path };
  return { error: `saveTo must be inside ${dir} (give a file name, or a path under that folder). Change "downloadDir" in ~/.browsteer/config.json to use another folder.` };
}

/** What was typed into a field never goes into the action log — it may be a password. */
export function redact(v: unknown): string {
  return `‹${String(v ?? "").length} chars›`;
}
