// Targeting benchmark: labelled tasks (a page, a description, the element meant)
// run through every provider that has a key, plus the "without a provider"
// baseline: what Claude does instead (browser_snapshot, read it, browser_click).
//
//   bun run bench:targeting                      # baseline + every provider with a key
//   bun run bench:targeting --only baseline      # no model calls at all
//   bun run bench:targeting --models nexos=gpt-4.1-mini,openrouter=openai/gpt-4.1-mini,ollama=llama3.1:8b
//   bun run bench:targeting --providers nexos,ollama --no-write
//
// Providers: TypeSafe Jev when a TypeSafe key is found; nexos.ai / OpenRouter
// when their key is in ~/.browsteer/keys.env (or NEXOS_API_KEY / OPENROUTER_API_KEY)
// and a model is named (--models, or the model chosen in Settings for that
// provider); a local Ollama when it answers on 127.0.0.1:11434 (first model it
// lists unless named); Custom when Settings has one. Paid providers get one
// small request per task plus a warm-up (26 per run).
//
// Prints markdown tables and rewrites docs/BENCHMARK.md (skip with --no-write).
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { snapshot } from "../extension/src/snapshot";
import { listingPage, searchResultsPage } from "./fixtures";
import { formatShortlist, lexicalMatch, parseCandidates } from "../bridge/jev";
import { CART, LOGIN, TEST_TASKS, runTasks, type TargetTask, type TaskRun } from "../bridge/targeting-tasks";
import { PRESETS, listModels, loadKey, loadTypesafeKey, openaiProvider, targetingConfig, typesafeProvider, type PresetId, type Provider } from "../bridge/targeting";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const only = opt("--only");
const wanted = opt("--providers")?.split(",").map((s) => s.trim()).filter(Boolean);
const modelArg = Object.fromEntries((opt("--models") ?? "").split(",").filter((x) => x.includes("=")).map((x) => [x.slice(0, x.indexOf("=")).trim(), x.slice(x.indexOf("=") + 1).trim()]));
const write = !argv.includes("--no-write");

// ── Pages ────────────────────────────────────────────────────────────────────
/** `reply`: what browser_snapshot gives Claude (collapsed, deduped). `tree`: what find gives the model (uncollapsed so every control keeps its ref). */
interface Page { name: string; url: string; title: string; reply: string; tree: string }
function fromHtml(name: string, url: string, title: string, html: string): Page {
  const doc = () => { const w = new Window({ url }); w.document.write(html); return w.document as unknown as Document; };
  return {
    name, url, title,
    reply: `URL: ${url}\n${snapshot(doc()).tree}`,
    tree: snapshot(doc(), { interactiveOnly: false, chrome: true, collapse: false, dedup: true }).tree,
  };
}
const fromText = (name: string, url: string, title: string, tree: string): Page => ({ name, url, title, reply: `URL: ${url}\n${tree}`, tree });
const music = readFileSync(join(ROOT, "test", "fixture-tree.txt"), "utf8").split(/\r?\n/).filter((l) => /^\s*\[/.test(l)).join("\n");
const PAGES: Record<string, Page> = {
  cart: fromText("cart", "https://shop.example/cart", "Cart", CART),
  login: fromText("login", "https://northwind.example/login", "Sign in", LOGIN),
  music: fromText("music", "https://music.ovi.lt/#/playlists", "Playlists", music),
  listing: fromHtml("listing", "https://suchen.mobile.de/fahrzeuge/details.html?id=453073528", "BMW i4 M50", listingPage()),
  results: fromHtml("results", "https://suchen.mobile.de/fahrzeuge/search.html?vc=Car", "BMW i4 Angebote", searchResultsPage(8)),
};

// ── Tasks: [page, target, refs that count as right (null = not on the page)] ──
const RAW: [string, string, number[] | null][] = [
  ...TEST_TASKS.map((t) => [t.page, t.target, t.expect] as [string, string, number[] | null]),
  ["cart", "take the mouse out of my cart", [5]],
  ["cart", "change how many I'm buying", [6]],
  ["cart", "track my order", null],
  ["login", "stay logged in on this device", [3]],
  ["login", "I forgot my login details", [5]],
  ["login", "sign up for a new account", [6]],
  ["music", "skip to the next song", [96]],
  ["music", "make a new playlist", [46, 50]],
  ["music", "the volume control", [102]],
  ["music", "show the song lyrics", [97]],
  ["music", "go to my libraries", [2]],
  ["music", "the playlist of Lithuanian road trip songs", [29, 76]],
  ["music", "search the music collection", [47]],
  ["music", "log out of my account", null],
  ["listing", "show all photos of the car", [9]],
  ["listing", "the battery certificate", [43]],
  ["listing", "apply for a loan offer", [48]],
  ["listing", "the dealer's website", [49]],
  ["listing", "choose the loan term in months", [47]],
  ["listing", "save this car to my favourites", null],
  ["results", "the cheapest car", [1]],
  ["results", "the one with 54.675 km", [5]],
];
const TASKS: TargetTask[] = RAW.map(([page, target, expect], i) => ({ id: `t${i + 1}`, page, url: PAGES[page].url, title: PAGES[page].title, tree: PAGES[page].tree, target, expect }));

// ── Baseline: no provider ────────────────────────────────────────────────────
const tok = (s: string) => Math.round(s.length / 4);
/** A find(act:"click") reply of the usual shape, for the element that is right (or a "nothing matches"). */
function findReply(t: TargetTask): string {
  const cands = parseCandidates(t.tree);
  const right = t.expect ? cands.find((c) => c.ref === t.expect![0]) : undefined;
  const head = `URL: ${t.url}\nTargeting: <provider> <model>, calibrated · ${cands.length} candidates, 1 request, 900 tok`;
  if (!right) return `${head}\nNothing on this page matches ${JSON.stringify(t.target)} (exists 8%). Closest guesses:\n${formatShortlist(cands.slice(0, 3).map((c) => ({ ...c, p: 0.2 })))}\nUse browser_snapshot to look yourself, or rephrase the target.`;
  const runner = cands.find((c) => c.ref !== right.ref)!;
  return `${head}\nexists 96%, confidence 0.91\nClicked [${right.ref}] ${right.role} ${JSON.stringify(right.name)} (91%). Page settled in 180 ms; URL unchanged.\nRunner-ups: [${runner.ref}] ${JSON.stringify(runner.name)} 4%. browser_find again for the next step.`;
}
interface Base { task: TargetTask; snapTok: number; findTok: number; lexical: "right" | "wrong" | "-" }
const baseline: Base[] = TASKS.map((t) => {
  const lx = lexicalMatch(t.target, parseCandidates(t.tree));
  return { task: t, snapTok: tok(PAGES[t.page].reply), findTok: tok(findReply(t)), lexical: !lx ? "-" : t.expect?.includes(lx.ref) ? "right" : "wrong" };
});

// ── Providers ────────────────────────────────────────────────────────────────
async function ollamaUp(): Promise<string[] | null> {
  try { return await listModels(PRESETS.ollama.baseUrl, null, ((u: any, i: any) => fetch(u, { ...i, signal: AbortSignal.timeout(800) })) as typeof fetch); } catch { return null; }
}
async function providers(): Promise<{ id: string; prov?: Provider; skip?: string }[]> {
  if (only === "baseline") return [];
  const cfg = targetingConfig();
  const out: { id: string; prov?: Provider; skip?: string }[] = [];
  const want = (id: string) => !wanted || wanted.includes(id);
  if (want("typesafe")) out.push(loadTypesafeKey() ? { id: "typesafe", prov: typesafeProvider() } : { id: "typesafe", skip: "no TypeSafe key" });
  for (const id of ["nexos", "openrouter", "ollama", "custom"] as PresetId[]) {
    if (!want(id)) continue;
    const base = id === "custom" ? (cfg.preset === "custom" ? cfg.baseUrl : "") : PRESETS[id].baseUrl;
    if (!base) { out.push({ id, skip: "no address set" }); continue; }
    let model = modelArg[id] || (cfg.provider === "openai" && cfg.preset === id ? cfg.model : "");
    const key = loadKey(id, base);
    if (id === "ollama") {
      const listed = await ollamaUp();
      if (!listed) { out.push({ id, skip: "not running on 127.0.0.1:11434" }); continue; }
      model ||= listed[0] ?? "";
    } else if (!key && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(base)) { out.push({ id, skip: "no key" }); continue; }
    if (!model) { out.push({ id, skip: `no model (pass --models ${id}=<model>)` }); continue; }
    out.push({ id, prov: openaiProvider({ baseUrl: base, apiKey: key, model, label: PRESETS[id].label }) });
  }
  return out;
}

// ── Run ──────────────────────────────────────────────────────────────────────
const pctl = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] : 0; };
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const list = await providers();
const runs: { id: string; label: string; model: string; rows: TaskRun[] }[] = [];
for (const p of list) {
  if (!p.prov) continue;
  console.error(`running ${TASKS.length} tasks on ${p.prov.label} (${p.prov.model})…`);
  // One request first, not counted: a local server loads the model, a remote one opens the connection.
  await runTasks(p.prov, [TASKS[0]]);
  runs.push({ id: p.id, label: p.prov.label, model: p.prov.model, rows: await runTasks(p.prov, TASKS) });
}

const date = new Date().toISOString().slice(0, 10);
const lines: string[] = [];
const say = (s = "") => lines.push(s);

say(`### Providers (${TASKS.length} tasks, ${date})`);
say();
if (runs.length) {
  say("| provider | model | right | mean latency | p95 latency | tokens per task | Brier score | probabilities | errors |");
  say("|---|---|---|---|---|---|---|---|---|");
  for (const r of runs) {
    const okRows = r.rows.filter((x) => x.ok);
    const cal = okRows.every((x) => x.calibrated) ? "calibrated" : okRows.some((x) => x.calibrated) ? "mixed" : "uncalibrated";
    say(`| ${r.label} | ${r.model} | ${r.rows.filter((x) => x.correct).length}/${r.rows.length} | ${Math.round(mean(okRows.map((x) => x.ms)))} ms | ${pctl(okRows.map((x) => x.ms), 0.95)} ms | ${Math.round(mean(okRows.map((x) => x.inputTokens + x.outputTokens)))} | ${mean(r.rows.map((x) => x.brier)).toFixed(3)} | ${okRows.length ? cal : "-"} | ${r.rows.length - okRows.length} |`);
  }
} else say("No provider ran (no keys found, or `--only baseline`). The baseline below needs none.");
const skipped = list.filter((p) => p.skip);
if (skipped.length) { say(); say(`Skipped: ${skipped.map((p) => `${p.id} (${p.skip})`).join(", ")}.`); }

say();
say("### Without a provider: what Claude does instead");
say();
const provCols = runs.map((r) => r.label);
say(`| task | page | snapshot reply | round trips | find reply | round trips | find, no provider${provCols.map((c) => ` | ${c}`).join("")} |`);
say(`|---|---|---|---|---|---|---${provCols.map(() => "|---").join("")}|`);
for (const [i, b] of baseline.entries()) {
  const cells = runs.map((r) => { const x = r.rows[i]; return !x.ok ? "error" : `${x.correct ? "right" : "wrong"}, ${b.task.expect ? "" : "present "}${Math.round(x.p * 100)}%`; });
  say(`| ${JSON.stringify(b.task.target)}${b.task.expect ? "" : " (not on page)"} | ${b.task.page} | ${b.snapTok} tok | 2 | ${b.findTok} tok | 1 | ${b.lexical === "-" ? "needs a model" : `lexical, ${b.lexical}`}${cells.map((c) => ` | ${c}`).join("")} |`);
}
const sumSnap = baseline.reduce((a, b) => a + b.snapTok, 0), sumFind = baseline.reduce((a, b) => a + b.findTok, 0);
const lexRight = baseline.filter((b) => b.lexical === "right").length;
say();
say(`Totals over ${TASKS.length} tasks: Claude reads ${sumSnap} tokens of snapshots and makes ${TASKS.length * 2} tool calls without a provider; with one it reads ${sumFind} tokens of find replies in ${TASKS.length} calls (${Math.round((1 - sumFind / sumSnap) * 100)}% fewer tokens). With no provider at all, find still answers ${lexRight} of ${TASKS.length} tasks by exact name (lexical match); the rest need a model or a snapshot.`);

const table = lines.join("\n");
console.log(table);

if (write) {
  const doc = `# Targeting benchmark

\`bun run bench:targeting\` measures "find controls by description": how often each
model picks the element a person meant, how fast, at what cost, and how honest
its percentages are. It also measures what Claude does when no model is set up.

It runs with no keys at all (only the baseline), and adds every provider that has
a key. It never touches a browser: the pages are outlines written for the test
(\`bridge/targeting-tasks.ts\`), a saved playlist page outline
(\`test/fixture-tree.txt\`), and car pages built from \`test/fixtures.ts\`.

## How to run

\`\`\`sh
bun run bench:targeting                    # baseline + every provider with a key
bun run bench:targeting --only baseline    # no model calls
bun run bench:targeting --models nexos=gpt-4.1-mini,ollama=llama3.1:8b
bun run bench:targeting --providers nexos --no-write
\`\`\`

Keys are read where the bridge reads them (\`~/.config/typesafe/env\` for TypeSafe,
\`~/.browsteer/keys.env\` for the others). An OpenAI-compatible provider also needs a
model: the one chosen in Settings, or \`--models\`. A local Ollama is used when it
answers on 127.0.0.1:11434. Paid providers get one small request per task, plus one uncounted warm-up (${TASKS.length + 1} per run).

## What the columns mean

**Providers table**

- **right**: tasks where the provider's first pick is the element meant. For a
  target that is not on the page, right means it said "nothing matches".
- **mean / p95 latency**: time for one find, from asking to answer. p95: 95 of
  100 finds are at least this fast.
- **tokens per task**: tokens the provider was billed for one find (page outline in,
  answer out). These are the provider's tokens, not Claude's.
- **Brier score**: how well the provider's percentages match reality, from 0
  (always sure and right) to 1 (always sure and wrong). For each task: take the
  percentage it gave its answer, subtract 1 if the answer was right or 0 if it was
  wrong, square it; then average. A model that says 90% and is right 9 times in 10
  scores about 0.09. Lower is better.
- **probabilities**: *calibrated* when the percentages come from the model's own
  token probabilities (TypeSafe Jev, or an endpoint that returns logprobs);
  *uncalibrated* when the model wrote its own estimate as text. Browsteer is more
  careful with uncalibrated answers: it returns a shortlist instead of clicking
  unless the model is at least 95% sure.
- **errors**: requests that failed (network, refused key, unreadable reply).

**Without a provider table**

- **snapshot reply**: how much Claude reads when it has no provider: the whole
  \`browser_snapshot\` reply for that page, in tokens (characters ÷ 4).
- **round trips**: tool calls Claude makes. Without a provider it is 2
  (\`browser_snapshot\`, then \`browser_click\` on a ref); with one it is 1
  (\`browser_find\` with \`act: "click"\`).
- **find reply**: the size of a typical \`browser_find\` reply for that task.
- **find, no provider**: \`browser_find\` with no model still answers when the
  description contains the control's exact name ("lexical"). *needs a model* means
  Claude has to take a snapshot instead.
- Provider columns: right or wrong, and the percentage the provider gave its pick
  (for a target that is not on the page: the percentage it gave "it is on the page").

## Latest results

From the last run on a development machine: only the providers that machine had
set up appear, so run it yourself to compare the ones you use.

${table}
`;
  writeFileSync(join(ROOT, "docs", "BENCHMARK.md"), doc);
  console.error("wrote docs/BENCHMARK.md");
}
process.exit(0);
