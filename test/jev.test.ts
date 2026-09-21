// Pure-function tests for the Jev targeting module — no API calls, no browser.
import { describe, expect, test } from "bun:test";
import { parseCandidates, trimState, chunk, CHOICE_MAX, MAX_STATE_CHARS, THRESHOLDS } from "../bridge/jev";

const TREE = `URL: https://example.test
  [1] link "Home"
  heading "Results"
  "plain page text that carries no ref"
  [2] button "Search" =disabled
  [3] textbox "q" ="bmw i4"
  [13-43] button "Weiter 1…Weiter 31" ×31 collapsed
  ↩ identical to an earlier block (14 lines omitted, refs [92-96] still clickable)
    [44] link "BMW i4 eDrive40, 2023"`;

describe("parseCandidates", () => {
  test("one candidate per [N] line, ranges and text skipped", () => {
    const c = parseCandidates(TREE);
    expect(c.map((x) => x.ref)).toEqual([1, 2, 3, 44]);
    expect(c[1]).toMatchObject({ role: "button", name: "Search" });
    expect(c[2].name).toBe("q"); // =state stripped
    expect(c[3].name).toBe("BMW i4 eDrive40, 2023");
  });
  test("empty tree → no candidates", () => {
    expect(parseCandidates("URL: x\n  heading \"nothing\"")).toEqual([]);
  });
});

describe("trimState", () => {
  test("small trees untouched", () => expect(trimState(TREE)).toBe(TREE));
  test("drops text lines first, then cuts from the bottom", () => {
    const big = Array.from({ length: 4000 }, (_, i) => (i % 2 ? `  "text ${i} ${"x".repeat(40)}"` : `  [${i}] link "item ${i}"`)).join("\n");
    const t = trimState(big, 20_000);
    expect(t.length).toBeLessThanOrEqual(20_000);
    expect(t).not.toMatch(/^\s*"/m);          // no text lines survive
    expect(t.split("\n").at(-1)).toMatch(/^\s*\[\d+\] link/); // cut on a line boundary
    expect(MAX_STATE_CHARS).toBeLessThan(130_000); // ≈32k tokens is the API cap
  });
});

describe("chunk", () => {
  test("splits at the Choice option limit", () => {
    const parts = chunk(Array.from({ length: 600 }, (_, i) => i), CHOICE_MAX);
    expect(parts.length).toBe(3);
    expect(parts[0].length).toBe(255);
    expect(parts[2].length).toBe(90);
  });
});

test("thresholds are ordered sensibly", () => {
  expect(THRESHOLDS.stuck).toBeLessThan(THRESHOLDS.actConfidence);
  expect(THRESHOLDS.guard).toBeLessThan(THRESHOLDS.exists);
  expect(THRESHOLDS.reached).toBeGreaterThan(THRESHOLDS.blocked);
});

import { needsGuard, RISK_RE } from "../bridge/jev";
describe("needsGuard lexicon", () => {
  test("plain links and named navigation buttons skip the guard", () => {
    expect(needsGuard({ role: "link", name: "BMW i4 eDrive40, 2023" })).toBe(false);
    expect(needsGuard({ role: "button", name: "Libraries17" })).toBe(false);
    expect(needsGuard({ role: "button", name: "Nightcore42" })).toBe(false);
  });
  test("commitment words in any language and nameless controls are guarded", () => {
    expect(needsGuard({ role: "button", name: "Buy now" })).toBe(true);
    expect(needsGuard({ role: "link", name: "Delete account" })).toBe(true);
    expect(needsGuard({ role: "button", name: "Apmokėti" })).toBe(true);
    expect(needsGuard({ role: "button", name: "Ištrinti" })).toBe(true);
    expect(needsGuard({ role: "button", name: "" })).toBe(true);
    expect(RISK_RE.test("Siųsti žinutę")).toBe(true);
  });
});

import { RISK_WEAK_RE, normName, memoMatch, dedupeCandidates, slimTree, candKey, MEMO } from "../bridge/jev";
describe("guard lexicon: whole words, weak words only on buttons", () => {
  test("Booking.com / Posts / Share (as links) are navigation, not commitments", () => {
    expect(needsGuard({ role: "link", name: "Booking.com" })).toBe(false);
    expect(needsGuard({ role: "link", name: "Posts" })).toBe(false);
    expect(needsGuard({ role: "link", name: "Share" })).toBe(false);
    expect(needsGuard({ role: "link", name: "Order history" })).toBe(false);
  });
  test("the same weak words on a button are guarded; strong words guard links too", () => {
    expect(needsGuard({ role: "button", name: "Post" })).toBe(true);
    expect(needsGuard({ role: "button", name: "Book now" })).toBe(true);
    expect(needsGuard({ role: "button", name: "Booking" })).toBe(false);
    expect(needsGuard({ role: "link", name: "Log out" })).toBe(true);
    expect(RISK_WEAK_RE.test("Reply")).toBe(true);
  });
});

describe("memos", () => {
  const cands = parseCandidates(`URL: x
  [1] button "music.ovi.lt"
  [3] button "Playlists42"
  [21] button "Meme songs69"
  [46] button "New playlist"
  [50] button "New playlist"
  [68] button "Meme songs69 tracks"`);
  test("trailing live counts are ignored in the name", () => {
    expect(normName("Playlists42")).toBe("playlists");
    expect(normName("Inbox (3)")).toBe("inbox");
    expect(normName("Meme songs69 tracks")).toBe("meme songs69 tracks");
  });
  test("a memo resolves to the fresh ref even after the count changed", () => {
    expect(memoMatch({ role: "button", name: "Playlists41" }, cands)?.ref).toBe(3);
    expect(memoMatch({ role: "button", name: "Meme songs70" }, cands)?.ref).toBe(21);
  });
  test("renamed/removed control or wrong role → null (ask Jev)", () => {
    expect(memoMatch({ role: "button", name: "Libraries17" }, cands)).toBeNull();
    expect(memoMatch({ role: "link", name: "Playlists42" }, cands)).toBeNull();
  });
  test("exact duplicates are one element; distinct near-names are ambiguous only if names differ", () => {
    expect(memoMatch({ role: "button", name: "New playlist" }, cands)?.ref).toBe(46);
  });
  test("memo thresholds are stricter than act thresholds", () => {
    expect(MEMO.minConfidence).toBeGreaterThan(THRESHOLDS.actConfidence);
    expect(MEMO.minExists).toBeGreaterThan(THRESHOLDS.exists);
  });
});

describe("state slimming", () => {
  const cands = parseCandidates(`URL: x
      [1] button "New playlist"
        [2] textbox "q" ="bmw"
      [3] button "New playlist"
      [4] link "${"very long title ".repeat(20)}"`);
  test("exact (role,name) duplicates fold to the first ref", () => {
    const { kept, dropped } = dedupeCandidates(cands);
    expect(dropped).toBe(1);
    expect(kept.map((c) => c.ref)).toEqual([1, 2, 4]);
  });
  test("slim tree is flat, keeps state, caps names", () => {
    const t = slimTree(dedupeCandidates(cands).kept);
    const lines = t.split("\n");
    expect(lines.every((l) => l.startsWith("  ["))).toBe(true);
    expect(lines[1]).toContain('="bmw"');
    expect(lines[2].length).toBeLessThan(130);
    expect(lines[2]).toContain("…");
  });
  test("candKey is role+name, independent of ref", () => {
    expect(candKey({ role: "button", name: "X" })).toBe(candKey({ role: "button", name: "X" }));
    expect(candKey({ role: "link", name: "X" })).not.toBe(candKey({ role: "button", name: "X" }));
  });
});

import { lexicalMatch, buildState } from "../bridge/jev";
import { normTarget } from "../bridge/db";
describe("lexical fast path", () => {
  const cands = parseCandidates(`URL: x
  [2] button "Libraries17"
  [3] button "Playlists42"
  [21] button "Meme songs69"
  [47] textbox "Search all music..."
  [49] button "Settings"
  [68] button "Meme songs69 tracks"`);
  test("target that spells the element's name resolves without Jev", () => {
    expect(lexicalMatch("the Playlists section tab", cands)?.ref).toBe(3);
    expect(lexicalMatch("open the Libraries tab", cands)?.ref).toBe(2);
  });
  test("only the row whose whole name is spelled matches; a longer sibling name does not compete", () => {
    expect(lexicalMatch("open the Meme songs playlist", cands)?.ref).toBe(21); // "Meme songs69 tracks" is not contained in the target
  });
  test("two distinct elements with the same spelled name → ambiguous → null", () => {
    const two = parseCandidates('  [1] button "Settings"\n  [2] link "Settings"');
    expect(lexicalMatch("open Settings", two)).toBeNull();
  });
  test("relational or descriptive targets go to the model", () => {
    expect(lexicalMatch("the button next to Settings", cands)).toBeNull();
    expect(lexicalMatch("the search box", cands)).toBeNull(); // name is "search all music...", not contained
    expect(lexicalMatch("not the Settings button", cands)).toBeNull();
  });
  test("short names never match (\"Go\", \"OK\")", () => {
    expect(lexicalMatch("press go", parseCandidates('  [1] button "Go"'))).toBeNull();
  });
});

describe("buildState keeps page text in place, slims controls", () => {
  const tree = `URL: x
  heading "Playlists"
    [1] button "New playlist"
    "42 playlists"
    [2] button "New playlist"
    [3] button "${"x".repeat(200)}"`;
  test("dedupes controls, keeps text between them, caps names", () => {
    const { tree: t, cands, deduped } = buildState({ url: "x", tree });
    expect(deduped).toBe(1);
    expect(cands.map((c) => c.ref)).toEqual([1, 3]);
    const lines = t.split("\n");
    expect(lines[1]).toBe('  heading "Playlists"');
    expect(lines[3]).toBe('  "42 playlists"');
    expect(lines[4].length).toBeLessThan(120);
  });
  test("excluded role+name keys leave both state and candidates", () => {
    const { cands } = buildState({ url: "x", tree, exclude: new Set([candKey({ role: "button", name: "New playlist" })]) });
    expect(cands.map((c) => c.ref)).toEqual([3]);
  });
});

describe("memo target key", () => {
  test("filler words dropped, role words kept", () => {
    expect(normTarget("Open the Playlists tab.")).toBe("playlists tab");
    expect(normTarget("the playlists tab")).toBe("playlists tab");
    expect(normTarget("the search box")).not.toBe(normTarget("the search button"));
  });
});
