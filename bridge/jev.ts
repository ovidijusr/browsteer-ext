// Jev (TypeSafe System One) — semantic targeting for the hub.
//
// Given a snapshot tree (the same text Claude would read) and a plain-language
// target, ask Jev which `[N]` element is meant. Follows the docs' semantic_find
// recipe: every candidate already carries an id in the tree, so one Choice over
// the ids ranks them and one Noul says whether anything matches at all.
//
// EVERYTHING a human should review lives in this file: the questions, the
// thresholds, and the state trimming. Nothing here touches the browser; hub.ts
// owns snapshot/click and calls into these functions.
import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

// ── Thresholds (tune against ~/.browsteer/browsteer.db actions.detail) ───────
export const THRESHOLDS = {
  exists: 0.5,        // below: "nothing on this page matches" — never click
  actConfidence: 0.7, // find({act:"click"}) clicks only above this Choice confidence
  guard: 0.3,         // noul "irreversible action" at/above this → refuse to click
  reached: 0.8,       // pursue: goal already visible on the page → stop
  blocked: 0.5,       // pursue: login/captcha/consent wall → stop, needs a human
  stuck: 0.35,        // pursue: Choice confidence below this → stop and hand back
} as const;

export const MAX_STATE_CHARS = 60_000; // ≈15k tokens; Jev's state budget is 32k tokens
export const CHOICE_MAX = 255;         // API limit on Choice options
export const SHORTLIST_PER_BATCH = 3;  // survivors per batch when >255 candidates

// ── Key + client ─────────────────────────────────────────────────────────────
// The hub is spawned detached from a Claude session, so the env rarely carries
// the key. Fall back to the same file the `jev` skill and jev-sample use.
export function loadApiKey(): string | null {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  const file = `${homedir()}/.config/typesafe/env`;
  if (!existsSync(file)) return null;
  const m = readFileSync(file, "utf8").match(/^\s*TYPESAFE_API_KEY=(.+)$/m);
  return m ? m[1].trim() : null;
}

let _client: TypeSafeClient | null = null;
export function client(): TypeSafeClient {
  if (_client) return _client;
  const apiKey = loadApiKey();
  if (!apiKey) throw new Error("Jev unavailable: no TYPESAFE_API_KEY in env or ~/.config/typesafe/env (see the `jev` skill).");
  // Pinned: thresholds above were tuned on this version. Override with TYPESAFE_DEFAULT_MODEL.
  _client = new TypeSafeClient({ apiKey, defaultModel: process.env.TYPESAFE_DEFAULT_MODEL ?? "jev-1.13.0", timeout: 20_000 });
  return _client;
}

// ── Candidates from the snapshot text ────────────────────────────────────────
export interface Candidate { ref: number; role: string; name: string; line: string }

// Matches `  [12] button "Search" =state` — one ref per line. Range lines like
// `[13-43] button … ×31 collapsed` are skipped on purpose: the hub asks for an
// uncollapsed snapshot so every control keeps its own ref and name.
const CAND_RE = /^\s*\[(\d+)\]\s+(\S+)\s*(.*)$/;
export function parseCandidates(tree: string): Candidate[] {
  const out: Candidate[] = [];
  for (const line of tree.split("\n")) {
    const m = CAND_RE.exec(line);
    if (!m) continue;
    const name = m[3].replace(/\s+=.*$/, "").replace(/^"(.*)"$/, "$1");
    out.push({ ref: Number(m[1]), role: m[2], name, line: line.trim() });
  }
  return out;
}

// Keep the state inside Jev's budget: first drop plain text lines (they carry
// no refs), then cut from the bottom. Candidates that fall off the end are
// dropped from the option list too, so the model is never asked about an id
// it cannot see.
export function trimState(tree: string, max = MAX_STATE_CHARS): string {
  if (tree.length <= max) return tree;
  const lines = tree.split("\n").filter((l) => !/^\s*"/.test(l));
  let s = lines.join("\n");
  if (s.length <= max) return s;
  s = s.slice(0, max);
  return s.slice(0, s.lastIndexOf("\n"));
}

export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ── Questions ────────────────────────────────────────────────────────────────
// Literal wording matters (Jev reads exactly what is written). Options are the
// ref ids with null descriptions: the tree in `page` already names each one.
const idOptions = (c: Candidate[]) => Object.fromEntries(c.map((x) => [String(x.ref), null])) as Record<string, null>;

const Q = {
  where: (target: string, c: Candidate[]) =>
    choice(`Which element in \`page\` (identified by its [number]) would a user activate to accomplish: "${target}"?`, idOptions(c)),
  exists: (target: string) =>
    noul(`Does \`page\` contain an element a user would activate to accomplish: "${target}"?`, {
      true: "At least one [numbered] element on the page is the control, link, or item the target describes",
      false: "No element on the page corresponds to the target; the page is the wrong place or the target is not present",
    }),
  reached: (goal: string) =>
    noul(`Does \`page\` already show the outcome of: "${goal}", so that no further navigation is needed?`, {
      true: "The page content itself is the requested result (the item, article, form, or listing is open on screen)",
      false: "The page is an intermediate step: a list, menu, search, or unrelated page",
    }),
  blocked: () =>
    noul("Does `page` require a human step before continuing: a login form, CAPTCHA, cookie or consent dialog, two-factor prompt, or paywall that covers the content?", {
      true: "The main content is gated behind such a step right now",
      false: "The content is usable; any consent banner is minor or already dismissed",
    }),
  guard: () =>
    noul("Would activating `element` buy, pay, subscribe, send a message or email, post publicly, delete, cancel, log out, or otherwise make an irreversible or externally visible change?", {
      true: "It commits an order, payment, message, deletion, or account change",
      false: "It only navigates, opens, expands, filters, sorts, or reveals content",
    }),
};

// ── findTarget ───────────────────────────────────────────────────────────────
export interface Ranked { ref: number; p: number; role: string; name: string }
export interface FindResult {
  exists: number;
  confidence: number;
  ranked: Ranked[];          // best first, top 5
  reached?: number;          // pursue only
  blocked?: number;          // pursue only
  candidates: number;
  model: string;
  inputTokens: number;
  requests: number;
}

export interface FindInput { target: string; url: string; title?: string; tree: string; pursue?: boolean }

export async function findTarget(inp: FindInput): Promise<FindResult> {
  const tree = trimState(inp.tree);
  const cands = parseCandidates(tree);
  if (!cands.length) {
    return { exists: 0, confidence: 0, ranked: [], candidates: 0, model: "-", inputTokens: 0, requests: 0 };
  }
  const state = { url: inp.url, title: inp.title ?? "", page: tree };
  const byRef = new Map(cands.map((c) => [c.ref, c]));
  const batches = chunk(cands, CHOICE_MAX);

  // One request: one Choice per batch (speculative fan-out) + the page-level nouls.
  const questions: Record<string, any> = { exists: Q.exists(inp.target) };
  if (inp.pursue) { questions.reached = Q.reached(inp.target); questions.blocked = Q.blocked(); }
  batches.forEach((b, i) => { questions[`where_${i}`] = Q.where(inp.target, b); });

  const r1 = await client().systemOne({ state, questions });
  let inputTokens = r1.usage.input_tokens;
  let requests = 1;

  const toRanked = (probs: Record<string, number>): Ranked[] =>
    Object.entries(probs)
      .map(([ref, p]) => ({ ref: Number(ref), p, role: byRef.get(Number(ref))?.role ?? "?", name: byRef.get(Number(ref))?.name ?? "" }))
      .sort((a, b) => b.p - a.p);

  let ranked: Ranked[];
  let confidence: number;
  if (batches.length === 1) {
    const a = r1.answers.where_0 as any;
    ranked = toRanked(a.probabilities);
    confidence = a.confidence;
  } else {
    // Second pass: the top few of every batch compete in one Choice, so the
    // final probabilities are comparable across the whole page.
    const survivors = batches.flatMap((_, i) => toRanked((r1.answers[`where_${i}`] as any).probabilities).slice(0, SHORTLIST_PER_BATCH))
      .map((r) => byRef.get(r.ref)!);
    const r2 = await client().systemOne({ state, questions: { where: Q.where(inp.target, survivors) } });
    inputTokens += r2.usage.input_tokens; requests++;
    ranked = toRanked(r2.answers.where.probabilities as any);
    confidence = r2.answers.where.confidence;
  }

  return {
    exists: (r1.answers.exists as any).noul,
    confidence,
    ranked: ranked.slice(0, 5),
    reached: inp.pursue ? (r1.answers.reached as any).noul : undefined,
    blocked: inp.pursue ? (r1.answers.blocked as any).noul : undefined,
    candidates: cands.length,
    model: r1.model,
    inputTokens,
    requests,
  };
}

// Tiny second request: only the chosen element's line plus the goal, so the
// judgment is about that control and nothing else on the page.
export async function guardClick(cand: Ranked, goal: string, url: string): Promise<number> {
  const r = await client().systemOne({
    state: { url, goal, element: `[${cand.ref}] ${cand.role} ${JSON.stringify(cand.name)}` },
    questions: { guard: Q.guard() },
  });
  return (r.answers.guard as any).noul;
}

// ── Formatting shared by hub ops ─────────────────────────────────────────────
export const pct = (x: number) => `${Math.round(x * 100)}%`;
export function formatShortlist(ranked: Ranked[]): string {
  return ranked.map((r) => `  [${r.ref}] ${r.role} ${JSON.stringify(r.name)}  ${pct(r.p)}`).join("\n");
}
