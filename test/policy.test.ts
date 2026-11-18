// The extension's access rules:  bun test test/policy.test.ts
import { describe, expect, test } from "bun:test";
import { ARM_MINUTES, DEFAULT_SETTINGS, FOREVER, KEY_RE, alwaysOnPatch, armUntil, covers, genKey, isArmed, isWrite, refusal, siteAllowed, type Settings } from "../extension/src/policy";
import { needsGuard } from "../extension/src/risk";

const NOW = 1_800_000_000_000;
const armed = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, armedUntil: NOW + 60_000, ...over });

describe("pairing key", () => {
  test("has the documented shape and does not repeat", () => {
    const keys = new Set(Array.from({ length: 200 }, () => genKey()));
    expect(keys.size).toBe(200);
    for (const k of keys) expect(k).toMatch(KEY_RE);
  });
  test("skips bytes that would bias the alphabet", () => {
    const bytes = [255, 250, 248, ...Array.from({ length: 21 }, (_, i) => i)];
    expect(genKey(() => new Uint8Array(bytes))).toBe("bst-abcd-efgh-jkmn");
  });
});

describe("access window", () => {
  const HOUR = ARM_MINUTES * 60_000;
  test("off by default: allowing opens for an hour", () => {
    expect(DEFAULT_SETTINGS.alwaysOn).toBe(false);
    expect(armUntil(DEFAULT_SETTINGS, NOW)).toBe(NOW + HOUR);
  });
  test("always on: allowing opens until Stop", () => {
    const s = { ...DEFAULT_SETTINGS, alwaysOn: true };
    expect(armUntil(s, NOW)).toBe(FOREVER);
    expect(isArmed({ ...s, armedUntil: FOREVER }, NOW + 10 * 365 * 86_400_000)).toBe(true);
    expect(new Date(FOREVER).getTime()).toBe(FOREVER); // still a valid date
  });
  test("turning it on while locked does not open access", () => {
    expect(alwaysOnPatch(DEFAULT_SETTINGS, true, NOW)).toEqual({ alwaysOn: true });
  });
  test("turning it on while open extends; turning it off caps at an hour", () => {
    expect(alwaysOnPatch(armed(), true, NOW)).toEqual({ alwaysOn: true, armedUntil: FOREVER });
    expect(alwaysOnPatch(armed({ alwaysOn: true, armedUntil: FOREVER }), false, NOW)).toEqual({ alwaysOn: false, armedUntil: NOW + HOUR });
    expect(alwaysOnPatch(armed(), false, NOW)).toEqual({ alwaysOn: false, armedUntil: NOW + 60_000 });
  });
});

describe("sites", () => {
  test("an entry covers its subdomains but not look-alikes", () => {
    expect(covers("example.com", "example.com")).toBe(true);
    expect(covers("example.com", "app.example.com")).toBe(true);
    expect(covers("example.com", "notexample.com")).toBe(false);
    expect(covers("example.com", "example.com.evil.test")).toBe(false);
  });
  test("nothing is allowed until the person allows it", () => {
    expect(siteAllowed(armed(), "example.com")).toBe(false);
    expect(siteAllowed(armed({ allow: ["example.com"] }), "docs.example.com")).toBe(true);
  });
  test("a block wins over an allow, and over 'every site' mode", () => {
    expect(siteAllowed(armed({ allow: ["example.com"], block: ["mail.example.com"] }), "mail.example.com")).toBe(false);
    expect(siteAllowed(armed({ siteMode: "block", block: ["bank.test"] }), "bank.test")).toBe(false);
    expect(siteAllowed(armed({ siteMode: "block", block: ["bank.test"] }), "wiki.test")).toBe(true);
  });
});

describe("the gate", () => {
  const ok = armed({ allow: ["example.com"] });
  test("locked: nothing passes", () => {
    expect(refusal({ ...ok, armedUntil: 0 }, "snapshot", {}, "example.com", NOW)).toContain("locked");
    expect(refusal({ ...ok, armedUntil: NOW - 1 }, "snapshot", {}, "example.com", NOW)).toContain("locked");
  });
  test("armed on an allowed site: passes", () => {
    expect(refusal(ok, "click", { ref: 1 }, "example.com", NOW)).toBe(null);
  });
  test("a site that was never allowed is refused by name", () => {
    expect(refusal(ok, "snapshot", {}, "mail.test", NOW)).toContain("mail.test is not on the user's allowed list");
  });
  test("browser pages are refused", () => {
    expect(refusal(ok, "snapshot", {}, null, NOW)).toContain("not a web page");
  });
  test("read-only lets reads through and stops everything else", () => {
    const ro = { ...ok, readOnly: true };
    for (const op of ["snapshot", "read", "links", "form", "html", "scan"]) expect(refusal(ro, op, {}, "example.com", NOW)).toBe(null);
    for (const op of ["click", "fill", "select", "press", "type", "navigate", "dialogs"]) expect(refusal(ro, op, {}, "example.com", NOW)).toContain("read-only");
    expect(refusal(ro, "fetch", { method: "GET" }, "example.com", NOW)).toBe(null);
    expect(refusal(ro, "fetch", { method: "POST" }, "example.com", NOW)).toContain("read-only");
  });
  test("an op this file has never heard of counts as a write", () => {
    expect(isWrite("something_new", {})).toBe(true);
  });
});

describe("commitment-sounding controls", () => {
  test("strong words are guarded on any control", () => {
    expect(needsGuard({ role: "button", name: "Delete account" })).toBe(true);
    expect(needsGuard({ role: "link", name: "Sign out" })).toBe(true);
  });
  test("weak words only on buttons; plain navigation is free", () => {
    expect(needsGuard({ role: "button", name: "Share" })).toBe(true);
    expect(needsGuard({ role: "link", name: "Orders" })).toBe(false);
    expect(needsGuard({ role: "button", name: "Next page" })).toBe(false);
  });
});
