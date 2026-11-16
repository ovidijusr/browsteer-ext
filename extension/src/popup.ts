// Popup: this browser's pairing key, whether the local bridge is connected, and
// the two things people do here — copy the /browse command and pick an element.
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
    "Bridge not running.", "It starts with Claude Code; this reconnects by itself.");
}

// Copies "/browse <key> " with a trailing space, ready for the task to be typed after it.
$("copy").addEventListener("click", () => key && copyWithFeedback($("copy"), command(key)));
$("key").addEventListener("click", () => key && copyWithFeedback($("copy"), command(key)));

$("regen").addEventListener("click", async () => {
  const r = (await ext.runtime.sendMessage({ type: "regenerate" })) as { key: string };
  key = r.key;
  renderKey($("key"), r.key);
  const btn = $("regen");
  btn.textContent = "New key set";
  setTimeout(() => { btn.textContent = "New key"; }, 1400);
});

// Element picker: starts on the page, so the popup closes to get out of the way.
$("pick").addEventListener("click", async () => {
  await ext.runtime.sendMessage({ type: "startPick" });
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

refresh();
showLastPick();
setInterval(refresh, 1500);
