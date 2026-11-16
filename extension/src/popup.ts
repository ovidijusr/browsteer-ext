// Popup: the pairing key, whether Claude may work in this browser right now and
// on this site, and the switches that limit what it can do. Every control here
// changes settings that only the person can change; the bridge cannot.
import { ext } from "./ext";
import { clock, command, copyWithFeedback, getStatus, renderKey, renderLink, send, type Status } from "./keyview";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let key = "";
let host = "";

function render(s: Status | null) {
  if (!s) return;
  key = s.key;
  renderKey($("key"), s.key);
  renderLink($("link"), $("linkText"), s.connected,
    "Bridge not running.", "It starts with Claude Code; this reconnects by itself.");

  // Access: locked by default, open for an hour at a time.
  $("access").dataset.armed = String(s.armed);
  $("accessText").textContent = s.armed
    ? `Claude can use this browser until ${clock(s.settings.armedUntil)}.`
    : "Claude cannot use this browser.";
  $("arm").textContent = s.armed ? "Add 1 hour" : "Allow Claude for 1 hour";
  $("arm").classList.toggle("primary", !s.armed);
  $("disarm").hidden = !s.armed;

  // This site.
  $("site").hidden = !s.site;
  if (s.site) {
    host = s.site.host;
    $("siteHost").textContent = host;
    $("siteState").textContent = s.site.blocked ? "is blocked." : s.site.allowed ? "is allowed." : "is not allowed yet.";
    $("siteAllow").textContent = s.site.allowed ? "Remove" : `Allow ${host}`;
    $("siteAllow").classList.toggle("primary", s.armed && !s.site.allowed && !s.site.blocked);
    $("siteAllow").dataset.action = s.site.allowed ? "forgetSite" : "allowSite";
    $("siteBlock").hidden = s.site.blocked;
  }
  $<HTMLInputElement>("readOnly").checked = s.settings.readOnly;
}

const act = (type: string, extra: Record<string, unknown> = {}) => send(type, extra).then(render);

$("arm").addEventListener("click", () => act("arm"));
$("disarm").addEventListener("click", () => act("disarm"));
$("siteAllow").addEventListener("click", () => host && act($("siteAllow").dataset.action!, { host }));
$("siteBlock").addEventListener("click", () => host && act("blockSite", { host }));
$("readOnly").addEventListener("change", (e) => act("setReadOnly", { value: (e.target as HTMLInputElement).checked }));

$("unlock").addEventListener("click", async () => {
  await act("unlockSite");
  const b = $("unlock");
  b.textContent = "Claude can move to another site";
  setTimeout(() => { b.textContent = "Let Claude switch site"; }, 1800);
});

// Copies "/browse <key> " with a trailing space, ready for the task to be typed after it.
$("copy").addEventListener("click", () => key && copyWithFeedback($("copy"), command(key)));
$("key").addEventListener("click", () => key && copyWithFeedback($("copy"), command(key)));

$("regen").addEventListener("click", async () => {
  await act("regenerate");
  const btn = $("regen");
  btn.textContent = "New key set";
  setTimeout(() => { btn.textContent = "New key"; }, 1400);
});

// Element picker: starts on the page, so the popup closes to get out of the way.
$("pick").addEventListener("click", async () => {
  await send("startPick");
  window.close();
});

// The last picked selector, kept so it can be copied into a filter later.
async function showLastPick() {
  const { lastPick } = await ext.storage.local.get("lastPick");
  if (!lastPick?.selector) return;
  const el = $("picked");
  const code = document.createElement("code");
  code.textContent = lastPick.selector;
  el.replaceChildren("Last picked: ", code, ` (${lastPick.matchCount} on the page)`);
  el.hidden = false;
}

$("ver").textContent = `v${ext.runtime.getManifest().version}`;

const refresh = () => getStatus().then(render);
refresh();
showLastPick();
setInterval(refresh, 1500);
