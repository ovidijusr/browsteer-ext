// Version handshake between the extension, the hub and each session's shim:  bun test test/version.test.ts
import { describe, expect, test } from "bun:test";
import { VERSION, cmpVersion, extensionVersionNote } from "../bridge/version";

describe("cmpVersion", () => {
  test("numeric, not lexical", () => {
    expect(cmpVersion("2.0.0", "2.0.0")).toBe(0);
    expect(cmpVersion("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(cmpVersion("1.8.0", "2.0.0")).toBeLessThan(0);
    expect(cmpVersion("2.0", "2.0.0")).toBe(0);
    expect(cmpVersion("2.0.1", "2.0")).toBeGreaterThan(0);
  });
});

describe("extension/bridge mismatch note", () => {
  test("silent when they match", () => expect(extensionVersionNote(VERSION)).toBeNull());
  test("an older extension is told how to update", () => expect(extensionVersionNote("1.8.0", "2.0.0")).toContain("Check for Updates"));
  test("a newer extension asks for a bridge update", () => expect(extensionVersionNote("2.1.0", "2.0.0")).toContain("bun run update"));
  test("an extension that reports nothing predates the handshake", () => expect(extensionVersionNote(null, "2.0.0")).toContain("older than the bridge"));
});

test("VERSION is package.json's", async () => {
  expect(VERSION).toBe((await Bun.file(new URL("../package.json", import.meta.url)).json()).version);
});
