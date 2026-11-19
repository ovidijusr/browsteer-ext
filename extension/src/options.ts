// Settings page (the extension's options page): how long access lasts, where
// Claude can work, what Claude did (Activity, from the bridge's action log), and semantic targeting: which model provider answers (TypeSafe
// Jev, nexos.ai, OpenRouter, a local Ollama, a custom address), its model and API
// key, and a Test. Opened from
// the popup. The two wide choices are off by default, say their risk before they
// are picked, and ask for a confirmation; they stay available for people who want them.
import { ext } from "./ext";
import { drawIcons } from "./icons";
import { UPDATE_CMD, getStatus, send, setText, updatePrompt, type Status } from "./keyview";
import { hostOf } from "./policy";
import { ALL, andList, applyFilters, browserName, choices, group, readActivity, type ActivityItem, type ActivityReply, type SessionGroup } from "./activity";
import { MODEL_RE, calibrationText, choiceById, choiceOf, privacyText, type Choice, type TargetingInfo, type TestResult } from "./targeting";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const radios = (name: string) => [...document.querySelectorAll<HTMLInputElement>(`input[name=${name}]`)];
let drawn = "";
let replacing = false;
let last: Status | null = null;
/** The Custom address is being typed: polling must not overwrite it. */
let baseDirty = false;

/** Send a change, show "Saved" (unless the bridge answered with an error), redraw. */
async function save(type: string, extra: Record<string, unknown> = {}): Promise<Status | null> {
  const s = await send(type, extra);
  const error = typeof s?.reply?.error === "string" ? s.reply.error : null;
  if (s && !error) { const el = $("saved"); el.classList.add("on"); setTimeout(() => el.classList.remove("on"), 1600); }
  render(s);
  return s;
}
/** Bridges from 2.1.0 take the provider-aware key messages; older ones only know TypeSafe's. */
const newBridge = () => !!last?.jev?.targeting;

function render(s: Status | null) {
  if (!s) return;
  last = s;
  const { siteMode, allow, block, alwaysOn } = s.settings;
  // In every-site mode, allowing does nothing: only Block is offered.
  const every = siteMode === "block";
  $("addAllow").hidden = every;
  $("addBlock").classList.toggle("primary", every);
  $<HTMLInputElement>("newSite").placeholder = every ? "Site to block, e.g. mybank.com" : "example.com";
  $("addLabel").textContent = every ? "Block a site" : "Add a site";
  $("allowedNote").hidden = !every;
  // The page's top edge shows access as it is now, in the popup's colours.
  $("bar").dataset.tone = !s.armed ? "locked" : alwaysOn || every ? "danger" : "open";
  // The radios always show what is in force; a dangerous choice waiting for its confirmation is only marked pending.
  for (const r of radios("access")) r.checked = r.value === (alwaysOn ? "always" : "hour");
  for (const r of radios("mode")) r.checked = r.value === siteMode;
  renderJev(s);

  // Sites: redraw only when the lists changed, so focus and hover are not lost every poll.
  const sig = JSON.stringify([allow, block]);
  if (sig === drawn) return;
  drawn = sig;
  const row = (host: string, kind: "Allowed" | "Blocked") => {
    const li = document.createElement("li");
    const name = document.createElement("code");
    name.textContent = host;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "btn";
    rm.textContent = kind === "Allowed" ? "Remove" : "Unblock";
    rm.setAttribute("aria-label", `${rm.textContent} ${host}`);
    rm.addEventListener("click", () => save("forgetSite", { host }));
    li.append(name, rm);
    return li;
  };
  const sorted = (l: string[]) => [...l].sort((a, b) => a.localeCompare(b));
  $("allowed").replaceChildren(...sorted(allow).map((h) => row(h, "Allowed")));
  $("blocked").replaceChildren(...sorted(block).map((h) => row(h, "Blocked")));
  $("allowedBlock").hidden = !allow.length;
  $("blockedBlock").hidden = !block.length;
  $("noSites").hidden = allow.length + block.length > 0;
}

/** The provider picker, then one of: an address to set, a key to add, or the switch with Test. */
function renderJev(s: Status) {
  const off = !s.connected ? "Start the bridge first: run /browse in Claude Code, then come back here."
    : !s.jev ? `The bridge is too old for this. Ask Claude Code: “${updatePrompt(s.bridgeDir)}” Or run \`${UPDATE_CMD}\` there yourself.`
    : null;
  $("jevOff").hidden = !off;
  if (off) setText($("jevOff"), off);
  // Bridges before 2.1.0 know only TypeSafe: no picker, everything else as before.
  const t = s.jev?.targeting ?? null;
  $("providerBlock").hidden = !!off || !t;
  setText($("privacy"), privacyText(t));
  if (off) { $("jevSetup").hidden = true; $("jevReady").hidden = true; return; }
  const jev = s.jev!;
  const openai = t?.provider === "openai";
  const choice = choiceById(choiceOf(t));
  const sel = $<HTMLSelectElement>("provider");
  if (document.activeElement !== sel) sel.value = choice.id;
  $("endpoint").hidden = !openai;
  if (t && openai) {
    const custom = t.preset === "custom";
    const input = $<HTMLInputElement>("baseUrl");
    input.readOnly = !custom;
    $("baseSave").hidden = !custom;
    if (!custom || (!baseDirty && document.activeElement !== input)) input.value = t.baseUrl || (custom ? "" : choice.baseUrl);
    renderModels(t, jev.keyPresent);
  }
  // Custom needs its address before anything else; a service on this computer needs no key.
  const ready = !openai || !!t?.host;
  const keyNeeded = t ? t.keyNeeded : true;
  const needKey = ready && keyNeeded && (!jev.keyPresent || replacing);
  const setup = $("jevSetup");
  if (setup.hidden === needKey) { setup.hidden = !needKey; if (needKey && replacing) $("jevKey").focus(); }
  if (needKey) renderKeyStep(t, choice);
  $("keyCancel").hidden = !replacing;
  $("jevReady").hidden = !ready || needKey;
  if (!ready || needKey) return;
  const sw = $<HTMLInputElement>("jevSwitch");
  sw.checked = jev.on;
  sw.disabled = jev.envOverride;
  $("switchText").textContent = !t || t.provider === "typesafe" ? "Send page outlines to TypeSafe" : t.local ? `Use the model on this computer` : `Send page outlines to ${t.label}`;
  const keyFile = !t || t.provider === "typesafe" ? "~/.config/typesafe/env" : "~/.browsteer/keys.env";
  const what = openai && t?.model ? `${t.model} · ` : "";
  setText($("jevNote"), jev.envOverride ? "Fixed by `BROWSTEER_JEV` where the bridge runs" : !keyNeeded ? `${what}No key needed on this computer` : `${what}Key saved in \`${keyFile}\``);
  $("keyActions").hidden = !keyNeeded;
  renderTest(t);
}

/** Step 1 of adding a key: where to get one. */
function renderKeyStep(t: TargetingInfo | null, choice: Choice) {
  const step = $("keyStep");
  const label = !t || t.provider === "typesafe" ? "TypeSafe" : t.label;
  if (choice.keyUrl) {
    const a = document.createElement("a");
    a.href = choice.keyUrl; a.rel = "noopener"; a.target = "_blank"; a.textContent = choice.keyWhere ?? choice.keyUrl;
    step.replaceChildren("Create an API key at ", a, ".");
  } else if (choice.keyWhere) step.replaceChildren(`Create an API key in ${choice.keyWhere}.`);
  else step.replaceChildren(`Get an API key for ${t?.host || "the service"}.`);
  const input = $<HTMLInputElement>("jevKey");
  input.placeholder = `${label} API key`;
  input.setAttribute("aria-label", `${label} API key`);
  setText($("keyFile"), `Saved in \`${!t || t.provider === "typesafe" ? "~/.config/typesafe/env" : "~/.browsteer/keys.env"}\`, readable only by you. Never stored in the browser.`);
}

// ── Models ───────────────────────────────────────────────────────────────────
// Asked from the bridge, which holds the key: once per provider + address + key.
let models: { sig: string; list: string[]; error: string | null; loading: boolean } = { sig: "", list: [], error: null, loading: false };
function renderModels(t: TargetingInfo, keyPresent: boolean) {
  const canList = !!t.host && keyPresent;
  const sig = `${t.preset}|${t.baseUrl}|${keyPresent}`;
  if (canList && sig !== models.sig) { models = { sig, list: [], error: null, loading: true }; loadModels(); }
  const sel = $<HTMLSelectElement>("model");
  const list = !t.model || models.list.includes(t.model) ? models.list : [t.model, ...models.list];
  const placeholder = !t.host ? "Save the address first" : !keyPresent ? "Add the key first" : models.loading ? "Loading models…" : list.length ? "Choose a model" : "No models listed";
  const want = JSON.stringify([list, t.model, placeholder]);
  if (sel.dataset.sig !== want && document.activeElement !== sel) {
    const first = new Option(placeholder, "", !t.model, !t.model);
    first.disabled = true;
    sel.replaceChildren(first, ...list.map((m) => new Option(m, m, false, m === t.model)));
    sel.value = t.model;
    sel.dataset.sig = want;
  }
  sel.disabled = !canList && !t.model;
  $("modelReload").hidden = !canList;
  const note = models.error ? `Couldn't load the model list: ${models.error}` : canList && !t.model && !models.loading ? "Choose the model that should answer." : "";
  $("modelNote").hidden = !note;
  $("modelNote").textContent = note;
}
async function loadModels() {
  const s = await send("listModels");
  const r = s?.reply as { type: string; models?: unknown; error?: unknown } | undefined;
  models.loading = false;
  if (r?.type === "models") {
    models.list = Array.isArray(r.models) ? r.models.filter((m): m is string => typeof m === "string" && MODEL_RE.test(m)) : [];
    models.error = typeof r.error === "string" ? r.error : null;
  } else models.error = "the bridge didn't answer.";
  render(s ?? last);
}

// ── Test ─────────────────────────────────────────────────────────────────────
// The bridge runs three canned pages (bridge/targeting-tasks.ts), never one of yours.
let testing = false;
let testResult: TestResult | null = null;
let testFor = "";
function renderTest(t: TargetingInfo | null) {
  const forNow = `${t?.provider}|${t?.preset}|${t?.baseUrl}|${t?.model}`;
  if (forNow !== testFor) { testFor = forNow; testResult = null; }
  const btn = $<HTMLButtonElement>("testBtn");
  const noModel = t?.provider === "openai" && !t.model;
  btn.disabled = testing || noModel;
  btn.textContent = testing ? "Testing…" : "Test";
  const rows = $("testRows");
  const r = testResult;
  // What Test found beats what the bridge remembers.
  const cal = r?.rows && typeof r.calibrated === "boolean" && t ? { ...t, calibrated: r.calibrated } : t;
  setText($("calNote"), calibrationText(cal));
  if (!r) {
    rows.hidden = true;
    $("testSummary").textContent = noModel ? "Choose a model first." : testing ? "Asking the model about three sample pages…" : "Runs three sample pages (not yours) through the model.";
    return;
  }
  if (!r.rows?.length) { rows.hidden = true; $("testSummary").textContent = `Test failed: ${r.error ?? "no answer"}`; return; }
  const right = r.rows.filter((x) => x.correct).length;
  const ms = [...r.rows.map((x) => x.ms)].sort((a, b) => a - b)[Math.floor(r.rows.length / 2)];
  $("testSummary").textContent = `${right} of ${r.rows.length} right · median ${ms} ms · ${r.calibrated ? "calibrated" : "uncalibrated"}`;
  rows.replaceChildren(...r.rows.map((x) => {
    const li = document.createElement("li");
    const ic = document.createElement("span");
    ic.dataset.icon = x.correct ? "open" : "remove";
    ic.dataset.size = "16";
    const what = document.createElement("span");
    what.textContent = `“${x.target}”`;
    const verdict = document.createElement("small");
    verdict.textContent = !x.ok ? "no answer" : x.correct ? `right, ${Math.round(x.p * 100)}% sure` : `wrong: ${x.picked}`;
    what.append(verdict);
    const time = document.createElement("span");
    time.className = "ms";
    time.textContent = `${x.ms} ms`;
    li.append(ic, what, time);
    return li;
  }));
  drawIcons(rows);
  rows.hidden = false;
}

// Safe choices apply at once; dangerous ones ask first.
function guarded(name: string, danger: string, confirmId: string, yesId: string, apply: (v: string) => Promise<unknown>) {
  for (const r of radios(name)) r.addEventListener("change", () => {
    if (!r.checked) return;
    const card = radios(name).find((x) => x.value === danger)!.closest(".choice") as HTMLElement;
    if (r.value === danger) {
      // Nothing changes until the person confirms: the radio goes back to what is in force.
      render(last);
      card.dataset.pending = "";
      $(confirmId).hidden = false;
      // Focus starts on Cancel: one stray Enter must not widen access.
      ($(confirmId).querySelector("[data-cancel]") as HTMLElement).focus();
      return;
    }
    delete card.dataset.pending;
    $(confirmId).hidden = true;
    apply(r.value);
  });
  const card = () => radios(name).find((x) => x.value === danger)!.closest(".choice") as HTMLElement;
  $(yesId).addEventListener("click", () => { delete card().dataset.pending; $(confirmId).hidden = true; apply(danger); });
  $(confirmId).addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Escape") ($(confirmId).querySelector("[data-cancel]") as HTMLElement).click(); });
  $(confirmId).querySelector("[data-cancel]")!.addEventListener("click", () => {
    delete card().dataset.pending;
    $(confirmId).hidden = true;
    render(last);
    radios(name).find((x) => x.value === danger)!.focus();
  });
}
guarded("access", "always", "confirmAccess", "yesAccess", (v) => save("setAlwaysOn", { value: v === "always" }));
guarded("mode", "block", "confirmSites", "yesSites", (v) => save("setSiteMode", { value: v }));

// Accepts "example.com", "https://example.com/some/page" or "*.example.com".
function siteError(msg: string) {
  const input = $<HTMLInputElement>("newSite");
  $("siteError").textContent = msg;
  $("siteError").hidden = !msg;
  input.setAttribute("aria-invalid", String(!!msg));
}
$<HTMLFormElement>("addSite").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("newSite");
  const raw = input.value.trim().replace(/^\*\./, "");
  if (!raw) return siteError("Type a site address first, like example.com.");
  const host = hostOf(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!host || !host.includes(".")) return siteError(`“${raw}” isn't a site address. Try something like example.com.`);
  const type = ((e as SubmitEvent).submitter as HTMLButtonElement | null)?.value ?? "allowSite";
  siteError("");
  input.value = "";
  save(type, { host }).then(() => {
    const el = $("siteAdded");
    el.textContent = `${type === "blockSite" ? "Blocked" : "Allowed"} ${host}`;
    el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 2500);
  });
});
$("newSite").addEventListener("input", () => { siteError(""); $("siteAdded").hidden = true; });

// The key goes to the bridge, which writes it to ~/.config/typesafe/env (TypeSafe) or
// ~/.browsteer/keys.env (the others). The field is cleared at once.
function keyError(msg: string) { $("keyError").textContent = msg; $("keyError").hidden = !msg; $("jevKey").setAttribute("aria-invalid", String(!!msg)); }
$<HTMLFormElement>("jevKeyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("jevKey");
  const key = input.value.trim();
  if (!key) return keyError("Paste your key first.");
  if (!/^[!-~]{8,512}$/.test(key)) return keyError("That doesn't look like a whole key. Paste it again, without spaces.");
  keyError("");
  input.value = "";
  replacing = false;
  await save(newBridge() ? "setTargetingKey" : "setJevKey", { key });
});
$("jevKey").addEventListener("input", () => keyError(""));
$("jevReplace").addEventListener("click", () => { replacing = true; render(last); });
$("keyCancel").addEventListener("click", () => { replacing = false; keyError(""); render(last); });
// Removing the key also turns it off; it takes a second click.
let removeArmed = 0;
$("jevRemove").addEventListener("click", async () => {
  if (Date.now() - removeArmed > 4000) { removeArmed = Date.now(); $("jevRemove").textContent = "Click again to delete the key"; setTimeout(() => { $("jevRemove").textContent = "Delete key"; }, 4000); return; }
  removeArmed = 0;
  $("jevRemove").textContent = "Delete key";
  await save(newBridge() ? "removeTargetingKey" : "removeJevKey");
});
$("jevSwitch").addEventListener("change", (e) => save("setJev", { value: (e.target as HTMLInputElement).checked }));

// Provider, address and model. Each change saves at once, like the rest of the page.
function baseError(msg: string) { $("baseError").textContent = msg; $("baseError").hidden = !msg; $("baseUrl").setAttribute("aria-invalid", String(!!msg)); }
$<HTMLSelectElement>("provider").addEventListener("change", async (e) => {
  replacing = false; baseDirty = false; baseError(""); keyError("");
  await save("setTargeting", { choice: (e.target as HTMLSelectElement).value });
  if ((e.target as HTMLSelectElement).value === "custom" && !last?.jev?.targeting?.baseUrl) $("baseUrl").focus();
});
$("baseUrl").addEventListener("input", () => { baseDirty = true; baseError(""); });
$<HTMLFormElement>("baseForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $<HTMLInputElement>("baseUrl").value.trim();
  if (!url) return baseError("Type the API address, like https://api.example.com/v1.");
  const s = await save("setTargeting", { choice: "custom", baseUrl: url });
  const error = typeof s?.reply?.error === "string" ? s.reply.error : "";
  baseError(error);
  if (!error) baseDirty = false;
});
$<HTMLSelectElement>("model").addEventListener("change", (e) => save("setTargeting", { choice: choiceOf(last?.jev?.targeting), model: (e.target as HTMLSelectElement).value }));
$("modelReload").addEventListener("click", () => { models.sig = ""; render(last); });
$("testBtn").addEventListener("click", async () => {
  testing = true; testResult = null; render(last);
  const s = await send("testTargeting");
  testing = false;
  const r = s?.reply;
  testResult = r?.type === "targetingTest" ? (r as unknown as TestResult) : { ok: false, error: "the bridge didn't answer in time." };
  render(s ?? last);
});

// ── Activity ─────────────────────────────────────────────────────────────────
// The bridge words each action; this page asks for the list (only this page may),
// filters it and groups it by day and by Claude session.
const ACT_LIMIT = 300;
let act: ActivityReply | null = null;
let actState: "idle" | "loading" | "noBridge" | "noAnswer" = "idle";
let actSig = "";
async function loadActivity() {
  if (actState === "loading") return;
  if (last && !last.connected) { actState = "noBridge"; renderActivity(); return; }
  actState = "loading";
  const s = await send("activity", { limit: ACT_LIMIT });
  const r = readActivity(s?.reply);
  if (r) act = r;
  actState = r ? "idle" : s && !s.connected ? "noBridge" : "noAnswer";
  renderActivity();
}
const clockOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function fillSelect(sel: HTMLSelectElement, all: string, opts: { value: string; label: string }[]) {
  const want = JSON.stringify(opts);
  if (sel.dataset.sig === want) return;
  const keep = sel.value;
  sel.replaceChildren(new Option(all, ALL), ...opts.map((o) => new Option(o.label, o.value)));
  sel.value = opts.some((o) => o.value === keep) ? keep : ALL;
  sel.dataset.sig = want;
}
function renderActivity() {
  const off = actState === "noBridge" ? "Start the bridge to see what Claude did: run /browse in Claude Code, then come back here."
    : actState === "noAnswer" && !act ? `The bridge didn't send its activity. If it is older than this extension, ask Claude Code: “${updatePrompt(last?.bridgeDir ?? null)}”`
    : null;
  $("actOff").hidden = !off;
  if (off) setText($("actOff"), off);
  const items = off ? [] : act?.items ?? [];
  $("actFilters").hidden = !items.length;
  const c = choices(items);
  fillSelect($<HTMLSelectElement>("actBrowser"), "All browsers", c.browsers);
  fillSelect($<HTMLSelectElement>("actSite"), "All sites", c.sites.map((h) => ({ value: h, label: h })));
  const f = { browser: $<HTMLSelectElement>("actBrowser").value, site: $<HTMLSelectElement>("actSite").value, problems: $<HTMLInputElement>("actProblems").checked };
  const shown = applyFilters(items, f);
  // Redraw only when something changed, so a poll does not move the page under the reader.
  const sig = JSON.stringify([f, shown.map((i) => i.id), off, act?.now ? Math.floor(act.now / 60_000) : 0]);
  if (sig === actSig) return;
  actSig = sig;
  const empty = off || !act ? null
    : !items.length ? "Nothing yet. When Claude reads or does something in a browser, it shows up here."
    : !shown.length ? (f.problems ? "Nothing was refused or failed with these filters." : "No actions match these filters.")
    : null;
  $("actEmpty").hidden = !empty;
  if (empty) $("actEmpty").textContent = empty;
  $("actList").replaceChildren(...group(shown, act?.now ?? Date.now()).map((d) => {
    const day = document.createElement("div");
    day.className = "act-day";
    const h = document.createElement("h3");
    h.className = "list-head";
    h.textContent = d.label;
    day.append(h, ...d.sessions.map(sessionBlock));
    return day;
  }));
  const keep = act && !off ? `The bridge keeps ${act.keepDays} days of activity, on this computer only.${items.length >= ACT_LIMIT ? ` Showing the latest ${ACT_LIMIT}.` : ""}` : "";
  $("actKeep").hidden = !keep;
  $("actKeep").textContent = keep;
}
function sessionBlock(g: SessionGroup): HTMLElement {
  const box = document.createElement("div");
  box.className = "act-session";
  const head = document.createElement("p");
  head.className = "act-head";
  const when = clockOf(g.first) === clockOf(g.last) ? clockOf(g.last) : `${clockOf(g.first)}–${clockOf(g.last)}`;
  const who = g.session ? "Claude session" : "Earlier actions";
  const count = `${g.items.length} action${g.items.length === 1 ? "" : "s"}`;
  const b = document.createElement("b");
  b.textContent = who;
  head.append(b, ` · ${[when, andList(g.browsers), count].filter(Boolean).join(" · ")}`);
  const list = document.createElement("ol");
  list.className = "act-rows";
  list.append(...g.items.map(row));
  box.append(head, list);
  return box;
}
const OUTCOME = { ok: "OK", refused: "Refused", error: "Failed" } as const;
function row(i: ActivityItem): HTMLElement {
  const li = document.createElement("li");
  li.dataset.outcome = i.outcome;
  const time = document.createElement("time");
  time.dateTime = new Date(i.ts).toISOString();
  time.textContent = clockOf(i.ts);
  const what = document.createElement("span");
  what.className = "what";
  what.append(i.action);
  const where = document.createElement("small");
  where.textContent = [i.browser ? browserName(i.browser) : "", i.site].filter(Boolean).join(" · ");
  what.append(where);
  if (i.why) {
    const why = document.createElement("small");
    why.className = "why";
    why.textContent = i.why;
    what.append(why);
  }
  const out = document.createElement("span");
  out.className = "outcome";
  out.textContent = OUTCOME[i.outcome];
  li.append(time, what, out);
  return li;
}
for (const id of ["actBrowser", "actSite", "actProblems"]) $(id).addEventListener("change", renderActivity);
$("actRefresh").addEventListener("click", () => { loadActivity(); });

$("ver").textContent = `v${ext.runtime.getManifest().version}`;

drawIcons();
const refresh = () => getStatus().then(render);
refresh().then(loadActivity);
setInterval(refresh, 1500);
// New actions show up on their own while the page is open and in front.
setInterval(() => { if (document.visibilityState === "visible") loadActivity(); }, 10_000);
