// Memo store round trip against an isolated DB (BROWSTEER_DB_DIR is set by bunfig preload / here).
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.BROWSTEER_DB_DIR ??= mkdtempSync(join(tmpdir(), "bst-memos-"));
const db = await import("../bridge/db");

describe("memo store", () => {
  beforeAll(() => db.clearMemos());
  test("save, get (normalized target + host), bump, list, clear", () => {
    db.saveMemo("https://music.ovi.lt/#/playlists", "The Playlists tab.", "button", "Playlists42");
    const m = db.getMemo("https://music.ovi.lt/#/libraries", "the playlists tab");
    expect(m?.name).toBe("Playlists42");
    expect(m?.hits).toBe(0);
    db.bumpMemo(m!.id);
    expect(db.getMemo("https://music.ovi.lt/", "the playlists tab")?.hits).toBe(1);
    expect(db.getMemo("https://other.host/", "the playlists tab")).toBeNull();
    db.saveMemo("https://other.host/", "search", "textbox", "q");
    expect(db.listMemos().length).toBe(2);
    expect(db.listMemos("other.host").length).toBe(1);
    expect(db.clearMemos("other.host")).toBe(1);
    expect(db.pruneMemos(60_000)).toBe(0); // last_hit is fresh → nothing to prune
    expect(db.clearMemos()).toBe(1);
  });
  test("re-saving the same target replaces the element and resets hits", () => {
    db.saveMemo("https://a.b/", "t", "button", "Old");
    db.bumpMemo(db.getMemo("https://a.b/", "t")!.id);
    db.saveMemo("https://a.b/", "t", "button", "New");
    const m = db.getMemo("https://a.b/", "t")!;
    expect(m.name).toBe("New"); expect(m.hits).toBe(0);
    db.clearMemos();
  });
});
