// Setup page, opened once after install and from the popup. It shows the live
// key and bridge state so the steps tick themselves off as they happen.
import { ext } from "./ext";
import { command, copyWithFeedback, getStatus, renderKey, renderLink } from "./keyview";

const $ = (id: string) => document.getElementById(id)!;
let key = "";

async function refresh() {
  const s = await getStatus();
  if (!s) return;
  key = s.key;
  renderKey($("key"), s.key);
  renderLink($("link"), $("linkText"), s.connected,
    "Bridge not running yet.", "Follow the steps below; this page updates by itself.");
  $("cmd-browse").textContent = `${command(s.key)}summarise the page I have open`;
  // Finding the bridge proves the first two steps happened.
  $("step-bridge").dataset.done = String(s.connected);
  $("step-start").dataset.done = String(s.connected);
}

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

refresh();
setInterval(refresh, 1500);
