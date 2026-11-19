// What the popup and the setup page share: the status the background reports,
// the message helper, and the /browse command.
import { ext } from "./ext";

import type { Settings } from "./policy";
import type { TargetingInfo } from "./targeting";

/** Semantic targeting, as the bridge reports it. Never carries the API key itself. */
export type JevState = {
  /** Page outlines go to the provider on find/pursue. */
  on: boolean;
  /** The bridge has a key for the provider (or the provider is on this computer and needs none). */
  keyPresent: boolean;
  /** BROWSTEER_JEV is set where the bridge runs, which overrides the saved setting. */
  envOverride: boolean;
  /** Which model answers (null from bridges before 2.1.0, which only know TypeSafe). */
  targeting: TargetingInfo | null;
};

export type Status = {
  key: string;
  connected: boolean;
  /** This extension's version and the bridge's (null until the bridge reports it; bridges before 2.0.0 never do). */
  version: string;
  hubVersion: string | null;
  /** The Browsteer folder on this computer (null until the bridge reports it; bridges before 2.1.0 never do). */
  bridgeDir: string | null;
  firefox: boolean;
  settings: Settings;
  armed: boolean;
  /** The site in the active tab, if it is a web page. */
  site: { host: string; allowed: boolean; blocked: boolean } | null;
  /** null while the bridge is not connected, or too old to report it. */
  jev: JevState | null;
  /** When a Claude Code session last paired with this browser (0 = never). */
  pairedAt: number;
  /** The bridge refused this extension: its origin (to add to "extensions" in config.json), else null. */
  refused: string | null;
  /** The setup guide was finished (or the extension was updated from an earlier version). */
  setupDone: boolean;
  /** The bridge's answer to the message just sent, when it has one (provider error, model list, test result). */
  reply?: { type: string; [k: string]: unknown };
};

/** Send a command to the background; every command answers with the new status. */
export async function send(type: string, extra: Record<string, unknown> = {}): Promise<Status | null> {
  try { return (await ext.runtime.sendMessage({ type, ...extra })) as Status; }
  catch { return null; }
}

/** "14:32" in the person's locale. */
export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** "47 min left · until 1:00 PM", or "No time limit" for access that lasts until Stop. Never wraps inside the time. */
export function untilText(s: Status, now = Date.now()): string {
  if (s.settings.alwaysOn) return "No time limit";
  const left = Math.max(1, Math.ceil((s.settings.armedUntil - now) / 60_000));
  // One unit that never wraps: "42 min left · until 1:25 AM".
  return `${left} min left · until ${clock(s.settings.armedUntil).replace(/\s/g, " ")}`;
}
/** "for 42 min (until 1:34 AM)", the time as part of a sentence. */
export function openFor(s: Status, now = Date.now()): string {
  if (s.settings.alwaysOn) return "until you press Stop";
  const left = Math.max(1, Math.ceil((s.settings.armedUntil - now) / 60_000));
  return `for ${left} min (until ${clock(s.settings.armedUntil).replace(/\s/g, " ")})`;
}
/** A hostname that wraps only after its dots, never at a hyphen. */
export const hostText = (h: string) => h.replace(/-/g, "‑").replace(/\./g, ".​");
/** Minutes until access locks itself (0 when locked or without a limit). */
export function minutesLeft(s: Status, now = Date.now()): number {
  return s.armed && !s.settings.alwaysOn ? Math.max(1, Math.ceil((s.settings.armedUntil - now) / 60_000)) : 0;
}

export const getStatus = () => send("getStatus");

export const command = (key: string) => `/browse ${key} `;

/** Copy text and confirm on the element that shows the label, then restore it. */
export async function copyWithFeedback(label: HTMLElement, text: string, done = "Copied"): Promise<void> {
  await navigator.clipboard.writeText(text);
  const was = label.dataset.label ?? label.textContent ?? "";
  label.dataset.label = was;
  label.textContent = done;
  // The button turns green with a check while it says Copied (CSS: [data-copied]).
  const btn = label.closest("button");
  btn?.setAttribute("data-copied", "");
  setTimeout(() => { label.textContent = was; btn?.removeAttribute("data-copied"); }, 1600);
}

// ── Updating ─────────────────────────────────────────────────────────────────
// First choice: a prompt to paste into Claude Code, which runs the update itself.
// Fallback: the command, for a terminal.
export const UPDATE_CMD = "bun run update";
export function updatePrompt(dir: string | null): string {
  return `Update Browsteer: run \`${UPDATE_CMD}\` in ${dir ?? "the Browsteer folder (the browsteer-ext git checkout)"}, then tell me what changed.`;
}

// ── A bridge that does not trust this extension yet ──────────────────────────
// Only the person can change that, in a file Claude cannot reach through the bridge.
export const CONFIG_FILE = "~/.browsteer/config.json";
export function trustPrompt(origin: string): string {
  return `The Browsteer bridge refuses my browser's extension. Add "${origin}" to the "extensions" list in ${CONFIG_FILE} (keep the entries already there). The bridge reads that list on every connection, so nothing needs restarting.`;
}

/** What the person should do about semantic targeting, or null when nothing needs doing. */
export function jevNote(s: Status): string | null {
  if (!s.connected) return "Needs the bridge running.";
  if (!s.jev) return "Bridge too old. Update it first.";
  if (s.jev.envOverride) return "Set by `BROWSTEER_JEV` where the bridge runs.";
  if (!s.jev.keyPresent) return "Needs an API key. Add it in Settings.";
  return null;
}

/** Set text, showing `backticked` parts as code. */
export function setText(el: HTMLElement, text: string): void {
  el.replaceChildren(...text.split(/`([^`]+)`/).map((part, i) => {
    if (i % 2 === 0) return part;
    const c = document.createElement("code");
    c.textContent = part;
    return c;
  }));
}
