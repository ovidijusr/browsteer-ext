import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Fixed app-data location: ~/.browsteer/browsteer.db — independent of the
// process's cwd AND of where the repo is checked out. (A relative path silently
// created a second DB wherever the bridge was launched; even a source-anchored
// path would break if the project moved. One absolute home-dir store avoids both.)
//
// BROWSTEER_DB_DIR overrides it, so tests get an isolated store instead of
// reading the real saved filters (which would make them non-deterministic) and
// writing into the real action log.
const DB_DIR = process.env.BROWSTEER_DB_DIR || join(homedir(), ".browsteer");
mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });
const DB_PATH = join(DB_DIR, "browsteer.db");
const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS actions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    tab_url       TEXT,
    tool          TEXT NOT NULL,
    ref           INTEGER,
    value         TEXT,
    ok            INTEGER NOT NULL,
    error         TEXT,
    element_count INTEGER
  );
`);
// Added later: JSON blob for Jev verdicts (find/pursue) — the threshold-tuning data.
if (!db.query<{ name: string }, []>("PRAGMA table_info(actions)").all().some((c) => c.name === "detail")) {
  db.exec("ALTER TABLE actions ADD COLUMN detail TEXT");
}

const insert = db.prepare(
  `INSERT INTO actions (ts, tab_url, tool, ref, value, ok, error, element_count, detail)
   VALUES ($ts, $tab_url, $tool, $ref, $value, $ok, $error, $element_count, $detail)`
);

export interface ActionRecord {
  tab_url?: string | null;
  tool: string;
  ref?: number | null;
  value?: string | null;
  ok: boolean;
  error?: string | null;
  element_count?: number | null;
  detail?: unknown;
}

export function logAction(a: ActionRecord): void {
  insert.run({
    // Date.now() is intentional here — this is the bridge runtime, not a workflow script.
    $ts: Date.now(),
    $tab_url: a.tab_url ?? null,
    $tool: a.tool,
    $ref: a.ref ?? null,
    $value: a.value ?? null,
    $ok: a.ok ? 1 : 0,
    $error: a.error ?? null,
    $element_count: a.element_count ?? null,
    $detail: a.detail == null ? null : JSON.stringify(a.detail),
  });
}

// ── Pruning filters (Phase 2) ─────────────────────────────────────────────────
// A learned per-structure filter: CSS selectors that strip chrome from snapshots.
// `filter_json` holds { name, match, root?, drop?, dropText?, version }.
db.exec(`
  CREATE TABLE IF NOT EXISTS filters (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    match       TEXT NOT NULL,
    filter_json TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
`);

export interface Filter {
  name: string;
  match: string;
  root?: string;
  drop?: string[];
  dropText?: string[];
  extract?: { item: string; fields: { name: string; sel?: string }[] };
  version?: number;
}

const upsertStmt = db.prepare(
  `INSERT INTO filters (name, match, filter_json, created_at, updated_at)
   VALUES ($name, $match, $json, $now, $now)
   ON CONFLICT(name) DO UPDATE SET
     match = $match, filter_json = $json, updated_at = $now`
);
const listStmt = db.query<{ filter_json: string }, []>(`SELECT filter_json FROM filters ORDER BY name`);
const deleteStmt = db.prepare(`DELETE FROM filters WHERE name = $name`);
const getVersionStmt = db.query<{ filter_json: string }, { $name: string }>(
  `SELECT filter_json FROM filters WHERE name = $name`
);

/** Insert or update a filter by name; bumps `version`. Returns the stored filter. */
export function upsertFilter(f: Filter): Filter {
  const prev = getVersionStmt.get({ $name: f.name });
  const prevVersion = prev ? (JSON.parse(prev.filter_json).version ?? 0) : 0;
  const stored: Filter = { ...f, version: prevVersion + 1 };
  upsertStmt.run({ $name: f.name, $match: f.match, $json: JSON.stringify(stored), $now: Date.now() });
  return stored;
}

export function listFilters(): Filter[] {
  return listStmt.all().map((r) => JSON.parse(r.filter_json) as Filter);
}

export function deleteFilter(name: string): boolean {
  return deleteStmt.run({ $name: name }).changes > 0;
}

// ── Target memos (Jev bypass) ────────────────────────────────────────────────
// A memo remembers that, on this host, the plain-language target resolved to an
// element with this role + name (Jev said so with high confidence). Next time the
// hub matches the memo against the fresh snapshot and skips Jev entirely — zero
// tokens, zero round trip. Matching rules live in jev.ts (memoMatch).
db.exec(`
  CREATE TABLE IF NOT EXISTS memos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    host       TEXT NOT NULL,
    target     TEXT NOT NULL,
    role       TEXT NOT NULL,
    name       TEXT NOT NULL,
    hits       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_hit   INTEGER NOT NULL,
    UNIQUE(host, target)
  );
`);

export interface Memo { id: number; host: string; target: string; role: string; name: string; hits: number; created_at: number; last_hit: number }

/** Lowercase, single-spaced, no trailing punctuation, filler dropped — so "Open the Playlists tab." and
 *  "playlists tab" share a memo. Role words (tab/button/box/field/link) are KEPT: "search box" and
 *  "search button" are different elements. */
const FILLER_RE = /\b(the|a|an|to|of|on|in|into|open|click|go|please|then|and|now|me|it|that|this|for|with|at|pressed|hit|press|tap)\b/g;
export function normTarget(t: string): string {
  return t.toLowerCase().replace(FILLER_RE, " ").replace(/\s+/g, " ").replace(/[\s.!?,;:]+$/g, "").trim();
}
export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

const memoGet = db.query<Memo, { $host: string; $target: string }>(`SELECT * FROM memos WHERE host = $host AND target = $target`);
const memoPut = db.prepare(
  `INSERT INTO memos (host, target, role, name, hits, created_at, last_hit) VALUES ($host, $target, $role, $name, 0, $now, $now)
   ON CONFLICT(host, target) DO UPDATE SET role = $role, name = $name, hits = 0, created_at = $now, last_hit = $now`
);
const memoHit = db.prepare(`UPDATE memos SET hits = hits + 1, last_hit = $now WHERE id = $id`);
const memoDel = db.prepare(`DELETE FROM memos WHERE id = $id`);
const memoDelHost = db.prepare(`DELETE FROM memos WHERE host = $host`);
const memoDelAll = db.prepare(`DELETE FROM memos`);
const memoPrune = db.prepare(`DELETE FROM memos WHERE last_hit < $before`);
const memoList = db.query<Memo, []>(`SELECT * FROM memos ORDER BY host, hits DESC, target`);
const memoListHost = db.query<Memo, { $host: string }>(`SELECT * FROM memos WHERE host = $host ORDER BY hits DESC, target`);

export function getMemo(url: string, target: string): Memo | null {
  return memoGet.get({ $host: hostOf(url), $target: normTarget(target) }) ?? null;
}
export function saveMemo(url: string, target: string, role: string, name: string): void {
  memoPut.run({ $host: hostOf(url), $target: normTarget(target), $role: role, $name: name, $now: Date.now() });
}
export function bumpMemo(id: number): void { memoHit.run({ $id: id, $now: Date.now() }); }
export function dropMemo(id: number): void { memoDel.run({ $id: id }); }
export function clearMemos(host?: string): number {
  return host ? memoDelHost.run({ $host: host }).changes : memoDelAll.run().changes;
}
export function pruneMemos(maxAgeMs: number): number { return memoPrune.run({ $before: Date.now() - maxAgeMs }).changes; }
export function listMemos(host?: string): Memo[] { return host ? memoListHost.all({ $host: host }) : memoList.all(); }

// ── Housekeeping ─────────────────────────────────────────────────────────────
/** The database and its WAL side files, so the hub can make them private to this user. */
export function dbFiles(): string[] {
  return [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`];
}
/** Drop action-log rows older than maxAgeMs; returns how many went. */
export function pruneActions(maxAgeMs: number): number {
  return db.prepare("DELETE FROM actions WHERE ts < $before").run({ $before: Date.now() - maxAgeMs }).changes;
}
