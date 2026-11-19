// Popup: one answer (may Claude act here, now?), the one or two actions that
// change it, and the /browse command that hands Claude this browser's key.
// Colour means access state only: grey locked, green open, amber about to lock,
// red wide open. Two verbs, kept apart: "Allow" puts a site on the list, "Open"
// starts the timer. Every control here changes settings that only the person
// can change; the bridge cannot.
import { ext } from "./ext";
import { drawIcons, setIcon, type IconName } from "./icons";
import { CONFIG_FILE, UPDATE_CMD, clock, command, copyWithFeedback, getStatus, hostText, jevNote, minutesLeft, openFor, send, setText, trustPrompt, untilText, updatePrompt, type Status } from "./keyview";
import { ARM_MINUTES, covers } from "./policy";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
type Tone = "boot" | "off" | "locked" | "open" | "ending" | "danger";
type Act = { label: string; type: string; extra?: Record<string, unknown>; icon?: IconName; style?: "primary" | "danger" | "plain"; title?: string; warn?: boolean };
type Card = { bar: Tone; tone: Tone; icon: IconName; state: string; host?: string; pill?: string; pillOk?: boolean; detail?: string; time?: string; note?: string; links?: boolean };

let key = "";
let bridgeDir: string | null = null;
let updateFix: "prompt" | "check" | "reload" = "prompt";
let acts: { primary?: Act; secondary?: Act } = {};
let blockedHost = "";
let refusedOrigin = "";

function show(id: string, on: boolean) { $(id).hidden = !on; }
function text(id: string, t = "") { $(id).textContent = t; show(id, !!t); }

const isWide = (s: Status) => s.settings.alwaysOn || s.settings.siteMode === "block";
const ending = (s: Status) => { const m = minutesLeft(s); return m > 0 && m <= 5; };

/** The status card for this page, and the bar for access as a whole. */
function card(s: Status): Card {
  const site = s.site;
  const host = site?.host ?? "";
  const read = s.settings.readOnly;
  const until = untilText(s);
  const bar: Tone = !s.armed ? "locked" : isWide(s) ? "danger" : ending(s) ? "ending" : "open";
  const idle = s.connected ? "" : "The bridge starts when you paste the command below.";
  // Whether a Claude Code session has picked this browser up during the open hour (said only when it has).
  const ago = Math.round((Date.now() - s.pairedAt) / 60_000);
  const paired = s.connected && s.pairedAt > 0 && ago < ARM_MINUTES;
  const pairing = !s.connected ? idle : paired ? `Claude Code paired ${ago < 1 ? "just now" : `${ago} min ago`}` : "";
  const listed = site && s.settings.allow.some((e) => covers(e, host));
  const elsewhere = s.armed ? ` Your ${site?.blocked ? "other " : ""}allowed sites stay open ${openFor(s)}.` : "";
  if (s.refused && !s.connected) return { bar: "off", tone: "off", icon: "plug", state: "This bridge doesn't trust this browser yet", detail: "The bridge on this computer only works with the extensions on its list. Add this one:" };
  if (!s.connected && !s.setupDone) return { bar: "off", tone: "off", icon: "plug", state: "Not set up", detail: "Finish setup to connect Claude Code to this browser." };
  if (site?.blocked) return { bar, tone: "locked", icon: "blocked", state: "Blocked here", host, detail: `Claude can never act on this site.${elsewhere}`, note: idle };
  if (!s.armed) return {
    bar, tone: "locked", icon: "lock", state: "Locked", host,
    pill: !site ? "" : listed ? "On your allowed list" : s.settings.siteMode === "block" ? "" : "Not allowed yet", pillOk: !!listed,
    detail: "Claude can't read or click on any site.", note: idle,
  };
  if (!site) return { bar, tone: "locked", icon: "browser", state: "Not a website", detail: `Claude can't use browser pages like this one.${elsewhere}`, note: idle };
  if (!site.allowed) return { bar, tone: "locked", icon: "lock", state: "Not allowed here", host, detail: `Claude can't use this site until you allow it.${elsewhere}`, note: idle };
  const what = read ? "Claude can read here" : "Claude can act here";
  const how = read ? "Read only: no clicking or typing." : "";
  if (s.settings.siteMode === "block") return { bar, tone: "danger", icon: "danger", state: "Open on every site", host, pill: "Current tab", detail: how, time: s.settings.alwaysOn ? "No time limit. Only Stop now ends it." : until, note: pairing, links: true };
  if (s.settings.alwaysOn) return { bar, tone: "danger", icon: "danger", state: `${what}, no time limit`, host, detail: how, time: "Only Stop now ends it.", note: pairing, links: true };
  if (ending(s)) return { bar, tone: "ending", icon: "clock", state: `Locks in ${minutesLeft(s)} min`, host, detail: how, time: `Locks at ${clock(s.settings.armedUntil).replace(/\s/g, " ")}. ${paired ? "Reset to keep Claude working." : "Reset if you need longer."}`, note: pairing };
  return { bar, tone: "open", icon: read ? "eye" : "open", state: what, host, detail: how, time: until, note: pairing };
}

/** The one or two buttons that matter in this state. */
function actions(s: Status): { primary?: Act; secondary?: Act } {
  const site = s.site;
  const host = site?.host ?? "";
  const always = s.settings.alwaysOn;
  const stopTitle = "Locks every site at once. Your allowed sites stay on the list.";
  const stop: Act = { label: "Stop now", type: "disarm", icon: "stop", style: isWide(s) ? "danger" : "primary", title: stopTitle };
  const reset: Act | undefined = always ? undefined : { label: "Reset to 1 hour", type: "arm", icon: "clock", style: "plain" };
  const open: Act = { label: always ? "Open access until I press Stop" : "Open access for 1 hour", type: "arm", style: "primary" };
  if (site?.blocked) return s.armed ? { primary: { ...stop, style: "plain" } } : {};
  if (!s.armed) {
    // A long host doesn't fit the button: the card above names it in full.
    const name = host.length > 20 ? "this site" : host;
    if (site && !site.allowed) return { primary: { label: `Allow ${name} and open${always ? "" : " for 1 hour"}`, type: "allowSite", extra: { host, open: true }, style: "primary" } };
    return { primary: open };
  }
  if (site && !site.allowed) return { primary: { label: `Allow ${host.length > 20 ? "this site" : host}`, type: "allowSite", extra: { host, open: true }, style: "primary" }, secondary: { ...stop, style: "plain" } };
  // Stop keeps its place in every open state; near the end, Reset is marked amber instead of moving.
  return { primary: stop, secondary: reset && ending(s) ? { ...reset, style: "plain", warn: true } : reset };
}

function paintButton(id: string, a: Act | undefined) {
  const b = $<HTMLButtonElement>(id);
  b.hidden = !a;
  if (!a) return;
  b.className = `btn ${a.style ?? "plain"}${a.warn ? " warn" : ""}`;
  b.title = a.title ?? "";
  const label = document.createElement("span");
  label.textContent = a.label;
  if (!a.icon) return b.replaceChildren(label);
  const i = document.createElement("span");
  i.dataset.size = "16";
  setIcon(i, a.icon);
  b.replaceChildren(i, label);
}

function render(s: Status | null) {
  if (!s) return;
  key = s.key;
  $("cmd").textContent = command(s.key).trim();
  $("copy").setAttribute("aria-label", `Copy the command /browse ${s.key}`);

  const c = card(s);
  $("bar").dataset.tone = c.bar;
  $("status").dataset.tone = c.tone;
  setIcon($("sIcon"), c.icon);
  $("sState").textContent = c.state;
  show("sHostLine", !!c.host);
  $("sHost").textContent = hostText(c.host ?? "");
  text("sPill", c.pill);
  $("sPill").dataset.ok = String(!!c.pillOk);
  text("sDetail", c.detail);
  text("sTime", c.time);
  text("sNote", c.note);
  show("sLinks", !!c.links);
  show("lnkSites", s.settings.siteMode === "block");
  show("lnkTime", s.settings.alwaysOn);

  // The hour draining away along the card's bottom edge, while it applies to this page.
  const timed = s.armed && !s.settings.alwaysOn && (c.tone === "open" || c.tone === "ending");
  show("drain", timed);
  if (timed) $("drainFill").style.width = `${Math.max(2, Math.min(100, ((s.settings.armedUntil - Date.now()) / (ARM_MINUTES * 60_000)) * 100))}%`;

  const unset = !s.connected && !s.setupDone;
  const refused = !!s.refused && !s.connected;
  show("refusedBox", refused);
  show("setupActions", unset && !refused);
  show("main", !unset && !refused);
  paintUpdate(s);
  if (refused) paintRefused(s.refused!);
  if (unset || refused) return;

  // Read and act, or read only: chosen before granting.
  const site = s.site;
  for (const r of document.querySelectorAll<HTMLInputElement>("input[name=mode]")) r.checked = r.value === (s.settings.readOnly ? "read" : "act");
  show("modeWrap", !!site && !site.blocked);
  // The label says when the choice applies: now, or at the next opening.
  show("segLabel", !!site && !site.blocked);
  // Open: a short label beside the control. Locked: a longer one above it, saying when it applies.
  $("modeWrap").dataset.inline = String(s.armed && !segFlash);
  if (!segFlash) $("segLabel").textContent = s.armed ? "Claude may" : "When access opens, Claude may";

  const a = actions(s);
  acts = a;
  paintButton("primary", a.primary);
  paintButton("secondary", a.secondary);
  // Unblocking reverses an explicit choice: a quiet link that asks twice.
  blockedHost = site?.blocked ? (s.settings.block.find((e) => covers(e, site.host)) ?? site.host) : "";
  show("unblock", !!blockedHost);
  if (blockedHost && !unblockAsking()) $("unblock").textContent = `Unblock ${blockedHost}`;

  // More: the rarer changes, each saying what it does.
  const host = site?.host ?? "";
  const allowEntry = site ? s.settings.allow.find((e) => covers(e, host)) : undefined;
  show("rowSwitch", s.connected && s.armed);
  show("rowForget", !!allowEntry);
  if (allowEntry) $("forgetLabel").textContent = `Remove ${allowEntry} from allowed sites`;
  show("rowBlock", !!site && !site.blocked);
  if (site) $("blockLabel").textContent = `Block ${host}`;
  const anySite = (s.connected && s.armed) || !!allowEntry || (!!site && !site.blocked);
  show("rowsSite", anySite);

  // Semantic targeting lives in the bridge; this only asks the bridge to switch it.
  const needKey = !!s.jev && !s.jev.keyPresent;
  show("jevSetup", needKey);
  show("jevRow", !needKey);
  const jev = $<HTMLInputElement>("jev");
  jev.checked = !!s.jev?.on;
  jev.disabled = !s.jev || s.jev.envOverride;
  $("jevHint").textContent = s.jev?.on ? "On. Sends page outlines to TypeSafe." : "Off. When on, sends page outlines to TypeSafe.";
  const note = needKey ? null : jevNote(s);
  show("jevNote", !!note);
  setText($("jevNote"), note ?? "");
}

/** Refused by the bridge: the exact origin, a prompt for Claude Code, and the manual fix. */
function paintRefused(origin: string) {
  if (origin === refusedOrigin) return;
  refusedOrigin = origin;
  $("refOrigin").textContent = origin;
  setText($("refAlt"), `Or by hand: add it to "extensions" in \`${CONFIG_FILE}\`. The extension connects again by itself.`);
}

/** The extension and the bridge update separately; say so when they disagree, with the fix as one action. */
function paintUpdate(s: Status) {
  const mismatch = s.connected && s.hubVersion !== null && s.hubVersion !== s.version;
  show("update", mismatch);
  if (!mismatch) return;
  const extOld = newer(s.hubVersion!, s.version);
  updateFix = !extOld ? "prompt" : s.firefox ? "check" : "reload";
  bridgeDir = s.bridgeDir;
  $("updText").textContent = extOld
    ? `This extension (v${s.version}) is older than the bridge (v${s.hubVersion}). Some actions may fail until it updates.`
    : `The bridge (v${s.hubVersion}) is older than this extension (v${s.version}). Some actions may fail until it updates.`;
  $("updAct").textContent = updateFix === "prompt" ? "Copy update prompt for Claude Code" : updateFix === "check" ? "Update now" : "Reload extension";
  const alt = updateFix === "prompt" ? "Or run in a terminal:" : updateFix === "check" ? "Or in about:addons: gear menu, Check for Updates." : "";
  show("updAlt", !!alt);
  setText($("updAlt"), alt);
  show("updCmd", updateFix === "prompt");
  $("updCmd").textContent = s.bridgeDir ? `cd ${s.bridgeDir} && ${UPDATE_CMD}` : UPDATE_CMD;
  $("updCmd").title = $("updCmd").textContent;
}

/** True when dotted version a is newer than b. */
function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

const act = (type: string, extra: Record<string, unknown> = {}) => send(type, extra).then(render);

/** A link that asks for a second click within four seconds before it acts. Returns "is it asking now?". */
function twoStep(id: string, ask: () => string, rest: () => string, run: () => Promise<unknown>): () => boolean {
  let armed = 0;
  $(id).addEventListener("click", async () => {
    if (Date.now() - armed > 4000) {
      armed = Date.now();
      $(id).textContent = ask();
      $(id).dataset.asking = "";
      setTimeout(() => { if (armed && Date.now() - armed >= 4000) { armed = 0; $(id).textContent = rest(); delete $(id).dataset.asking; } }, 4100);
      return;
    }
    armed = 0;
    delete $(id).dataset.asking;
    $(id).textContent = rest();
    await run();
  });
  return () => armed > 0 && Date.now() - armed < 4000;
}

$("primary").addEventListener("click", () => acts.primary && act(acts.primary.type, acts.primary.extra));
$("secondary").addEventListener("click", () => acts.secondary && act(acts.secondary.type, acts.secondary.extra));
// Switching mode while open takes effect at once: say so in the label for two seconds.
let segFlash = 0;
for (const r of document.querySelectorAll<HTMLInputElement>("input[name=mode]")) {
  r.addEventListener("change", async () => {
    if (!r.checked) return;
    await act("setReadOnly", { value: r.value === "read" });
    clearTimeout(segFlash);
    $("modeWrap").dataset.inline = "false";
    $("segLabel").textContent = r.value === "read" ? "Now read only. Applies to Claude's next action." : "Now read and act. Applies to Claude's next action.";
    segFlash = window.setTimeout(() => { segFlash = 0; refresh(); }, 2200);
  });
}

$("copy").addEventListener("click", async () => {
  if (!key) return;
  await copyWithFeedback($("copyLabel"), command(key));
  setIcon($("copyIcon"), "open");
  setTimeout(() => setIcon($("copyIcon"), "copy"), 1600);
});

// New key cuts off running sessions: it asks first, in words. Unblocking reverses an explicit choice: it asks twice.
$("regen").addEventListener("click", () => { show("regenAsk", true); $("regenNo").focus(); });
$("regenNo").addEventListener("click", () => { show("regenAsk", false); $("regen").focus(); });
$("regenYes").addEventListener("click", async () => { show("regenAsk", false); await act("regenerate"); $("regen").textContent = "New key set"; setTimeout(() => { $("regen").textContent = "New key"; }, 2000); });
const unblockAsking = twoStep("unblock", () => `Click again to unblock ${blockedHost}`, () => `Unblock ${blockedHost}`, () => act("allowSite", { host: blockedHost, open: false }));

$("unlock").addEventListener("click", async () => { await act("unlockSite"); $("unlockLabel").textContent = "Done: this session can switch once"; });
$("forget").addEventListener("click", () => { const h = $("forgetLabel").textContent?.match(/^Remove (\S+)/)?.[1]; if (h) act("forgetSite", { host: h }); });
$("blockSite").addEventListener("click", () => { const h = $("blockLabel").textContent?.replace(/^Block /, ""); if (h) act("blockSite", { host: h }); });

// Element picker: starts on the page, so the popup closes to get out of the way.
$("pick").addEventListener("click", async () => { await send("startPick"); window.close(); });

$("jev").addEventListener("change", (e) => act("setJev", { value: (e.target as HTMLInputElement).checked }));

// The last picked selector, kept so it can be copied into a filter later.
async function showLastPick() {
  const { lastPick } = await ext.storage.local.get("lastPick");
  if (!lastPick?.selector) return;
  const code = document.createElement("code");
  code.className = "mono";
  code.textContent = lastPick.selector;
  $("picked").replaceChildren("Last picked: ", code, ` (${lastPick.matchCount} on the page)`);
  show("rowPicked", true);
}

// Update: paste-ready prompt for Claude Code; for an older extension, update or reload it in place.
$("refCopy").addEventListener("click", () => { if (refusedOrigin) copyWithFeedback($("refCopyLabel"), trustPrompt(refusedOrigin), "Copied. Paste it into Claude Code"); });

$("updAct").addEventListener("click", async () => {
  if (updateFix === "prompt") return copyWithFeedback($("updAct"), updatePrompt(bridgeDir), "Copied. Paste it into Claude Code");
  if (updateFix === "reload") return ext.runtime.reload();
  $("updAct").textContent = "Checking…";
  try {
    const check = (ext.runtime as any).requestUpdateCheck;
    if (typeof check !== "function") throw new Error("not supported");
    // Chrome resolves to {status}, Firefox to [status, details].
    const r = await check();
    const status = Array.isArray(r) ? r[0] : r?.status ?? r;
    if (status === "update_available") { ext.runtime.reload(); return; }
    $("updAct").textContent = status === "throttled" ? "Try again in a minute" : "No update yet";
  } catch { $("updAct").textContent = "Use about:addons"; }
});

// Settings and the setup guide open as tabs (runtime.openOptionsPage can fail silently when the popup closes).
const openPage = async (page: string) => { await ext.tabs.create({ url: ext.runtime.getURL(page) }); window.close(); };
$("settings").addEventListener("click", () => openPage("options.html"));
$("jevSetup").addEventListener("click", () => openPage("options.html#jev"));
for (const b of document.querySelectorAll<HTMLElement>("[data-goto]")) b.addEventListener("click", () => openPage(`options.html#${b.dataset.goto}`));
$("finish").addEventListener("click", () => openPage("welcome.html"));

drawIcons();
const refresh = () => getStatus().then(render);
refresh();
showLastPick();
setInterval(refresh, 1500);
