// The pairing key and bridge lamp, shared by the popup and the setup page.
import { ext } from "./ext";

export type Status = { key: string; connected: boolean };

export async function getStatus(): Promise<Status | null> {
  try { return (await ext.runtime.sendMessage({ type: "getStatus" })) as Status; }
  catch { return null; } // background is restarting; the next poll gets it
}

/** Render `bst-ab12-cd34` as three groups so it can be read aloud and checked at a glance. */
export function renderKey(el: HTMLElement, key: string): void {
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.replaceChildren(...key.split("-").map((part) => {
    const s = document.createElement("span");
    s.textContent = part;
    return s;
  }));
  el.setAttribute("aria-label", `Pairing key ${key}. Copy the /browse command.`);
}

/** Lamp + one sentence: a bold state, then what it means for the person. */
export function renderLink(el: HTMLElement, text: HTMLElement, connected: boolean, offState: string, offHint: string): void {
  const state = connected ? "on" : "off";
  if (el.dataset.state === state) return;
  el.dataset.state = state;
  const strong = document.createElement("strong");
  strong.textContent = connected ? "Bridge connected." : offState;
  text.replaceChildren(strong, connected ? " Claude Code can pair with this key." : ` ${offHint}`);
}

export const command = (key: string) => `/browse ${key} `;

/** Copy text and confirm on the button that was pressed, then restore its label. */
export async function copyWithFeedback(btn: HTMLElement, text: string, done = "Copied"): Promise<void> {
  await navigator.clipboard.writeText(text);
  const label = btn.dataset.label ?? btn.textContent ?? "";
  btn.dataset.label = label;
  btn.textContent = done;
  setTimeout(() => { btn.textContent = label; }, 1400);
}
