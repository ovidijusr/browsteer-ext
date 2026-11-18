// Setup guide, opened once after install (and from the popup's "Finish setup").
// One step per screen, with a picture of the step beside it. Steps 1 and 2 move
// on by themselves when the bridge connects and when a site is allowed; a step
// that is already done is skipped. Step 3 ends when Claude pairs (or on Skip), which records that setup is
// finished, so nothing opens this page again by itself.
import { ext } from "./ext";
import { drawIcons, setIcon } from "./icons";
import { command, copyWithFeedback, getStatus, send, setText, type Status } from "./keyview";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let step = 0;
let skipped = false;
const openedAt = Date.now();
// How long a step waits before it offers help. The UI harness shortens it to show the state.
const PATIENCE = (globalThis as any).__browsteerPatienceMs ?? 90_000;
let key = "";

let stepStarted = Date.now();
function show(next: number) {
  if (next === step) return;
  const first = step === 0;
  step = next;
  stepStarted = Date.now();
  for (let i = 1; i <= 4; i++) $(`s${i}`).hidden = i !== step;
  for (const f of document.querySelectorAll<HTMLElement>("[data-fig]")) f.hidden = f.dataset.fig !== String(step);
  for (const li of document.querySelectorAll<HTMLElement>("#nav li")) {
    const n = Number(li.dataset.step);
    li.dataset.state = n < step ? "done" : n === step ? "now" : "next";
    if (n === step) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    li.querySelector(".n")!.textContent = n < step ? "✓" : String(n);
  }
  $("nav").hidden = step === 4;
  document.title = step === 4 ? "Browsteer is ready" : `Set up Browsteer: step ${step} of 3`;
  // Move focus to the new screen's heading, so a screen reader announces it.
  if (!first) {
    const h = $(`h${step}`);
    h.tabIndex = -1;
    h.focus();
  }
}

function render(s: Status | null) {
  if (!s) return;
  key = s.key;
  $("cmdBrowse").textContent = command(s.key).trim();
  $("figKey").textContent = s.key;
  if (step === 0 && s.setupDone) return show(4);
  if (step === 4) return;
  // Step 3 is done when a Claude Code session pairs with this browser after the page opened.
  if (step === 3 && s.pairedAt > openedAt) { send("finishSetup"); $("live").textContent = "Claude paired with this browser. Next time:"; return show(4); }
  // Taking long: say so, and offer the usual fixes.
  const late = Date.now() - stepStarted > PATIENCE;
  if (step === 1 && late) { lateLine(1, "Still waiting. Check that Claude Code finished running `bun run setup`, and keep this tab open."); $("stuck1").hidden = false; }
  if (step === 3 && late) lateLine(3, "No pairing yet. Check that you pasted the whole line, bst-… included. If Claude Code says /browse is unknown, start a new Claude Code session: setup added the command.");
  const allowed = s.armed && (s.settings.siteMode === "block" || s.settings.allow.length > 0);
  const due = !s.connected ? 1 : !(allowed || skipped) ? 2 : 3;
  // Forward only: a bridge that drops for a moment does not send the person back.
  show(Math.max(step, due));
}

/** A waiting line that has waited too long: amber, a clock instead of the spinner. */
function lateLine(n: number, text: string) {
  const line = $(`wait${n}`);
  if (line.dataset.late !== undefined) return;
  line.dataset.late = "";
  const clockIcon = document.createElement("span");
  setIcon(clockIcon, "clock");
  $(`spin${n}`).replaceWith(clockIcon);
  setText($(`wait${n}Text`), text);
}

/** Copy, and say so on the button's label for two seconds. */
function copyButton(btn: HTMLElement, text: () => string) {
  const label = btn.querySelector("span:last-child") as HTMLElement;
  btn.addEventListener("click", () => copyWithFeedback(label, text(), "Copied"));
}
for (const btn of document.querySelectorAll<HTMLElement>("[data-copy]")) copyButton(btn, () => $(btn.dataset.copy!).textContent ?? "");
copyButton($("copyKey"), () => command(key));
$("copyKey").addEventListener("click", () => { setIcon($("copyKeyIcon"), "open"); setTimeout(() => setIcon($("copyKeyIcon"), "copy"), 1600); });

$("skip").addEventListener("click", () => { skipped = true; show(3); });

$("done").addEventListener("click", async () => {
  await send("finishSetup");
  show(4);
});

$("close").addEventListener("click", async () => {
  try { const tab = await ext.tabs.getCurrent(); if (tab?.id != null) await ext.tabs.remove(tab.id); } catch {}
  window.close();
});

drawIcons();
const refresh = () => getStatus().then(render);
refresh();
setInterval(refresh, 1500);
