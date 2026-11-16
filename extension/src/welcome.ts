// Setup page, opened once after install and from the popup. It shows the live
// key and bridge state so the steps tick themselves off as they happen, and it
// is where the list of sites is managed.
import { ext } from "./ext";
import { command, copyWithFeedback, getStatus, renderKey, renderLink, send, type Status } from "./keyview";
import { hostOf } from "./policy";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let key = "";
let drawn = "";

function render(s: Status | null) {
  if (!s) return;
  key = s.key;
  renderKey($("key"), s.key);
  renderLink($("link"), $("linkText"), s.connected,
    "Bridge not running yet.", "Follow the steps below; this page updates by itself.");
  $("cmd-browse").textContent = `${command(s.key)}summarise the page I have open`;
  // Finding the bridge proves the first two steps happened.
  $("step-bridge").dataset.done = String(s.connected);
  $("step-start").dataset.done = String(s.connected);
  $("step-arm").dataset.done = String(s.armed && (s.settings.siteMode === "block" || s.settings.allow.length > 0));

  // Sites: redraw only when the list changed, so focus and hover are not lost every poll.
  const { siteMode, allow, block } = s.settings;
  const sig = JSON.stringify([siteMode, allow, block]);
  if (sig === drawn) return;
  drawn = sig;
  for (const r of document.querySelectorAll<HTMLInputElement>("input[name=mode]")) r.checked = r.value === siteMode;
  const rows = [...block.map((h) => [h, "Blocked"] as const), ...allow.map((h) => [h, "Allowed"] as const)]
    .sort((a, b) => a[0].localeCompare(b[0]));
  $("noSites").hidden = rows.length > 0;
  $("sites").replaceChildren(...rows.map(([host, state]) => {
    const li = document.createElement("li");
    const name = document.createElement("code");
    name.textContent = host;
    const tag = document.createElement("span");
    tag.textContent = state;
    tag.dataset.state = state.toLowerCase();
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "btn quiet";
    rm.textContent = "Remove";
    rm.setAttribute("aria-label", `Remove ${host}`);
    rm.addEventListener("click", () => send("forgetSite", { host }).then(render));
    li.append(name, tag, rm);
    return li;
  }));
}

for (const r of document.querySelectorAll<HTMLInputElement>("input[name=mode]")) {
  r.addEventListener("change", () => r.checked && send("setSiteMode", { value: r.value }).then(render));
}

// Accepts "example.com", "https://example.com/some/page" or "*.example.com".
$<HTMLFormElement>("addSite").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("newSite");
  const raw = input.value.trim().replace(/^\*\./, "");
  const host = hostOf(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!host || !host.includes(".")) { input.setCustomValidity("Enter a site address, like example.com"); input.reportValidity(); return; }
  const type = ((e as SubmitEvent).submitter as HTMLButtonElement | null)?.value ?? "allowSite";
  input.value = "";
  send(type, { host }).then(render);
});
$("newSite").addEventListener("input", () => $<HTMLInputElement>("newSite").setCustomValidity(""));

$("key").addEventListener("click", async () => {
  if (!key) return;
  await navigator.clipboard.writeText(command(key));
  $("linkText").textContent = "Copied the /browse command.";
  // Clearing the state makes the next refresh redraw the bridge line.
  setTimeout(() => { $("link").dataset.state = ""; refresh(); }, 1400);
});

for (const btn of document.querySelectorAll<HTMLElement>("[data-copy]")) {
  btn.addEventListener("click", () => copyWithFeedback(btn, $(btn.dataset.copy!).textContent ?? ""));
}

$("ver").textContent = `v${ext.runtime.getManifest().version}`;

const refresh = () => getStatus().then(render);
refresh();
setInterval(refresh, 1500);
