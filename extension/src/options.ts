// Settings page (the extension's options page): how long access lasts, where
// Claude can work, and semantic targeting (Jev) with its API key. Opened from
// the popup. The two wide choices are off by default, say their risk before they
// are picked, and ask for a confirmation; they stay available for people who want them.
import { ext } from "./ext";
import { drawIcons } from "./icons";
import { UPDATE_CMD, getStatus, send, setText, updatePrompt, type Status } from "./keyview";
import { hostOf } from "./policy";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const radios = (name: string) => [...document.querySelectorAll<HTMLInputElement>(`input[name=${name}]`)];
let drawn = "";
let replacing = false;
let last: Status | null = null;

/** Send a change, show "Saved", redraw. */
async function save(type: string, extra: Record<string, unknown> = {}) {
  const s = await send(type, extra);
  if (s) { const el = $("saved"); el.classList.add("on"); setTimeout(() => el.classList.remove("on"), 1600); }
  render(s);
}

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

/** Three states: nothing to set yet, a key to add, or the switch. */
function renderJev(s: Status) {
  const off = !s.connected ? "Start the bridge first: run /browse in Claude Code, then come back here."
    : !s.jev ? `The bridge is too old for this. Ask Claude Code: “${updatePrompt(s.bridgeDir)}” Or run \`${UPDATE_CMD}\` there yourself.`
    : null;
  $("jevOff").hidden = !off;
  if (off) setText($("jevOff"), off);
  const needKey = !off && (!s.jev!.keyPresent || replacing);
  const setup = $("jevSetup");
  if (setup.hidden === needKey) { setup.hidden = !needKey; if (needKey && replacing) $("jevKey").focus(); }
  $("keyCancel").hidden = !replacing;
  $("jevReady").hidden = !!off || needKey;
  if (off || needKey) return;
  const sw = $<HTMLInputElement>("jevSwitch");
  sw.checked = s.jev!.on;
  sw.disabled = s.jev!.envOverride;
  setText($("jevNote"), s.jev!.envOverride ? "Fixed by `BROWSTEER_JEV` where the bridge runs" : "Key saved in `~/.config/typesafe/env`");
}

// Safe choices apply at once; dangerous ones ask first.
function guarded(name: string, danger: string, confirmId: string, yesId: string, apply: (v: string) => Promise<void>) {
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

// The key goes to the bridge, which writes it to ~/.config/typesafe/env. The field is cleared at once.
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
  await save("setJevKey", { key });
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
  await save("removeJevKey");
});
$("jevSwitch").addEventListener("change", (e) => save("setJev", { value: (e.target as HTMLInputElement).checked }));

$("ver").textContent = `v${ext.runtime.getManifest().version}`;

drawIcons();
const refresh = () => getStatus().then(render);
refresh();
setInterval(refresh, 1500);
