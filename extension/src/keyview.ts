// The pairing key and bridge lamp, shared by the popup and the setup page.
import { ext } from "./ext";

import type { Settings } from "./policy";

export type Status = {
  key: string;
  connected: boolean;
  /** This extension's version and the bridge's (null until the bridge reports it; bridges before 2.0.0 never do). */
  version: string;
  hubVersion: string | null;
  settings: Settings;
  armed: boolean;
  /** The site in the active tab, if it is a web page. */
  site: { host: string; allowed: boolean; blocked: boolean } | null;
};

/** Send a command to the background; every command answers with the new status. */
export async function send(type: string, extra: Record<string, unknown> = {}): Promise<Status | null> {
  try { return (await ext.runtime.sendMessage({ type, ...extra })) as Status; }
  catch { return null; }
}

/** "14:32" in the person's locale. */
export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const getStatus = () => send("getStatus");

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
