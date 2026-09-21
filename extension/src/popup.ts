// Popup: shows this browser's pairing key + live connection status, with
// Copy and Regenerate. Talks to the background event page over runtime messaging.

const $ = (id: string) => document.getElementById(id)!;

async function refresh() {
  const r: any = await browser.runtime.sendMessage({ type: "getStatus" });
  $("key").textContent = r.key;
  $("hintKey").textContent = r.key;
  ($("dot") as HTMLElement).className = "dot " + (r.connected ? "on" : "off");
  $("statusText").textContent = r.connected ? "paired with Claude bridge" : "waiting for Claude bridge…";
}

// Copy the ready-to-paste slash command: "/browse <key> " (trailing space so you
// just type the task). Clicking the key itself does the same.
async function copyCommand() {
  const key = $("key").textContent ?? "";
  await navigator.clipboard.writeText(`/browse ${key} `);
  const btn = $("copy") as HTMLButtonElement;
  btn.textContent = "Copied /browse ✓";
  setTimeout(() => (btn.textContent = "Copy /browse command"), 1300);
}
$("copy").addEventListener("click", copyCommand);
$("key").addEventListener("click", copyCommand);
($("key") as HTMLElement).style.cursor = "pointer";
($("key") as HTMLElement).title = "Click to copy “/browse <key>”";

$("regen").addEventListener("click", async () => {
  const r: any = await browser.runtime.sendMessage({ type: "regenerate" });
  $("key").textContent = r.key;
  $("hintKey").textContent = r.key;
});

// Element picker: trigger on the page, then close the popup so the user can click.
$("pick").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "startPick" });
  window.close();
});

// Show the last picked selector (so you can copy it into a filter).
async function showLastPick() {
  const { lastPick } = await browser.storage.local.get("lastPick");
  if (lastPick?.selector) {
    $("lastpick").textContent = `last pick: ${lastPick.selector} · ${lastPick.matchCount}×`;
  }
}

// Version badge: tells you which build is loaded (dev reloads vs the signed xpi).
$("ver").textContent = `v${browser.runtime.getManifest().version}`;

refresh();
showLastPick();
setInterval(refresh, 1500);
