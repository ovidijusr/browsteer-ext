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
