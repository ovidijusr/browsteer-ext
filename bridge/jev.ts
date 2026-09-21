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
  stuck: 0.2,         // pursue: Choice confidence below this → stop and hand back. Low on purpose: a wrong hop is cheap and bounded (guard + step limit), a stop costs a Claude turn
  willReach: 0.7,     // pursue: "the click itself lands on the goal" → skip the confirming round trip (72–78% on two correct cases)
} as const;

// Guard is only asked when the candidate's name smells like a commitment. Links
// only navigate; unlabelled or neutral buttons on a click path are not worth a
// 250 ms round trip. Tune here; matched names are visible in actions.detail.
//
// English words are whole-word (`\bbook\b` no longer fires on "Booking.com",
// `\bpost\b` not on "Posts"); Lithuanian entries stay stems because of inflection.
// STRONG words guard every role. WEAK words are commitments only on buttons
// ("Order" / "Post" / "Share" as a nav link is a section, not an action).
export const RISK_RE = /\b(buy|purchase|checkout|pay|payment|subscribe|unsubscribe|send|submit|confirm|approve|publish|delete|remove|erase|log ?out|sign ?out|transfer|donate)\b|(pirkti|užsakyti|apmok|mokė|prenumer|siųsti|siusti|patvirtin|ištrin|istrin|šalin|salin|atšauk|atsauk|atsijung|užsisak|rezervuo|paskelb|dalintis|atsakyti)/i;
export const RISK_WEAK_RE = /\b(order|post|reply|share|cancel|book|reserve)\b/i;
export function needsGuard(c: { role: string; name: string }): boolean {
  if (RISK_RE.test(c.name)) return true;
  if (c.role === "link") return false;
  return RISK_WEAK_RE.test(c.name) || c.name.trim().length < 2; // nameless controls stay guarded
}

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

// Warm the TLS connection at hub start so the first find is not the slow one.
export async function warm(): Promise<void> {
  try { await client().models.list(); } catch {}
}

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
  candidates: number;
  deduped: number;           // exact-duplicate controls removed from the state
  model: string;
  inputTokens: number;
  requests: number;
}

// `history` (pursue): the hops already taken, so the model knows which view it
// is in and does not steer back. `exclude`: refs the caller has already clicked
// on this very page (as role+name keys from `candKey`, since refs are reassigned
// per snapshot) — they leave the option list so a loop cannot re-pick them.
export const candKey = (c: { role: string; name: string }) => `${c.role}\u0000${c.name}`;
interface Common { url: string; title?: string; tree: string; pursue?: boolean; history?: string; exclude?: Set<string> }
export interface FindInput extends Common { target: string }
export interface FindManyInput extends Common { targets: string[] }

export async function findTarget(inp: FindInput): Promise<FindResult> {
  return (await findMany({ ...inp, targets: [inp.target] }))[0];
}

// The state Jev sees. Interactive-only trees are rebuilt slim (deduped, flat,
// capped names); trees with page text are kept as-is (minus dedup is not
// possible without losing the text's position) and only trimmed to budget.
function buildState(inp: Common): { tree: string; cands: Candidate[]; deduped: number } {
  const raw = trimState(inp.tree);
  const all = parseCandidates(raw).filter((c) => !inp.exclude?.has(candKey(c)));
  const hasText = /^\s*"/m.test(raw);
  if (hasText) return { tree: raw, cands: all, deduped: 0 };
  const { kept, dropped } = dedupeCandidates(all);
  return { tree: slimTree(kept), cands: kept, deduped: dropped };
}

// Several targets against ONE snapshot in ONE request (speculative fan-out):
// every target gets its own Choice(+batches) and exists Noul; the page-level
// pursue questions are asked once. Results come back in `targets` order.
export async function findMany(inp: FindManyInput): Promise<FindResult[]> {
  const { tree, cands, deduped } = buildState(inp);
  const empty = (t: string): FindResult => ({ target: t, exists: 0, confidence: 0, ranked: [], candidates: 0, deduped, model: "-", inputTokens: 0, requests: 0 });
  if (!cands.length) return inp.targets.map(empty);
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

  const r1 = await client().systemOne({ state, questions });
  let inputTokens = r1.usage.input_tokens;
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
    const r2 = await client().systemOne({ state: state2, questions: q2 });
    inputTokens += r2.usage.input_tokens; requests++;
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
      candidates: cands.length,
      deduped,
      model: r1.model,
      inputTokens: ti === 0 ? inputTokens : 0, // tokens are billed once per request; attribute to the first
      requests: ti === 0 ? requests : 0,
    };
  });
}

// After a miss: one Choice over the same (slim) state asking which element
// leads TOWARD the target. Returned as a hint; the hub never clicks it itself.
export interface Toward { ranked: Ranked[]; confidence: number; inputTokens: number }
export async function findToward(inp: FindInput): Promise<Toward | null> {
  const { tree, cands } = buildState(inp);
  if (!cands.length) return null;
  const batch = cands.slice(0, CHOICE_MAX); // a hint does not warrant the two-pass dance
  const byRef = new Map(batch.map((c) => [c.ref, c]));
  const state: Record<string, string> = { url: inp.url, title: inp.title ?? "", page: tree };
  const r = await client().systemOne({ state, questions: { toward: Q.toward(inp.target, batch) } });
  const a = r.answers.toward as any;
  const ranked: Ranked[] = Object.entries(a.probabilities as Record<string, number>)
    .map(([ref, p]) => ({ ref: Number(ref), p, role: byRef.get(Number(ref))?.role ?? "?", name: byRef.get(Number(ref))?.name ?? "" }))
    .sort((x, y) => y.p - x.p).slice(0, 3);
  return { ranked, confidence: a.confidence, inputTokens: r.usage.input_tokens };
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
