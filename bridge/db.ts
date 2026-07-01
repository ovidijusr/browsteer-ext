import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Fixed app-data location: ~/.browsteer/browsteer.db — independent of the
// process's cwd AND of where the repo is checked out. (A relative path silently
// created a second DB wherever the bridge was launched; even a source-anchored
// path would break if the project moved. One absolute home-dir store avoids both.)
const DB_DIR = join(homedir(), ".browsteer");
mkdirSync(DB_DIR, { recursive: true });
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

const insert = db.prepare(
  `INSERT INTO actions (ts, tab_url, tool, ref, value, ok, error, element_count)
   VALUES ($ts, $tab_url, $tool, $ref, $value, $ok, $error, $element_count)`
);

export interface ActionRecord {
  tab_url?: string | null;
  tool: string;
  ref?: number | null;
  value?: string | null;
  ok: boolean;
  error?: string | null;
  element_count?: number | null;
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
