// Pure-function tests for the hub's security rules:  bun test test/security.test.ts
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { STORE_EXTENSIONS, classifyOrigin, extensionAllowed, resolveSavePath, resolveUploadFile, sameSite, siteOf, tokenMatches } from "../bridge/security";

describe("origins", () => {
  test("web pages are refused, extensions and local programs are told apart", () => {
    expect(classifyOrigin("https://evil.example")).toBe("refused");
    expect(classifyOrigin("http://localhost:3000")).toBe("refused");
    expect(classifyOrigin("null")).toBe("refused");
    expect(classifyOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop")).toBe("extension");
    expect(classifyOrigin("moz-extension://0b3c2d1e-aaaa-bbbb-cccc-000000000000")).toBe("extension");
    expect(classifyOrigin("chrome-extension://abc/evil")).toBe("refused");
    expect(classifyOrigin(null)).toBe("local");
  });

  test("the first extension is remembered; others are refused afterwards", () => {
    expect(extensionAllowed("chrome-extension://aaa", [])).toBe("first");
    expect(extensionAllowed("chrome-extension://aaa", ["chrome-extension://aaa"])).toBe("yes");
    expect(extensionAllowed("chrome-extension://bbb", ["chrome-extension://aaa"])).toBe("no");
    // A store build is trusted next to the configured ones, and still fills an empty list first.
    const store = ["chrome-extension://store"];
    expect(extensionAllowed("chrome-extension://store", ["chrome-extension://aaa"], store)).toBe("yes");
    expect(extensionAllowed("chrome-extension://store", [], store)).toBe("first");
    expect(extensionAllowed("chrome-extension://bbb", ["chrome-extension://aaa"], store)).toBe("no");
    expect(STORE_EXTENSIONS.every((o) => /^chrome-extension:\/\/[a-p]{32}$/.test(o))).toBe(true);
  });
});

describe("token", () => {
  test("only the exact token matches", () => {
    const t = "a".repeat(64);
    expect(tokenMatches(t, t)).toBe(true);
    expect(tokenMatches(t, "a".repeat(63) + "b")).toBe(false);
    expect(tokenMatches(t, "a".repeat(10))).toBe(false);
    expect(tokenMatches(t, undefined)).toBe(false);
  });
});

describe("sites", () => {
  test("subdomains belong to one site", () => {
    expect(siteOf("https://app.example.com/x")).toBe("example.com");
    expect(sameSite("https://app.example.com/a", "https://www.example.com/b")).toBe(true);
    expect(sameSite("https://example.com/", "https://example.org/")).toBe(false);
  });
  test("two-part public suffixes are not treated as one site", () => {
    expect(siteOf("https://shop.example.co.uk/")).toBe("example.co.uk");
    expect(sameSite("https://a.co.uk/", "https://b.co.uk/")).toBe(false);
  });
  test("IPs, localhost and non-web addresses", () => {
    expect(siteOf("http://127.0.0.1:8080/")).toBe("127.0.0.1");
    expect(siteOf("http://localhost:3000/")).toBe("localhost");
    expect(siteOf("chrome://settings")).toBe(null);
    expect(sameSite("about:blank", "about:blank")).toBe(false);
  });
});

describe("download folder", () => {
  const dir = resolve("/home/u/Downloads/browsteer"); // C:\home\u\… on Windows
  test("bare names and paths inside the folder are accepted", () => {
    expect(resolveSavePath("report.json", dir)).toEqual({ path: join(dir, "report.json") });
    expect(resolveSavePath(`${dir}/sub/a.pdf`, dir)).toEqual({ path: join(dir, "sub", "a.pdf") });
  });
  test("anything that escapes it is refused", () => {
    expect("error" in resolveSavePath("../../.ssh/authorized_keys", dir)).toBe(true);
    expect("error" in resolveSavePath("/etc/hosts", dir)).toBe(true);
    expect("error" in resolveSavePath(`${dir}/../other/x`, dir)).toBe(true);
    expect("error" in resolveSavePath(dir, dir)).toBe(true);
  });
});

describe("upload folder", () => {
  const root = mkdtempSync(join(tmpdir(), "browsteer-up-"));
  const dir = join(root, "upload");
  mkdirSync(dir);
  writeFileSync(join(dir, "icon.png"), "png");
  writeFileSync(join(root, "secret.txt"), "secret");
  mkdirSync(join(dir, "sub"));

  test("a file in the folder is found by name, with its type", () => {
    const r = resolveUploadFile("icon.png", dir) as any;
    expect(r.name).toBe("icon.png");
    expect(r.size).toBe(3);
    expect(r.type).toBe("image/png");
  });
  test("paths out of the folder are refused", () => {
    expect("error" in resolveUploadFile("../secret.txt", dir)).toBe(true);
    expect("error" in resolveUploadFile(join(root, "secret.txt"), dir)).toBe(true);
    expect("error" in resolveUploadFile("~/.ssh/id_ed25519", dir)).toBe(true);
  });
  test("a link inside the folder that points out of it is refused", () => {
    let linked = true;
    try { symlinkSync(join(root, "secret.txt"), join(dir, "link.txt")); } catch { linked = false; } // Windows needs a privilege for links
    if (linked) expect((resolveUploadFile("link.txt", dir) as any).error).toContain("only be uploaded from");
  });
  test("folders, missing files and big files are refused", () => {
    expect("error" in resolveUploadFile("sub", dir)).toBe(true);
    expect("error" in resolveUploadFile("nope.png", dir)).toBe(true);
    expect((resolveUploadFile("icon.png", dir, 2) as any).error).toContain("limit");
  });
  test("a missing folder is created, and nothing is sent", () => {
    const fresh = join(root, "not-yet");
    expect((resolveUploadFile("a.png", fresh) as any).error).toContain("exists now");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("shared hosting is not one site", () => {
  test("each subdomain of a hosting platform is its own site", () => {
    expect(siteOf("https://alice.github.io/x")).toBe("alice.github.io");
    expect(sameSite("https://alice.github.io/", "https://evil.github.io/")).toBe(false);
    expect(sameSite("https://a.vercel.app/", "https://b.vercel.app/")).toBe(false);
    expect(sameSite("https://docs.alice.github.io/", "https://alice.github.io/")).toBe(true);
  });
  test("an unset token matches nothing, not even an empty string", () => {
    expect(tokenMatches("", "")).toBe(false);
  });
});
