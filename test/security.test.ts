// Pure-function tests for the hub's security rules:  bun test test/security.test.ts
import { describe, expect, test } from "bun:test";
import { classifyOrigin, extensionAllowed, resolveSavePath, sameSite, siteOf, tokenMatches } from "../bridge/security";

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
  const dir = "/home/u/Downloads/browsteer";
  test("bare names and paths inside the folder are accepted", () => {
    expect(resolveSavePath("report.json", dir)).toEqual({ path: `${dir}/report.json` });
    expect(resolveSavePath(`${dir}/sub/a.pdf`, dir)).toEqual({ path: `${dir}/sub/a.pdf` });
  });
  test("anything that escapes it is refused", () => {
    expect("error" in resolveSavePath("../../.ssh/authorized_keys", dir)).toBe(true);
    expect("error" in resolveSavePath("/etc/hosts", dir)).toBe(true);
    expect("error" in resolveSavePath(`${dir}/../other/x`, dir)).toBe(true);
    expect("error" in resolveSavePath(dir, dir)).toBe(true);
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
