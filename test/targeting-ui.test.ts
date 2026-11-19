// The Settings page → background → bridge path for the targeting provider
// (extension/src/targeting.ts): what the background forwards, and the words the
// pages show. The bridge half is in hub.test.ts ("targeting provider").
import { describe, expect, test } from "bun:test";
import { REPLY, choiceOf, hubMessage, popupHint, popupSetup, privacyText, readTargeting } from "../extension/src/targeting";

describe("hubMessage: what the background passes on from a Settings page", () => {
  test("a provider pick becomes provider + preset; the address only for Custom", () => {
    expect(hubMessage({ type: "setTargeting", choice: "typesafe", baseUrl: "https://x.example" })).toEqual({ type: "setTargeting", provider: "typesafe" });
    expect(hubMessage({ type: "setTargeting", choice: "nexos", baseUrl: "https://evil.example/v1" })).toEqual({ type: "setTargeting", provider: "openai", preset: "nexos" });
    expect(hubMessage({ type: "setTargeting", choice: "custom", baseUrl: "  https://llm.corp.example/v1 " })).toEqual({ type: "setTargeting", provider: "openai", preset: "custom", baseUrl: "https://llm.corp.example/v1" });
    expect(hubMessage({ type: "setTargeting", choice: "nexos", model: "gpt-4.1-mini" })).toEqual({ type: "setTargeting", provider: "openai", preset: "nexos", model: "gpt-4.1-mini" });
  });
  test("unknown providers, odd model names and malformed keys go nowhere", () => {
    expect(hubMessage({ type: "setTargeting", choice: "evil" })).toBe(null);
    expect(hubMessage({ type: "setTargeting", choice: "nexos", model: "gpt 4; rm -rf" })).toBe(null);
    expect(hubMessage({ type: "setTargetingKey", key: "short" })).toBe(null);
    expect(hubMessage({ type: "setTargetingKey", key: "abc def ghi jkl" })).toBe(null);
    expect(hubMessage({ type: "somethingElse" })).toBe(null);
  });
  test("a key is trimmed and forwarded once; the other messages carry nothing extra", () => {
    expect(hubMessage({ type: "setTargetingKey", key: " nx-0123456789 " })).toEqual({ type: "setTargetingKey", key: "nx-0123456789" });
    expect(hubMessage({ type: "listModels", baseUrl: "https://evil.example" })).toEqual({ type: "listModels" });
    expect(hubMessage({ type: "testTargeting", provider: "x" })).toEqual({ type: "testTargeting" });
  });
  test("every message knows which bridge answer to wait for", () => {
    for (const t of ["setTargeting", "setTargetingKey", "removeTargetingKey", "listModels", "testTargeting"]) expect(REPLY[t]).toBeDefined();
    expect(REPLY.testTargeting.type).toBe("targetingTest");
  });
});

describe("what the pages say", () => {
  const nexos = readTargeting({ provider: "openai", preset: "nexos", label: "nexos.ai", baseUrl: "https://api.nexos.ai/v1", host: "api.nexos.ai", local: false, model: "gpt-4.1-mini", keyNeeded: true, calibrated: true, key: "never" })!;
  const local = readTargeting({ provider: "openai", preset: "ollama", label: "Local (Ollama)", baseUrl: "http://127.0.0.1:11434/v1", host: "127.0.0.1:11434", local: true, model: "", keyNeeded: false, calibrated: null })!;
  test("readTargeting keeps known fields only", () => {
    expect(nexos).not.toHaveProperty("key");
    expect(readTargeting({ provider: "anthropic" })).toBe(null);
    expect(choiceOf(null)).toBe("typesafe");
    expect(choiceOf(nexos)).toBe("nexos");
  });
  test("the privacy line names the actual host, or says it stays here", () => {
    expect(privacyText(nexos)).toContain("`api.nexos.ai`");
    expect(privacyText(local)).toContain("stay here");
    expect(privacyText(null)).toContain("`api.typesafe.ai`");
  });
  test("the popup row follows the provider", () => {
    expect(popupHint(true, nexos)).toBe("On. Sends page outlines to nexos.ai.");
    expect(popupHint(true, local)).toBe("On. Runs on this computer (Ollama).");
    expect(popupHint(false, null)).toBe("Off. When on, sends page outlines to TypeSafe.");
    expect(popupSetup(nexos)).toBe("Off. Add a nexos.ai key in Settings →");
  });
});
