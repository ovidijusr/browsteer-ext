// Provider layer (bridge/targeting.ts): the OpenAI-compatible adapter against a
// mocked fetch, key files, base URL checks and config parsing. No network.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { choice, noul } from "@typesafe-ai/sdk";
import {
  checkBaseUrl, describeQuestions, forgetModes, knownMode, listModels, loadKey, openaiProvider, ranges,
  readLogprobAnswers, removeKey, saveKey, targetingConfig, type LogprobToken,
} from "../bridge/targeting";
import { findTarget } from "../bridge/jev";
import { TEST_TASKS, runTasks, scoreFind } from "../bridge/targeting-tasks";

const lp = (token: string, p: number, alts: [string, number][] = []): LogprobToken =>
  ({ token, logprob: Math.log(p), top_logprobs: [[token, p] as [string, number], ...alts].map(([t, q]) => ({ token: t, logprob: Math.log(q) })) });

const ids = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), null])) as Record<string, null>;
const Qs = {
  where_0_0: choice("Which element?", ids(50)),
  exists_0: noul("Is it there?", { true: "yes it is", false: "no" }),
};

describe("reading probabilities from logprobs", () => {
  test("a number that is one token: every alternative is a whole option", () => {
    const toks = [lp("where", 1), lp("_0_0", 1), lp(":", 1), lp(" 10", 0.8, [[" 9", 0.15], [" 7", 0.05]]), lp("\n", 1), lp("exists_0", 1), lp(":", 1), lp(" yes", 0.9, [[" no", 0.1]])];
    const a = readLogprobAnswers(toks, describeQuestions(Qs))!;
    expect(a.where_0_0.choice).toBe("10");
    expect(a.where_0_0.probabilities["10"]).toBeCloseTo(0.8, 5);
    expect(a.where_0_0.probabilities["9"]).toBeCloseTo(0.15, 5);
    expect(a.where_0_0.probabilities["7"]).toBeCloseTo(0.05, 5);
    expect(a.where_0_0.confidence).toBeCloseTo(0.8, 5);
    expect(a.exists_0.noul).toBeCloseTo(0.9, 5);
  });

  test("digits split into tokens (Llama-style): the path probability is followed", () => {
    // " 4" (0.9) then "6" (0.7) then a newline: 46 = 0.63; 47 = 0.9 × 0.3; 9 = 0.1.
    const toks = [lp("where_0_0", 1), lp(":", 1), lp(" 4", 0.9, [[" 9", 0.1]]), lp("6", 0.7, [["7", 0.3]]), lp("\n", 1), lp("exists_0", 1), lp(": no", 0.6, [[": yes", 0.4]])];
    const a = readLogprobAnswers(toks, describeQuestions(Qs))!;
    expect(a.where_0_0.choice).toBe("46");
    expect(a.where_0_0.probabilities["46"]).toBeCloseTo(0.63, 5);
    expect(a.where_0_0.probabilities["47"]).toBeCloseTo(0.27, 5);
    expect(a.where_0_0.probabilities["9"]).toBeCloseTo(0.1, 5);
    expect(a.exists_0.noul).toBeCloseTo(0.4, 5);
  });

  test("an answer that is missing makes the whole reply unreadable (→ next mode)", () => {
    const toks = [lp("where_0_0", 1), lp(":", 1), lp(" 10", 1)];
    expect(readLogprobAnswers(toks, describeQuestions(Qs))).toBe(null);
  });

  test("option lists are sent as ranges", () => {
    expect(ranges(["1", "2", "3", "5", "7", "8"])).toBe("1-3, 5, 7-8");
  });
});

// ── A fake OpenAI-compatible server ─────────────────────────────────────────
type Call = { url: string; body: any; headers: Record<string, string> };
function fakeFetch(handler: (body: any, call: Call) => { status?: number; json?: any }) {
  const calls: Call[] = [];
  const f = (async (url: string, init: any) => {
    const call = { url: String(url), body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers ?? {} };
    calls.push(call);
    const r = handler(call.body, call);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}
/** The question ids in the order the prompt lists them. */
const askedIds = (body: any) => [...String(body.messages[1].content).matchAll(/^\d+\. (\w+): /gm)].map((m) => m[1]);

/** A logprobs reply: choices answer `ref` (p) with `alt` as runner-up, nouls answer yes with `yes`. */
function logprobReply(body: any, ref: number, p = 0.9, alt = 3, yes = 0.95) {
  const content: LogprobToken[] = [];
  for (const id of askedIds(body)) {
    content.push(lp(id, 1), lp(":", 1));
    if (/^(where|toward)/.test(id)) content.push(lp(` ${ref}`, p, [[` ${alt}`, 1 - p]]));
    else content.push(yes >= 0.5 ? lp(" yes", yes, [[" no", 1 - yes]]) : lp(" no", 1 - yes, [[" yes", yes]]));
    content.push(lp("\n", 1));
  }
  return { model: body.model, choices: [{ message: { content: content.map((t) => t.token).join("") }, logprobs: { content } }], usage: { prompt_tokens: 321, completion_tokens: 12 } };
}
function jsonReply(body: any, ref: number, p = 0.97) {
  const out: Record<string, any> = {};
  for (const id of askedIds(body)) out[id] = /^(where|toward)/.test(id) ? { ranked: [{ id: String(ref), p }, { id: "3", p: 1 - p }] } : { p_yes: 0.9 };
  return { model: body.model, choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 300, completion_tokens: 40 } };
}

const BASE = "https://api.nexos.ai/v1";
afterEach(() => forgetModes());

describe("OpenAI-compatible provider", () => {
  test("logprobs path: one request, calibrated, key as Bearer, real probabilities", async () => {
    const { f, calls } = fakeFetch((b) => ({ json: logprobReply(b, 10, 0.8) }));
    const prov = openaiProvider({ baseUrl: BASE, apiKey: "sk-test-123456", model: "gpt-test", label: "nexos.ai", fetch: f });
    const r = await findTarget({ target: "the button that takes me to payment", url: "https://shop.example/cart", tree: TEST_TASKS[0].tree, provider: prov });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`${BASE}/chat/completions`);
    expect(calls[0].headers.authorization).toBe("Bearer sk-test-123456");
    expect(calls[0].body).toMatchObject({ model: "gpt-test", logprobs: true, top_logprobs: 20, temperature: 0 });
    expect(r).toMatchObject({ calibrated: true, provider: "nexos.ai", model: "gpt-test", inputTokens: 321, outputTokens: 12 });
    expect(r.ranked[0]).toMatchObject({ ref: 10, role: "button", name: "Proceed to checkout" });
    expect(r.ranked[0].p).toBeCloseTo(0.8, 5);
    expect(r.exists).toBeCloseTo(0.95, 5);
    expect(knownMode(BASE, "gpt-test")).toBe("logprobs");
  });

  test("HTTP 400 for logprobs → json_schema answers, marked uncalibrated, and remembered", async () => {
    const { f, calls } = fakeFetch((b) => (b.logprobs ? { status: 400, json: { error: { message: "logprobs is not supported for this model" } } } : { json: jsonReply(b, 10) }));
    const prov = openaiProvider({ baseUrl: BASE, apiKey: "k-12345678", model: "o-reasoner", label: "nexos.ai", fetch: f });
    const r = await findTarget({ target: "payment", url: "https://shop.example/cart", tree: TEST_TASKS[0].tree, provider: prov });
    expect(calls.length).toBe(2);
    expect(calls[1].body.response_format.type).toBe("json_schema");
    expect(calls[1].body.response_format.json_schema.strict).toBe(true);
    expect(calls[1].body.logprobs).toBeUndefined();
    expect(r.calibrated).toBe(false);
    expect(r.ranked[0].ref).toBe(10);
    expect(r.confidence).toBeCloseTo(0.97, 5);
    expect(knownMode(BASE, "o-reasoner")).toBe("schema");
    await findTarget({ target: "payment", url: "https://shop.example/cart", tree: TEST_TASKS[0].tree, provider: prov });
    expect(calls.length).toBe(3); // straight to json_schema the second time
  });

  test("a 200 without logprobs falls back too; no json_schema either → plain JSON", async () => {
    const { f, calls } = fakeFetch((b) => {
      if (b.response_format) return { status: 400, json: { error: "response_format not supported" } };
      if (b.logprobs) return { json: { choices: [{ message: { content: "where_0_0: 10" } }] } }; // server ignored the parameter
      return { json: { ...jsonReply(b, 2), choices: [{ message: { content: "Here you go:\n" + jsonReply(b, 2).choices[0].message.content } }] } };
    });
    const prov = openaiProvider({ baseUrl: "http://127.0.0.1:11434/v1", apiKey: null, model: "llama3", label: "Local (Ollama)", fetch: f });
    expect(prov.local).toBe(true);
    const r = await findTarget({ target: "where I type my password", url: "https://x.example/login", tree: TEST_TASKS[1].tree, provider: prov });
    expect(calls.length).toBe(3);
    expect(calls[0].headers.authorization).toBeUndefined(); // no key for a local server
    expect(r.calibrated).toBe(false);
    expect(r.ranked[0].ref).toBe(2);
    expect(knownMode("http://127.0.0.1:11434/v1", "llama3")).toBe("json");
  });

  test("a refused key is an error that names the provider, never the key", async () => {
    const { f } = fakeFetch(() => ({ status: 401, json: { error: { message: "bad key" } } }));
    const prov = openaiProvider({ baseUrl: BASE, apiKey: "sk-secret-999999", model: "m", label: "nexos.ai", fetch: f });
    const e = await findTarget({ target: "x", url: "https://a.example/", tree: TEST_TASKS[1].tree, provider: prov }).catch((x) => x);
    expect(String(e.message)).toContain("nexos.ai refused the API key");
    expect(String(e.message)).not.toContain("sk-secret");
  });

  test("the model list comes from GET {base}/models, sorted", async () => {
    const { f, calls } = fakeFetch(() => ({ json: { data: [{ id: "gpt-4.1-mini" }, { id: "claude-x" }, { id: "bad id with spaces" }] } }));
    expect(await listModels(BASE + "/", "sk-12345678", f)).toEqual(["claude-x", "gpt-4.1-mini"]);
    expect(calls[0].url).toBe(`${BASE}/models`);
    expect(calls[0].headers.authorization).toBe("Bearer sk-12345678");
  });

  test("the Settings test scores canned pages", async () => {
    const want = new Map(TEST_TASKS.map((t) => [t.target, t.expect![0]]));
    const { f } = fakeFetch((b) => {
      const target = TEST_TASKS.find((t) => String(b.messages[1].content).includes(t.target))!.target;
      return { json: logprobReply(b, want.get(target)!, 0.9) };
    });
    const runs = await runTasks(openaiProvider({ baseUrl: BASE, apiKey: "k-12345678", model: "m", label: "nexos.ai", fetch: f }), TEST_TASKS);
    expect(runs.every((r) => r.ok && r.correct && r.calibrated)).toBe(true);
    expect(runs[0].brier).toBeCloseTo(0.01, 5);
  });
});

describe("scoring", () => {
  const base = { candidates: 1, deduped: 0, model: "m", provider: "p", calibrated: true, inputTokens: 0, outputTokens: 0, requests: 1, target: "t", confidence: 0.9 };
  test("an absent target is right when the provider says nothing matches", () => {
    const task = { ...TEST_TASKS[0], expect: null };
    expect(scoreFind(task, { ...base, exists: 0.2, ranked: [{ ref: 1, p: 0.9, role: "link", name: "Home" }] })).toMatchObject({ correct: true });
    expect(scoreFind(task, { ...base, exists: 0.9, ranked: [{ ref: 1, p: 0.9, role: "link", name: "Home" }] }).brier).toBeCloseTo(0.81, 5);
  });
  test("a confident wrong pick costs nearly 1", () => {
    expect(scoreFind(TEST_TASKS[0], { ...base, exists: 0.9, ranked: [{ ref: 4, p: 0.95, role: "button", name: "Search" }] })).toMatchObject({ correct: false });
  });
});

describe("base URLs", () => {
  test("https anywhere; http only on this computer", () => {
    expect(checkBaseUrl("https://api.nexos.ai/v1/")).toEqual({ url: "https://api.nexos.ai/v1", host: "api.nexos.ai", local: false });
    expect(checkBaseUrl("http://127.0.0.1:11434/v1")).toMatchObject({ local: true });
    expect(checkBaseUrl("http://localhost:1234/v1")).toMatchObject({ local: true });
    expect(checkBaseUrl("http://evil.example/v1")).toHaveProperty("error");
    expect(checkBaseUrl("http://127.0.0.1.evil.example/v1")).toHaveProperty("error");
    expect(checkBaseUrl("ftp://x.example/")).toHaveProperty("error");
    expect(checkBaseUrl("https://user:pw@x.example/v1")).toHaveProperty("error");
    expect(checkBaseUrl("https://x.example/v1?key=abc")).toHaveProperty("error");
    expect(checkBaseUrl("not a url")).toHaveProperty("error");
  });
});

describe("config", () => {
  test("TypeSafe is the default; presets fix their address; Custom is checked", () => {
    expect(targetingConfig(undefined)).toMatchObject({ provider: "typesafe", uncalibratedActConfidence: 0.95 });
    expect(targetingConfig({ provider: "openai", preset: "nexos", baseUrl: "https://evil.example/v1", model: "gpt-4.1" })).toMatchObject({ baseUrl: "https://api.nexos.ai/v1", model: "gpt-4.1" });
    expect(targetingConfig({ provider: "openai", preset: "custom", baseUrl: "http://evil.example/v1" }).baseUrl).toBe("");
    expect(targetingConfig({ provider: "openai", preset: "custom", baseUrl: "https://llm.corp.example/v1" }).baseUrl).toBe("https://llm.corp.example/v1");
    expect(targetingConfig({ provider: "openai", preset: "nope" }).preset).toBe("nexos");
    expect(targetingConfig({ uncalibratedActConfidence: 0.8 }).uncalibratedActConfidence).toBe(0.8);
    expect(targetingConfig({ uncalibratedActConfidence: 7 }).uncalibratedActConfidence).toBe(0.95);
  });
});

describe("key file", () => {
  const dir = mkdtempSync(join(tmpdir(), "browsteer-keys-"));
  const file = join(dir, "keys.env");
  for (const k of ["NEXOS_API_KEY", "BROWSTEER_CUSTOM_API_KEY", "OPENROUTER_API_KEY"]) delete process.env[k];
  test("one line per provider, others kept, readable by this user only", () => {
    saveKey("nexos", "nx-one-12345678", BASE, file);
    saveKey("openrouter", "or-two-12345678", "https://openrouter.ai/api/v1", file);
    saveKey("nexos", "nx-new-12345678", BASE, file);
    expect(loadKey("nexos", BASE, file)).toBe("nx-new-12345678");
    expect(loadKey("openrouter", "", file)).toBe("or-two-12345678");
    expect(readFileSync(file, "utf8").match(/NEXOS_API_KEY=/g)!.length).toBe(1);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    removeKey("nexos", file);
    expect(loadKey("nexos", BASE, file)).toBe(null);
    expect(loadKey("openrouter", "", file)).toBe("or-two-12345678");
  });
  test("a Custom key is only used for the address it was saved for", () => {
    saveKey("custom", "cu-key-12345678", "https://llm.corp.example/v1", file);
    expect(loadKey("custom", "https://llm.corp.example/v1", file)).toBe("cu-key-12345678");
    expect(loadKey("custom", "https://elsewhere.example/v1", file)).toBe(null);
  });
  test("keys with spaces or line breaks are refused", () => {
    expect(() => saveKey("nexos", "a b", BASE, file)).toThrow();
    expect(() => saveKey("nexos", "a\nEVIL=1", BASE, file)).toThrow();
    expect(readFileSync(file, "utf8")).not.toContain("EVIL");
  });
  test("cleanup", () => rmSync(dir, { recursive: true, force: true }));
});
