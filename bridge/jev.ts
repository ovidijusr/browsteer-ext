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
import { choice, noul } from "@typesafe-ai/sdk";
import { loadConfig } from "./security";
import { TYPESAFE_ENV_FILE, activeKeyPresent, buildProvider, loadTypesafeKey, targetingConfig, targetingInfo, writeEnvLine, type Provider, type TargetingInfo } from "./targeting";
export { TYPESAFE_ENV_FILE } from "./targeting";

// ── Thresholds (tune against ~/.browsteer/browsteer.db actions.detail) ───────
export const THRESHOLDS = {
  exists: 0.5,        // below: "nothing on this page matches" — never click
  actConfidence: 0.7, // find({act:"click"}) clicks only above this Choice confidence
  guard: 0.3,         // noul "irreversible action" at/above this → refuse to click
  reached: 0.8,       // pursue: goal already visible on the page → stop
  blocked: 0.5,       // pursue: login/captcha/consent wall → stop, needs a human
  stuck: 0.2,         // pursue: Choice confidence below this → stop and hand back. Low on purpose: a wrong hop is cheap and bounded (guard + step limit), a stop costs a Claude turn
  willReach: 0.6,     // pursue: "the click itself lands on the goal" → skip the confirming round trip. Correct final hops scored 69–85% across 8 walks; 0.7 missed a 69% one and paid ~500 ms for a confirming snapshot+Jev
} as const;

// Guard is only asked when the candidate's name smells like a commitment. Links
// only navigate; unlabelled or neutral buttons on a click path are not worth a
// 250 ms round trip. The word lists live in extension/src/risk.ts, shared with
// the content script; matched names are visible in actions.detail.
export { RISK_RE, RISK_WEAK_RE, needsGuard } from "../extension/src/risk";
import { needsGuard } from "../extension/src/risk";

// ── Memos: skip Jev when this host already taught us the answer ─────────────
// A memo is written only after a confident Jev verdict (see MEMO below) and is
// matched against the FRESH snapshot, so a renamed or removed control falls
// back to Jev instead of clicking a ghost. Trailing digits are ignored in the
// name comparison because apps append live counts ("Playlists42" → 43 tomorrow).
export const MEMO = {
  minExists: 0.7,      // write a memo only when Jev was sure the target exists…
  minConfidence: 0.85, // …and sure which element it is…
  minP: 0.8,           // …with the winner clearly ahead of the runner-up
  ttlDays: 30,         // memos not hit for this long are pruned at hub start
} as const;
export function normName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").replace(/\s*\(?\d+\)?\s*$/, "").trim();
}
/** The one candidate the memo names, or null when none / several distinct elements match (→ ask Jev). */
export function memoMatch(memo: { role: string; name: string }, cands: Candidate[]): Candidate | null {
  const want = normName(memo.name);
  const hits = cands.filter((c) => c.role === memo.role && normName(c.name) === want);
  if (!hits.length) return null;
  // Exact duplicates (same role + raw name, e.g. a header and a footer "New playlist") are one element for our purposes.
  const distinct = new Set(hits.map((c) => `${c.role}\u0000${c.name}`));
  return distinct.size === 1 ? hits[0] : null;
}

// ── Lexical fast path: the target names the element outright ────────────────
// "the Playlists section tab" → button "Playlists42"; 7 of the 12 distinct
// targets in the first day's log were of this shape. Zero latency, zero tokens.
// Conservative on purpose: whole-word containment of the candidate's normalized
// name (≥ LEX_MIN_CHARS) inside the normalized target, exactly ONE distinct
// element may match, and the target may not describe a relation ("next to",
// "below", "not") — those need the model. Anything else falls through to Jev.
export const LEX_MIN_CHARS = 4;
const RELATIONAL_RE = /\b(next to|near|beside|below|above|under|after|before|inside|within|except|not|other than|instead|second|third|last|first|nearest|closest|šalia|po|virš|ne|kitas|antras)\b/i;
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function lexicalMatch(target: string, cands: Candidate[]): Candidate | null {
  const t = target.toLowerCase().replace(/\s+/g, " ");
  if (RELATIONAL_RE.test(t)) return null;
  const hits = new Map<string, Candidate>();
  for (const c of cands) {
    const n = normName(c.name);
    if (n.length < LEX_MIN_CHARS || !/[a-z\u00C0-\u024F]/i.test(n)) continue;
    if (!new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}([^\\p{L}\\p{N}]|$)`, "iu").test(t)) continue;
    const k = candKey(c); if (!hits.has(k)) hits.set(k, c);
    if (hits.size > 1) return null;
  }
  return hits.size === 1 ? [...hits.values()][0] : null;
}

// Warm the TLS connection at hub start so the first find is not the slow one.
export async function warm(): Promise<void> {
  if (!jevEnabled()) return;
  try { await activeProvider().warm(); } catch {}
}

// ── Uncalibrated providers ───────────────────────────────────────────────────
// An OpenAI-compatible model that cannot return token logprobs reports its own
// probabilities, which run high and are not what THRESHOLDS were tuned on. Then:
// find acts (click/fill) only at or above `targeting.uncalibratedActConfidence`
// (config.json, default 0.95), else it returns the shortlist; the irreversible-
// action guard refuses unless the model is clearly sure the click is harmless;
// no memos are written from such answers; pursue does not skip the confirming
// look after a "this click reaches the goal" prediction.
export const UNCALIBRATED = {
  guard: 0.1, // guard p(irreversible) above this → refuse (calibrated: THRESHOLDS.guard)
} as const;

// ── Opt-in ───────────────────────────────────────────────────────────────────
// Asking a model sends an outline of the current page (control names + visible
// text) to the configured provider (api.typesafe.ai by default; see targeting.ts).
// That is off unless the person running the hub turned it on: BROWSTEER_JEV=1 in
// the hub's environment, or {"jev": true} in ~/.browsteer/config.json, which the
// Settings page's switch and `bun run setup` write. Off, find answers from the page
// alone (memos + exact names) and pursue is unavailable; nothing leaves the machine.
export const JEV_OFF = 'Semantic targeting is off, so no page content is sent to a model. The user can turn it on in the Browsteer Settings page, under "Find controls by description" (or {"jev": true} in ~/.browsteer/config.json, see PRIVACY.md). Meanwhile use browser_snapshot and act on refs.';
export function jevEnabled(): boolean {
  const env = process.env.BROWSTEER_JEV;
  if (env != null) return env === "1" || env === "true";
  return loadConfig().jev;
}

/** What the extension may show about semantic targeting: on or off, whether a key exists, and the provider. Never the key. */
export function jevState(): { on: boolean; keyPresent: boolean; envOverride: boolean; targeting: TargetingInfo } {
  const cfg = targetingConfig();
  return { on: jevEnabled(), keyPresent: activeKeyPresent(cfg), envOverride: process.env.BROWSTEER_JEV != null, targeting: targetingInfo(cfg) };
}

export const MAX_STATE_CHARS = 60_000; // ≈15k tokens; Jev's state budget is 32k tokens
export const CHOICE_MAX = 255;         // API limit on Choice options
export const SHORTLIST_PER_BATCH = 3;  // survivors per batch when >255 candidates

// ── Key + provider ───────────────────────────────────────────────────────────
// The hub is spawned detached from a Claude session, so the env rarely carries
// the key. Fall back to the same file the `jev` skill and jev-sample use.
// (OpenAI-compatible keys live in ~/.browsteer/keys.env, see targeting.ts.)
export const loadApiKey = loadTypesafeKey;
/** Write TYPESAFE_API_KEY into the env file (bun run setup), keeping its other lines. Readable by this user only. */
export function saveApiKey(key: string, file = TYPESAFE_ENV_FILE): void {
  writeEnvLine(file, "TYPESAFE_API_KEY", key);
}
/** Remove TYPESAFE_API_KEY from the env file, keeping its other lines. */
export function removeApiKey(file = TYPESAFE_ENV_FILE): void {
  writeEnvLine(file, "TYPESAFE_API_KEY", null);
}

let _provider: Provider | null = null;
let _sig = "";
/** Forget the cached provider, so the next call reads config and keys again (after the Settings page changed them). */
export function resetClient(): void { _provider = null; }
/** The provider config.json names, while semantic targeting is on. */
export function activeProvider(): Provider {
  // Checked before the cached provider: the switch can be turned off while the hub runs.
  if (!jevEnabled()) throw new Error(JEV_OFF);
  const cfg = targetingConfig();
  const sig = JSON.stringify(cfg) + (activeKeyPresent(cfg) ? "+key" : "");
  if (_provider && sig === _sig) return _provider;
  _provider = buildProvider(cfg);
  _sig = sig;
  return _provider;
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

// Exact (role, name) duplicates carry no extra information for the model — the
// same "New playlist" button in a header and a toolbar, or a row and its
// sibling action with the same label. Keep the first ref, drop the others from
// BOTH the state and the option list; the survivor's ref still clicks the
// visible element. Distinct names (even "X" vs "X tracks") are kept: only the
// model can tell those apart.
export function dedupeCandidates(cands: Candidate[]): { kept: Candidate[]; dropped: number } {
  const seen = new Set<string>();
  const kept: Candidate[] = [];
  for (const c of cands) {
    const k = `${c.role}\u0000${c.name}`;
    if (seen.has(k)) continue;
    seen.add(k); kept.push(c);
  }
  return { kept, dropped: cands.length - kept.length };
}
// Rebuild the tree from a candidate subset: indentation flattened to one level
// (nesting adds tokens and Jev ranks by role + name, not depth), names capped so
// one 400-char listing title cannot eat the budget of forty others.
export const NAME_CAP = 96;
export function slimTree(cands: Candidate[]): string {
  return cands.map((c) => {
    const name = c.name.length > NAME_CAP ? c.name.slice(0, NAME_CAP - 1) + "…" : c.name;
    const state = c.line.match(/\s(=\S.*)$/)?.[1];
    return `  [${c.ref}] ${c.role} ${JSON.stringify(name)}${state ? " " + state.slice(0, 40) : ""}`;
  }).join("\n");
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
  // Pursue variant: an intermediate hop is a legitimate answer. The plain
  // `exists` question says "no" on a list page whose section tab leads to the
  // goal (47% on the playlists page for "open the Lithuanian library", while the
  // Choice was 88% sure of the Libraries tab) and stopped the walk one hop short.
  existsToward: (goal: string) =>
    noul(`Does \`page\` contain an element a user would activate either to accomplish "${goal}" or as the next step on the way to it (a section, tab, category, menu, or link that leads there)?`, {
      true: "At least one [numbered] element is the target itself or clearly leads toward it",
      false: "Nothing on the page brings a user closer to the goal; this is the wrong place",
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
  willReach: (goal: string) =>
    noul(`Is the element in \`page\` that best leads to "${goal}" itself the final destination, so that activating it directly shows the goal (not a menu, category, or intermediate list)?`, {
      true: "Activating that element opens the requested item, page, or view directly",
      false: "It leads to an intermediate step that still needs more navigation",
    }),
  // Asked only when `exists` says the target is NOT on this page: a one-hop hint
  // (section tab, menu, category) so a miss becomes a click instead of a dead end.
  toward: (target: string, c: Candidate[]) =>
    choice(`The target "${target}" is not on \`page\` itself. Which element (identified by its [number]) would a user activate to get CLOSER to it — the section, tab, menu, category, or link that leads there?`, idOptions(c)),
  guard: () =>
    noul("Would activating `element` buy, pay, subscribe, send a message or email, post publicly, delete, cancel, log out, or otherwise make an irreversible or externally visible change?", {
      true: "It commits an order, payment, message, deletion, or account change",
      false: "It only navigates, opens, expands, filters, sorts, or reveals content",
    }),
};

// ── findTarget / findMany ─────────────────────────────────────────────────────
export interface Ranked { ref: number; p: number; role: string; name: string }
export interface FindResult {
  target: string;
  exists: number;
  confidence: number;
  ranked: Ranked[];          // best first, top 5
  reached?: number;          // pursue only
  blocked?: number;          // pursue only
  willReach?: number;        // pursue only
  toward?: { ranked: Ranked[]; confidence: number }; // hint only: the element that leads toward the target
  candidates: number;
  deduped: number;           // exact-duplicate controls removed from the state
  model: string;
  /** Who answered: "TypeSafe Jev", "nexos.ai", … ("memo"/"lexical" when no model was asked). */
  provider: string;
  /** Probabilities are real (Jev, or token logprobs), not self-reported by the model. */
  calibrated: boolean;
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

// `history` (pursue): the hops already taken, so the model knows which view it
// is in and does not steer back. `exclude`: refs the caller has already clicked
// on this very page (as role+name keys from `candKey`, since refs are reassigned
// per snapshot) — they leave the option list so a loop cannot re-pick them.
export const candKey = (c: { role: string; name: string }) => `${c.role}\u0000${c.name}`;
interface Common {
  url: string; title?: string; tree: string; pursue?: boolean; history?: string; exclude?: Set<string>; hint?: boolean;
  /** Ask this provider instead of the configured one (Settings → Test, the benchmark). */
  provider?: Provider;
}
export interface FindInput extends Common { target: string }
export interface FindManyInput extends Common { targets: string[] }

export async function findTarget(inp: FindInput): Promise<FindResult> {
  return (await findMany({ ...inp, targets: [inp.target] }))[0];
}

// The state Jev sees. Interactive-only trees are rebuilt slim (deduped, flat,
// capped names); trees with page text are kept as-is (minus dedup is not
// possible without losing the text's position) and only trimmed to budget.
export function buildState(inp: Common): { tree: string; cands: Candidate[]; deduped: number } {
  const raw = trimState(inp.tree);
  const seen = new Set<string>();
  const cands: Candidate[] = [];
  const out: string[] = [];
  let deduped = 0;
  for (const line of raw.split("\n")) {
    const m = CAND_RE.exec(line);
    if (!m) {
      // Page text / headings: kept in place (targets are often described by
      // nearby text), whitespace flattened, capped like names.
      const t = line.trim();
      if (t) out.push("  " + (t.length > TEXT_CAP ? t.slice(0, TEXT_CAP - 1) + "…" : t));
      continue;
    }
    const c: Candidate = { ref: Number(m[1]), role: m[2], name: m[3].replace(/\s+=.*$/, "").replace(/^"(.*)"$/, "$1"), line: line.trim() };
    if (inp.exclude?.has(candKey(c))) continue;
    const k = candKey(c);
    if (seen.has(k)) { deduped++; continue; }
    seen.add(k); cands.push(c); out.push(slimTree([c]));
  }
  return { tree: out.join("\n"), cands, deduped };
}
export const TEXT_CAP = 120;

// Several targets against ONE snapshot in ONE request (speculative fan-out):
// every target gets its own Choice(+batches) and exists Noul; the page-level
// pursue questions are asked once. Results come back in `targets` order.
export async function findMany(inp: FindManyInput): Promise<FindResult[]> {
  const { tree, cands, deduped } = buildState(inp);
  const empty = (t: string): FindResult => ({ target: t, exists: 0, confidence: 0, ranked: [], candidates: 0, deduped, model: "-", provider: "-", calibrated: true, inputTokens: 0, outputTokens: 0, requests: 0 });
  if (!cands.length) return inp.targets.map(empty);
  const P = inp.provider ?? activeProvider();
  const state: Record<string, string> = { url: inp.url, title: inp.title ?? "", page: tree };
  if (inp.history) state.history = inp.history;
  const byRef = new Map(cands.map((c) => [c.ref, c]));
  const batches = chunk(cands, CHOICE_MAX);

  const questions: Record<string, any> = {};
  inp.targets.forEach((t, ti) => {
    questions[`exists_${ti}`] = inp.pursue ? Q.existsToward(t) : Q.exists(t);
    batches.forEach((b, bi) => { questions[`where_${ti}_${bi}`] = Q.where(t, b); });
  });
  if (inp.pursue) {
    const goal = inp.targets[0];
    questions.reached = Q.reached(goal); questions.blocked = Q.blocked(); questions.willReach = Q.willReach(goal);
  }
  // Speculative: latency is flat in question count (measured 240–330 ms for 1 or 5
  // questions), so the "closest hop" is asked up front and only READ on a miss —
  // a miss costs one request instead of three.
  if (inp.hint) inp.targets.forEach((t, ti) => { questions[`toward_${ti}`] = Q.toward(t, batches[0]); });

  const r1 = await P.systemOne({ state, questions });
  let inputTokens = r1.usage.input_tokens, outputTokens = r1.usage.output_tokens;
  let calibrated = r1.calibrated;
  let requests = 1;
  const A = r1.answers as Record<string, any>;

  const toRanked = (probs: Record<string, number>): Ranked[] =>
    Object.entries(probs)
      .map(([ref, p]) => ({ ref: Number(ref), p, role: byRef.get(Number(ref))?.role ?? "?", name: byRef.get(Number(ref))?.name ?? "" }))
      .sort((a, b) => b.p - a.p);

  // Second pass only when a page exceeded 255 candidates: survivors of every
  // batch compete in one Choice per target (still a single request).
  let second: Record<string, any> | null = null;
  if (batches.length > 1) {
    const q2: Record<string, any> = {};
    const allSurvivors = new Map<number, Candidate>();
    inp.targets.forEach((t, ti) => {
      const survivors = batches.flatMap((_, bi) => toRanked(A[`where_${ti}_${bi}`].probabilities).slice(0, SHORTLIST_PER_BATCH)).map((r) => byRef.get(r.ref)!);
      survivors.forEach((c) => allSurvivors.set(c.ref, c));
      q2[`where_${ti}`] = Q.where(t, survivors);
    });
    // The finalists only, not the whole page again: on a 1 300-ref page this is
    // ~20 lines instead of ~13k tokens, and the lines carry role + name already.
    const state2 = { url: inp.url, title: inp.title ?? "", page: [...allSurvivors.values()].map((c) => c.line).join("\n") };
    const r2 = await P.systemOne({ state: state2, questions: q2 });
    inputTokens += r2.usage.input_tokens; outputTokens += r2.usage.output_tokens; requests++;
    calibrated &&= r2.calibrated;
    second = r2.answers as Record<string, any>;
  }

  return inp.targets.map((t, ti) => {
    const a = second ? second[`where_${ti}`] : A[`where_${ti}_0`];
    return {
      target: t,
      exists: A[`exists_${ti}`].noul,
      confidence: a.confidence,
      ranked: toRanked(a.probabilities).slice(0, 5),
      reached: inp.pursue ? A.reached.noul : undefined,
      blocked: inp.pursue ? A.blocked.noul : undefined,
      willReach: inp.pursue ? A.willReach.noul : undefined,
      toward: inp.hint && A[`toward_${ti}`] ? { ranked: toRanked(A[`toward_${ti}`].probabilities).slice(0, 3), confidence: A[`toward_${ti}`].confidence } : undefined,
      candidates: cands.length,
      deduped,
      model: r1.model,
      provider: P.label,
      calibrated,
      inputTokens: ti === 0 ? inputTokens : 0, // tokens are billed once per request; attribute to the first
      outputTokens: ti === 0 ? outputTokens : 0,
      requests: ti === 0 ? requests : 0,
    };
  });
}

// Tiny second request: only the chosen element's line plus the goal, so the
// judgment is about that control and nothing else on the page.
export async function guardJudge(cand: Ranked, goal: string, url: string, provider?: Provider): Promise<{ g: number; calibrated: boolean }> {
  const r = await (provider ?? activeProvider()).systemOne({
    state: { url, goal, element: `[${cand.ref}] ${cand.role} ${JSON.stringify(cand.name)}` },
    questions: { guard: Q.guard() },
  });
  return { g: (r.answers.guard as any).noul, calibrated: r.calibrated };
}
export async function guardClick(cand: Ranked, goal: string, url: string): Promise<number> {
  return (await guardJudge(cand, goal, url)).g;
}
/** Refuse the click? Uncalibrated answers refuse unless the model is clearly sure the click is harmless. */
export const guardRefuses = (g: number, calibrated: boolean) => g >= (calibrated ? THRESHOLDS.guard : UNCALIBRATED.guard);

// ── Formatting shared by hub ops ─────────────────────────────────────────────
export const pct = (x: number) => `${Math.round(x * 100)}%`;
export function formatShortlist(ranked: Ranked[]): string {
  return ranked.map((r) => `  [${r.ref}] ${r.role} ${JSON.stringify(r.name)}  ${pct(r.p)}`).join("\n");
}
