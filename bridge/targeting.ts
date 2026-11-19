// Semantic targeting providers: who answers the questions in jev.ts.
//
// Every provider answers the same System One request (a `state` plus `choice` /
// `noul` questions built with the TypeSafe SDK helpers) in the same answer shape:
//   choice → { choice, confidence, probabilities: Record<label, p> }
//   noul   → { noul: p(yes) }
// so hub.ts keeps its thresholds, memos, guard and pursue logic unchanged. The one
// new fact a provider reports is whether its probabilities are CALIBRATED:
//   - TypeSafe Jev: calibrated (the thresholds in jev.ts were tuned on it).
//   - OpenAI-compatible (nexos.ai, OpenRouter, Ollama, custom): calibrated when the
//     endpoint returns token logprobs, which are read as real probabilities. When it
//     cannot (HTTP 400 for the parameter, reasoning models, missing field), the model
//     is asked for JSON with self-reported probabilities, and the answer is marked
//     uncalibrated; hub.ts then acts more carefully (see UNCALIBRATED in jev.ts).
//
// Settings live in ~/.browsteer/config.json under "targeting"; API keys in a
// mode-600 key file next to it. Only the person, through the extension's own
// Settings page, can change either (hub.ts enforces that).
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DATA_DIR, loadConfig } from "./security";

// ── Presets ──────────────────────────────────────────────────────────────────
export type ProviderKind = "typesafe" | "openai";
export type PresetId = "nexos" | "openrouter" | "ollama" | "custom";
export interface Preset {
  id: PresetId;
  label: string;
  /** Empty for Custom: the person types it. */
  baseUrl: string;
  /** Name of the line in the key file (and of the environment variable that overrides it). */
  keyName: string;
}
export const PRESETS: Record<PresetId, Preset> = {
  nexos: { id: "nexos", label: "nexos.ai", baseUrl: "https://api.nexos.ai/v1", keyName: "NEXOS_API_KEY" },
  openrouter: { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyName: "OPENROUTER_API_KEY" },
  ollama: { id: "ollama", label: "Local (Ollama)", baseUrl: "http://127.0.0.1:11434/v1", keyName: "OLLAMA_API_KEY" },
  custom: { id: "custom", label: "Custom", baseUrl: "", keyName: "BROWSTEER_CUSTOM_API_KEY" },
};
export const isPreset = (x: unknown): x is PresetId => typeof x === "string" && Object.hasOwn(PRESETS, x);

// ── Base URLs ────────────────────────────────────────────────────────────────
// Page outlines go wherever this points, so it is checked every time it is read:
// https anywhere, plain http only to this computer. No user:password, query or
// fragment (a key smuggled into the URL would end up in logs).
export const isLoopback = (host: string) => /^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1)$/i.test(host);
export function checkBaseUrl(raw: unknown): { url: string; host: string; local: boolean } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "Type the API address, like https://api.example.com/v1." };
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { error: `“${String(raw).slice(0, 80)}” isn't a web address.` }; }
  if (u.username || u.password) return { error: "Leave the user name and password out of the address; paste the key in the key field." };
  if (u.search || u.hash) return { error: "The address can't have ? or # parts." };
  const local = isLoopback(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return { error: "Use https://. Plain http:// works only for 127.0.0.1 or localhost." };
  return { url: (u.origin + u.pathname).replace(/\/+$/, ""), host: u.host, local };
}

// ── Config ───────────────────────────────────────────────────────────────────
export interface TargetingConfig {
  provider: ProviderKind;
  preset: PresetId;
  /** The preset's address, or the checked Custom one ("" when Custom is unset or invalid). */
  baseUrl: string;
  model: string;
  /** Uncalibrated providers act (click/fill) only at or above this confidence. */
  uncalibratedActConfidence: number;
}
export const DEFAULT_UNCALIBRATED_ACT = 0.95;
/** Read "targeting" from config.json. Anything missing or invalid falls back to TypeSafe. */
export function targetingConfig(raw: any = loadConfig().targeting): TargetingConfig {
  const t = raw && typeof raw === "object" ? raw : {};
  const preset: PresetId = isPreset(t.preset) ? t.preset : "nexos";
  let baseUrl = PRESETS[preset].baseUrl;
  if (preset === "custom") { const c = checkBaseUrl(t.baseUrl); baseUrl = "url" in c ? c.url : ""; }
  const act = Number(t.uncalibratedActConfidence);
  return {
    provider: t.provider === "openai" ? "openai" : "typesafe",
    preset,
    baseUrl,
    model: typeof t.model === "string" && /^[\w.:/@+-]{1,200}$/.test(t.model) ? t.model : "",
    uncalibratedActConfidence: Number.isFinite(act) && act > 0 && act <= 1 ? act : DEFAULT_UNCALIBRATED_ACT,
  };
}

// ── Key files ────────────────────────────────────────────────────────────────
// `NAME=value` lines, readable by this user only. TypeSafe keeps its own file
// (~/.config/typesafe/env, shared with the `jev` skill); the OpenAI-compatible
// keys live in ~/.browsteer/keys.env.
export const KEYS_FILE = process.env.BROWSTEER_KEYS_FILE || join(DATA_DIR, "keys.env");
const lineRe = (name: string) => new RegExp(`^\\s*${name}=(.*)$`, "m");
export function readEnvLine(file: string, name: string): string | null {
  if (!existsSync(file)) return null;
  const m = readFileSync(file, "utf8").match(lineRe(name));
  return m && m[1].trim() ? m[1].trim() : null;
}
/** Set (value) or remove (null) one line, keeping the others. */
export function writeEnvLine(file: string, name: string, value: string | null): void {
  if (value != null && (!value || /\s/.test(value))) throw new Error("An API key has no spaces or line breaks.");
  let lines: string[] = [];
  try { lines = readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l && !new RegExp(`^\\s*${name}=`).test(l)); } catch { if (value == null) return; }
  if (value != null) lines.push(`${name}=${value}`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, lines.length ? lines.join("\n") + "\n" : "", { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {} // the mode above only applies to a new file
}

// A Custom key belongs to the address it was saved for: if the address changes,
// the old key is not sent to the new host (it reads as "no key" until re-entered).
const forName = (p: Preset) => `${p.keyName}_FOR`;
export function loadKey(preset: PresetId, baseUrl = targetingConfig().baseUrl, file = KEYS_FILE): string | null {
  const p = PRESETS[preset];
  if (process.env[p.keyName]) return process.env[p.keyName]!;
  const key = readEnvLine(file, p.keyName);
  if (!key) return null;
  if (preset === "custom" && readEnvLine(file, forName(p)) !== baseUrl) return null;
  return key;
}
export function saveKey(preset: PresetId, key: string, baseUrl = targetingConfig().baseUrl, file = KEYS_FILE): void {
  const p = PRESETS[preset];
  writeEnvLine(file, p.keyName, key);
  if (preset === "custom") writeEnvLine(file, forName(p), baseUrl);
}
export function removeKey(preset: PresetId, file = KEYS_FILE): void {
  const p = PRESETS[preset];
  writeEnvLine(file, p.keyName, null);
  writeEnvLine(file, forName(p), null);
}

// ── TypeSafe key (unchanged location, shared with the `jev` skill and `bun run setup`) ──
export const TYPESAFE_ENV_FILE = process.env.TYPESAFE_ENV_FILE || join(homedir(), ".config", "typesafe", "env");
export function loadTypesafeKey(): string | null {
  return process.env.TYPESAFE_API_KEY || readEnvLine(TYPESAFE_ENV_FILE, "TYPESAFE_API_KEY");
}

// ── Provider interface ───────────────────────────────────────────────────────
export interface SystemOneRequest { state: Record<string, string>; questions: Record<string, any> }
export interface SystemOneAnswer {
  answers: Record<string, any>;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  /** Probabilities come from the model's own token probabilities (or Jev), not from text it wrote. */
  calibrated: boolean;
}
export interface Provider {
  kind: ProviderKind;
  /** "TypeSafe Jev", "nexos.ai", "Local (Ollama)"… */
  label: string;
  /** Where page outlines go: "api.typesafe.ai", "api.nexos.ai", "127.0.0.1:11434". */
  host: string;
  /** True when that host is this computer. */
  local: boolean;
  model: string;
  systemOne(req: SystemOneRequest): Promise<SystemOneAnswer>;
  warm(): Promise<void>;
}
export class TargetingError extends Error {}

// ── TypeSafe Jev ─────────────────────────────────────────────────────────────
export const TYPESAFE_MODEL = process.env.TYPESAFE_DEFAULT_MODEL ?? "jev-1.13.0"; // pinned: thresholds were tuned on it
export function typesafeProvider(apiKey = loadTypesafeKey()): Provider {
  if (!apiKey) throw new TargetingError("Jev unavailable: no TYPESAFE_API_KEY in env or ~/.config/typesafe/env (add it in the Browsteer Settings page).");
  const client = new TypeSafeClient({ apiKey, defaultModel: TYPESAFE_MODEL, timeout: 20_000 });
  return {
    kind: "typesafe", label: "TypeSafe Jev", host: "api.typesafe.ai", local: false, model: TYPESAFE_MODEL,
    async systemOne(req) {
      const r = await client.systemOne(req as any);
      return { answers: r.answers as any, usage: { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens ?? 0 }, model: r.model, calibrated: true };
    },
    async warm() { try { await client.models.list(); } catch {} },
  };
}

// ── OpenAI-compatible ────────────────────────────────────────────────────────
// One chat completion per systemOne call. Three ways to ask, tried in order and
// remembered per endpoint + model once one works:
//   logprobs — one line per question ("where_0_0: 46", "exists_0: yes"); the
//              answer token's top_logprobs give the probability of every option.
//   schema   — response_format json_schema (strict) with self-reported p's.
//   json     — the same JSON asked for in words, for servers without json_schema.
export type AskMode = "logprobs" | "schema" | "json";
const MODES: AskMode[] = ["logprobs", "schema", "json"];
const modeCache = new Map<string, AskMode>();
/** Which way a given endpoint + model answered last; null before the first call. */
export const knownMode = (baseUrl: string, model: string): AskMode | null => modeCache.get(`${baseUrl}|${model}`) ?? null;
export const forgetModes = () => modeCache.clear();

/** This mode does not work here (HTTP 400 for a parameter, no logprobs, unreadable reply). `sticky`: remember to skip it. */
class Unsupported extends Error { constructor(msg: string, public sticky: boolean) { super(msg); } }

export interface OpenAIOptions {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  label: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function openaiProvider(o: OpenAIOptions): Provider {
  const chk = checkBaseUrl(o.baseUrl);
  if ("error" in chk) throw new TargetingError(`${o.label}: ${chk.error}`);
  const base = chk;
  if (!o.model) throw new TargetingError(`${o.label}: no model chosen. Pick one in the Browsteer Settings page.`);
  const f = o.fetch ?? fetch;
  const cacheKey = `${base.url}|${o.model}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.apiKey) headers.authorization = `Bearer ${o.apiKey}`;

  async function post(body: any): Promise<any> {
    let res: Response;
    try {
      res = await f(`${base.url}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
    } catch (e: any) { throw new TargetingError(`${o.label} (${base.host}) not reachable: ${e?.name === "TimeoutError" ? "timed out" : e?.message ?? e}`); }
    const text = await res.text();
    if (res.status === 400 || res.status === 422) throw new Unsupported(`HTTP ${res.status}: ${errText(text)}`, true);
    if (res.status === 401 || res.status === 403) throw new TargetingError(`${o.label} refused the API key (HTTP ${res.status}). Check it in the Browsteer Settings page.`);
    if (!res.ok) throw new TargetingError(`${o.label} answered HTTP ${res.status}: ${errText(text)}`);
    try { return JSON.parse(text); } catch { throw new TargetingError(`${o.label} sent a reply that isn't JSON.`); }
  }

  async function ask(mode: AskMode, req: SystemOneRequest): Promise<SystemOneAnswer> {
    const qs = describeQuestions(req.questions);
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `${renderState(req.state)}\n\n${renderQuestions(qs, mode)}` },
    ];
    const body: any = { model: o.model, messages, temperature: 0, max_tokens: 40 + 24 * qs.length };
    if (mode === "logprobs") { body.logprobs = true; body.top_logprobs = 20; }
    if (mode === "schema") body.response_format = { type: "json_schema", json_schema: { name: "answers", strict: true, schema: answerSchema(qs) } };
    let j: any;
    try { j = await post(body); } catch (e) {
      // Some servers want max_completion_tokens instead; try once without the cap.
      if (e instanceof Unsupported && /max_tokens/.test(e.message)) { delete body.max_tokens; j = await post(body); } else throw e;
    }
    const choice = j?.choices?.[0];
    const content: string = choice?.message?.content ?? "";
    const usage = { input_tokens: Number(j?.usage?.prompt_tokens) || 0, output_tokens: Number(j?.usage?.completion_tokens) || 0 };
    const model = typeof j?.model === "string" ? j.model : o.model;
    if (mode === "logprobs") {
      const lp = choice?.logprobs?.content;
      if (!Array.isArray(lp) || !lp.length || !lp.some((t: any) => Array.isArray(t?.top_logprobs) && t.top_logprobs.length)) throw new Unsupported("no logprobs in the reply", true);
      const answers = readLogprobAnswers(lp, qs);
      if (!answers) throw new Unsupported("could not read every answer from the logprobs", false);
      return { answers, usage, model, calibrated: true };
    }
    const answers = readJsonAnswers(content, qs);
    if (!answers) throw new Unsupported("could not read every answer from the JSON reply", false);
    return { answers, usage, model, calibrated: false };
  }

  return {
    kind: "openai", label: o.label, host: base.host, local: base.local, model: o.model,
    async systemOne(req) {
      const known = modeCache.get(cacheKey);
      const order = known ? MODES.slice(MODES.indexOf(known)) : MODES;
      let last: Error | null = null;
      for (const mode of order) {
        try {
          const r = await ask(mode, req);
          modeCache.set(cacheKey, mode);
          return r;
        } catch (e) {
          if (!(e instanceof Unsupported)) throw e;
          last = e;
        }
      }
      throw new TargetingError(`${o.label} (${o.model}) could not answer: ${last?.message ?? "unknown"}`);
    },
    async warm() {},
  };
}

const errText = (t: string) => {
  try { const j = JSON.parse(t); const m = j?.error?.message ?? j?.message ?? j?.error; if (typeof m === "string") return m.slice(0, 200); } catch {}
  return t.replace(/\s+/g, " ").slice(0, 200);
};

/** GET {base}/models → model ids, sorted. */
export async function listModels(baseUrl: string, apiKey: string | null, f: typeof fetch = fetch): Promise<string[]> {
  const chk = checkBaseUrl(baseUrl);
  if ("error" in chk) throw new TargetingError(chk.error);
  let res: Response;
  try {
    res = await f(`${chk.url}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(10_000) });
  } catch (e: any) { throw new TargetingError(`${chk.host} not reachable${e?.name === "TimeoutError" ? " (timed out)" : ""}.`); }
  if (res.status === 401 || res.status === 403) throw new TargetingError(`${chk.host} refused the API key (HTTP ${res.status}).`);
  if (!res.ok) throw new TargetingError(`${chk.host} answered HTTP ${res.status} for the model list.`);
  const j: any = await res.json().catch(() => null);
  const ids = (Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : []).map((m: any) => (typeof m === "string" ? m : m?.id ?? m?.name)).filter((x: unknown): x is string => typeof x === "string" && /^[\w.:/@+-]{1,200}$/.test(x));
  return [...new Set<string>(ids)].sort((a, b) => a.localeCompare(b)).slice(0, 500);
}

// ── Prompt ───────────────────────────────────────────────────────────────────
export const SYSTEM_PROMPT = "You answer questions about a web page for a browser tool. The page is an outline: each control is on its own line as [number] role \"name\", other lines are visible text. Judge only from what is written. Answer exactly in the format asked for, nothing else.";

interface QDesc { id: string; type: "choice" | "noul"; text: string; labels: string[]; keys: string[]; legend: string | null; yes?: string; no?: string }
const asText = (x: unknown) => (x == null ? "" : typeof x === "string" ? x : JSON.stringify(x));

/** Choice options keep their own ids when they are short numbers (the [refs]); anything else gets 1..n. */
export function describeQuestions(questions: Record<string, any>): QDesc[] {
  return Object.entries(questions).map(([id, q]) => {
    if (q?.type === "noul") return { id, type: "noul", text: asText(q.instructions), labels: ["yes", "no"], keys: [], legend: null, yes: asText(q.criteria?.true), no: asText(q.criteria?.false) };
    if (q?.type !== "choice") throw new TargetingError(`question ${id}: only choice and noul are supported by this provider`);
    const keys = Object.keys(q.criteria ?? {});
    const numeric = keys.every((k) => /^\d{1,6}$/.test(k));
    const labels = numeric ? keys : keys.map((_, i) => String(i + 1));
    const described = keys.some((k) => q.criteria[k] != null);
    const legend = numeric && !described ? null : keys.map((k, i) => `${labels[i]} = ${k}${q.criteria[k] != null ? `: ${asText(q.criteria[k])}` : ""}`).join("; ");
    return { id, type: "choice", text: asText(q.instructions), labels, keys, legend };
  });
}

/** "1-45, 47-102": the option list in a few tokens. */
export function ranges(labels: string[]): string {
  const nums = labels.map(Number);
  if (nums.some((n, i) => String(n) !== labels[i])) return labels.join(", ");
  const s = [...nums].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i]}-${s[j]}` : String(s[i]));
    i = j;
  }
  return out.join(", ");
}

export function renderState(state: Record<string, string>): string {
  return Object.entries(state).map(([k, v]) => `${k}:\n${v}`).join("\n\n");
}
function renderQuestions(qs: QDesc[], mode: AskMode): string {
  const lines = qs.map((q, i) => q.type === "noul"
    ? `${i + 1}. ${q.id}: ${q.text}\n   Answer yes or no. yes = ${q.yes || "yes"}; no = ${q.no || "no"}`
    : `${i + 1}. ${q.id}: ${q.text}\n   Answer with one number from: ${ranges(q.labels)}${q.legend ? `\n   Options: ${q.legend}` : ""}`);
  const how = mode === "logprobs"
    ? `Reply with exactly ${qs.length} line${qs.length === 1 ? "" : "s"}, in this order, each "<id>: <answer>" (for example "${qs[0]?.id}: ${qs[0]?.type === "noul" ? "yes" : qs[0]?.labels[0]}"). No other text.`
    : `Reply with one JSON object with a key per question id. A choice question's value is {"ranked": [{"id": "<option>", "p": <probability 0-1 that it is right>}, …]} with your best 1-3 options, best first. A yes/no question's value is {"p_yes": <probability 0-1 that the answer is yes>}.${mode === "json" ? " Reply with the JSON object only." : ""}`;
  return `Questions:\n${lines.join("\n")}\n\n${how}`;
}

function answerSchema(qs: QDesc[]): any {
  const props: Record<string, any> = {};
  for (const q of qs) {
    props[q.id] = q.type === "noul"
      ? { type: "object", properties: { p_yes: { type: "number" } }, required: ["p_yes"], additionalProperties: false }
      : { type: "object", properties: { ranked: { type: "array", items: { type: "object", properties: { id: { type: "string", enum: q.labels }, p: { type: "number" } }, required: ["id", "p"], additionalProperties: false } } }, required: ["ranked"], additionalProperties: false };
  }
  return { type: "object", properties: props, required: qs.map((q) => q.id), additionalProperties: false };
}

// ── Reading answers ──────────────────────────────────────────────────────────
const clip = (x: unknown) => { const n = Number(x); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : NaN; };

function choiceAnswer(q: QDesc, byLabel: Map<string, number>): any {
  const probabilities: Record<string, number> = {};
  q.keys.forEach((k, i) => { probabilities[k] = byLabel.get(q.labels[i]) ?? 0; });
  let best = q.keys[0], bp = -1;
  for (const k of q.keys) if (probabilities[k] > bp) { best = k; bp = probabilities[k]; }
  return { type: "choice", choice: best, confidence: Math.max(0, bp), probabilities };
}

/** Self-reported JSON answers (uncalibrated). Null when any question is missing. */
export function readJsonAnswers(content: string, qs: QDesc[]): Record<string, any> | null {
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: any; try { j = JSON.parse(m[0]); } catch { return null; }
  const out: Record<string, any> = {};
  for (const q of qs) {
    const a = j?.[q.id];
    if (q.type === "noul") {
      const p = clip(a?.p_yes ?? a);
      if (Number.isNaN(p)) return null;
      out[q.id] = { type: "noul", noul: p };
      continue;
    }
    const ranked: any[] = Array.isArray(a?.ranked) ? a.ranked : [];
    const byLabel = new Map<string, number>();
    for (const r of ranked) { const id = String(r?.id ?? ""); const p = clip(r?.p); if (q.labels.includes(id) && !Number.isNaN(p) && !byLabel.has(id)) byLabel.set(id, p); }
    if (!byLabel.size) return null;
    const sum = [...byLabel.values()].reduce((x, y) => x + y, 0);
    if (sum > 1) for (const [k, v] of byLabel) byLabel.set(k, v / sum);
    out[q.id] = choiceAnswer(q, byLabel);
  }
  return out;
}

export interface LogprobToken { token: string; logprob: number; top_logprobs?: { token: string; logprob: number }[] }

/**
 * Real probabilities from the reply's token logprobs. For each "<id>: <answer>"
 * line, walk the answer's tokens: at every position the alternatives in
 * top_logprobs, prefixed by the tokens chosen so far, name an option (or a set of
 * options sharing that prefix). Their probability mass, times the probability of
 * the path that led there, goes to those options. Works whether a number like
 * "46" is one token (GPT-style) or one token per digit (Llama/Mistral-style).
 * Null when any answer is missing or the options got too little mass to trust.
 */
export function readLogprobAnswers(lp: LogprobToken[], qs: QDesc[]): Record<string, any> | null {
  const starts: number[] = [];
  let text = "";
  for (const t of lp) { starts.push(text.length); text += t.token; }
  const tokenAt = (pos: number) => { let i = 0; while (i + 1 < starts.length && starts[i + 1] <= pos) i++; return i; };
  const out: Record<string, any> = {};
  for (const q of qs) {
    const re = new RegExp(`(^|\\n)[ \\t]*(?:\\d+\\.\\s*)?[*\`"]*${q.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[*\`"]*[ \\t]*[:=][ \\t]*["'*]*`, "i");
    const m = re.exec(text);
    if (!m) return null;
    const pos = m.index + m[0].length;
    if (pos >= text.length) return null;
    const dist = q.type === "noul" ? yesNoDist(lp, tokenAt(pos), pos - starts[tokenAt(pos)]) : labelDist(lp, tokenAt(pos), pos - starts[tokenAt(pos)], q.labels);
    if (!dist) return null;
    if (q.type === "noul") { out[q.id] = { type: "noul", noul: dist.get("yes")! }; continue; }
    out[q.id] = choiceAnswer(q, dist);
  }
  return out;
}

/** The text an alternative contributes after the part of the first token that precedes the answer. */
function afterLead(alt: string, chosen: string, offset: number): string | null {
  if (offset <= 0) return alt;
  const lead = chosen.slice(0, offset);
  if (alt.startsWith(lead)) return alt.slice(offset);
  if (!lead.trim()) return alt.replace(/^\s+/, ""); // " 46" vs "46" after ": "
  return null;
}

function yesNoDist(lp: LogprobToken[], i: number, offset: number): Map<string, number> | null {
  const t = lp[i];
  let yes = 0, no = 0;
  for (const alt of t.top_logprobs?.length ? t.top_logprobs : [{ token: t.token, logprob: t.logprob }]) {
    const s = afterLead(alt.token, t.token, offset)?.trim().toLowerCase().replace(/^["'*]+/, "");
    if (!s) continue;
    const p = Math.exp(alt.logprob);
    if (/^(y|yes|true)/.test(s)) yes += p; else if (/^(n|no|false)/.test(s)) no += p;
  }
  if (yes + no < 0.5) return null;
  return new Map([["yes", yes / (yes + no)], ["no", no / (yes + no)]]);
}

const LABEL_CHARS = /^[A-Za-z0-9_-]*/;
function labelDist(lp: LogprobToken[], i0: number, offset: number, labels: string[]): Map<string, number> | null {
  const mass = new Map<string, number>();
  const add = (cands: string[], p: number) => { if (!cands.length || p <= 0) return; for (const c of cands) mass.set(c, (mass.get(c) ?? 0) + p / cands.length); };
  let prefix = "", pathP = 1;
  for (let i = i0; i < lp.length && i < i0 + 8; i++) {
    const t = lp[i];
    const off = i === i0 ? offset : 0;
    const chosenS = afterLead(t.token, t.token, off) ?? "";
    // A tokenizer that put 2+ label characters in this token groups digits ("46" is
    // one token): an alternative here is a whole option. One that splits digits
    // ("4", "6") only names a prefix, shared by every option that starts with it.
    const grouping = chosenS.match(LABEL_CHARS)![0].length > 1;
    const alts = t.top_logprobs?.length ? t.top_logprobs : [{ token: t.token, logprob: t.logprob }];
    for (const alt of alts) {
      if (alt.token === t.token) continue; // the chosen path is followed below
      const s = afterLead(alt.token, t.token, off);
      if (s == null) continue;
      const cand = prefix + s;
      const run = cand.match(LABEL_CHARS)![0];
      if (!run) continue;
      const p = pathP * Math.exp(alt.logprob);
      const whole = run.length < cand.length || ((grouping || s.match(LABEL_CHARS)![0].length > 1) && labels.includes(run));
      add(whole ? labels.filter((l) => l === run) : labels.filter((l) => l.startsWith(run)), p);
    }
    const pChosen = Math.exp(t.logprob);
    const cand = prefix + chosenS;
    const run = cand.match(LABEL_CHARS)![0];
    if (run.length < cand.length || i + 1 >= lp.length) {
      // The chosen path ends here (or the reply does): it names exactly `run`.
      if (labels.includes(run)) add([run], pathP * pChosen);
      break;
    }
    prefix = run; pathP *= pChosen;
  }
  const total = [...mass.values()].reduce((a, b) => a + b, 0);
  if (total < 0.3) return null;
  for (const [k, v] of mass) mass.set(k, v / total);
  return mass;
}

// ── The active provider ──────────────────────────────────────────────────────
/** Build the provider config.json names. Throws a TargetingError with a fix when it can't. */
export function buildProvider(cfg = targetingConfig(), f?: typeof fetch): Provider {
  if (cfg.provider === "typesafe") return typesafeProvider();
  const p = PRESETS[cfg.preset];
  if (!cfg.baseUrl) throw new TargetingError("Custom provider: no valid API address saved. Set it in the Browsteer Settings page.");
  const key = loadKey(cfg.preset, cfg.baseUrl);
  const local = isLoopback(new URL(cfg.baseUrl).hostname);
  if (!key && !local) throw new TargetingError(`${p.label}: no API key. Add it in the Browsteer Settings page.`);
  return openaiProvider({ baseUrl: cfg.baseUrl, apiKey: key, model: cfg.model, label: p.label, fetch: f });
}

/** What the extension may show about the provider. Never the key. */
export interface TargetingInfo {
  provider: ProviderKind;
  preset: PresetId;
  label: string;
  baseUrl: string;
  host: string;
  local: boolean;
  model: string;
  /** A key is needed (not for an address on this computer). */
  keyNeeded: boolean;
  /** true/false once the provider answered; null before the first answer. */
  calibrated: boolean | null;
}
export function targetingInfo(cfg = targetingConfig()): TargetingInfo {
  if (cfg.provider === "typesafe") return { provider: "typesafe", preset: cfg.preset, label: "TypeSafe Jev", baseUrl: "https://api.typesafe.ai", host: "api.typesafe.ai", local: false, model: TYPESAFE_MODEL, keyNeeded: true, calibrated: true };
  let host = "", local = false;
  if (cfg.baseUrl) { const u = new URL(cfg.baseUrl); host = u.host; local = isLoopback(u.hostname); }
  const mode = knownMode(cfg.baseUrl, cfg.model);
  return { provider: "openai", preset: cfg.preset, label: PRESETS[cfg.preset].label, baseUrl: cfg.baseUrl, host, local, model: cfg.model, keyNeeded: !local, calibrated: mode ? mode === "logprobs" : null };
}
/** A key exists for the active provider (or none is needed). */
export function activeKeyPresent(cfg = targetingConfig()): boolean {
  if (cfg.provider === "typesafe") return loadTypesafeKey() !== null;
  if (!cfg.baseUrl) return false;
  return loadKey(cfg.preset, cfg.baseUrl) !== null || isLoopback(new URL(cfg.baseUrl).hostname);
}
