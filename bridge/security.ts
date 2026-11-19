// Hub security: who may connect, and what a connected session may reach.
// Pure helpers plus the small amount of state kept under ~/.browsteer. hub.ts
// decides when to call them; nothing here talks to the browser.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";

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
  /** The only folder browser_upload may read from. */
  uploadDir: string;
  /** Days of action log to keep. */
  logDays: number;
  /** Which model answers semantic targeting, as written (targeting.ts parses and checks it). */
  targeting?: Record<string, unknown>;
}
const DEFAULTS: Config = {
  jev: false, extensions: [], siteLock: true, fetchWrite: false, fetchAnySite: false,
  downloadDir: join(homedir(), "Downloads", "browsteer"), uploadDir: join(homedir(), "Downloads", "browsteer-upload"), logDays: 30,
};
const CONFIG_PATH = join(DATA_DIR, "config.json");

export function loadConfig(): Config {
  let raw: any = {};
  try { raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch {}
  const c: Config = { ...DEFAULTS };
  for (const k of ["jev", "siteLock", "fetchWrite", "fetchAnySite"] as const) if (typeof raw[k] === "boolean") c[k] = raw[k];
  if (Array.isArray(raw.extensions)) c.extensions = raw.extensions.filter((x: unknown) => typeof x === "string");
  if (typeof raw.downloadDir === "string" && raw.downloadDir) c.downloadDir = expandHome(raw.downloadDir);
  if (typeof raw.uploadDir === "string" && raw.uploadDir) c.uploadDir = expandHome(raw.uploadDir);
  if (Number.isFinite(raw.logDays) && raw.logDays > 0) c.logDays = raw.logDays;
  if (raw.targeting && typeof raw.targeting === "object" && !Array.isArray(raw.targeting)) c.targeting = raw.targeting;
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
  if (typeof given !== "string" || expected.length < 32) return false; // an unset token matches nothing
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
/**
 * The official store builds, trusted on every machine in addition to config "extensions".
 * A store install has the same ID everywhere, so it can be named here; an unpacked build
 * (ID from its folder path) or a temporary Firefox install (random UUID) cannot.
 * Empty for now: the Chrome Web Store item ID goes here, as
 * "chrome-extension://<32-letter item ID>", once the store item exists. Firefox gives each
 * profile its own moz-extension:// UUID, so AMO installs can never be listed. Nothing else
 * is ever trusted without the person: only this list, config "extensions", and the first
 * extension to connect while that list is empty.
 */
export const STORE_EXTENSIONS: readonly string[] = [];

/** Is this extension the one this hub belongs to? With no list yet, the first to register is remembered. */
export function extensionAllowed(origin: string, allowed: string[], store: readonly string[] = STORE_EXTENSIONS): "yes" | "first" | "no" {
  if (allowed.includes(origin)) return "yes";
  // Even a store build is remembered when it is the first: the empty list must not stay
  // open for whatever connects next.
  if (!allowed.length) return "first";
  return store.includes(origin) ? "yes" : "no";
}

// ── Sites ────────────────────────────────────────────────────────────────────
// One definition, shared with the extension, which enforces the lock for actions.
export { siteOf, sameSite } from "../extension/src/site";

// ── Downloads ────────────────────────────────────────────────────────────────
/** Resolve a saveTo path; it must land inside the download folder. Bare names are placed there. */
export function resolveSavePath(saveTo: string, downloadDir: string): { path: string } | { error: string } {
  const dir = resolve(downloadDir);
  const wanted = expandHome(saveTo);
  const path = resolve(dir, wanted);
  if (path !== dir && path.startsWith(dir + sep)) return { path };
  return { error: `saveTo must be inside ${dir} (give a file name, or a path under that folder). Change "downloadDir" in ~/.browsteer/config.json to use another folder.` };
}

// ── Uploads ──────────────────────────────────────────────────────────────────
// browser_upload is the one tool that sends a file from this computer to a page,
// so it reads from one folder only: the person (or Claude, through its own tools
// and their permission prompts) has to put a file there first.
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv",
  ".json": "application/json", ".md": "text/markdown", ".html": "text/html", ".zip": "application/zip",
  ".xpi": "application/x-xpinstall", ".doc": "application/msword", ".mp4": "video/mp4", ".mp3": "audio/mpeg",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
export const mimeOf = (name: string) => MIME[extname(name).toLowerCase()] ?? "application/octet-stream";

/**
 * A file browser_upload may send: inside the upload folder after following links,
 * a regular file, and within the size limit. Bare names are looked up in the folder.
 */
export function resolveUploadFile(name: string, uploadDir: string, maxBytes = UPLOAD_MAX_BYTES):
  { path: string; name: string; size: number; type: string } | { error: string } {
  const dir = resolve(uploadDir);
  const outside = `Files can only be uploaded from ${dir}. Copy the file there first, then pass its name. Change "uploadDir" in ~/.browsteer/config.json to use another folder.`;
  const path = resolve(dir, expandHome(name));
  if (path === dir || !path.startsWith(dir + sep)) return { error: outside };
  let real: string, realDir: string;
  try { realDir = realpathSync(dir); } catch { try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {} return { error: `The upload folder ${dir} was empty; it exists now. Put the file there, then try again.` }; }
  try { real = realpathSync(path); } catch { return { error: `No file named ${JSON.stringify(name)} in ${dir}.` }; }
  // A link inside the folder that points elsewhere is still outside.
  if (!real.startsWith(realDir + sep)) return { error: outside };
  const st = statSync(real);
  if (!st.isFile()) return { error: `${JSON.stringify(name)} is not a file.` };
  if (st.size > maxBytes) return { error: `${basename(real)} is ${(st.size / 1048576).toFixed(1)} MB; the limit is ${maxBytes / 1048576} MB.` };
  return { path: real, name: basename(real), size: st.size, type: mimeOf(real) };
}

/** What was typed into a field never goes into the action log — it may be a password. */
export function redact(v: unknown): string {
  return `‹${String(v ?? "").length} chars›`;
}
