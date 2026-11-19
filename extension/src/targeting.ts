// Semantic targeting provider, as the bridge reports it, and the words the
// Settings page and popup use for it. The bridge owns the setting; these pages
// only ask for a change. Keys never come back from the bridge.

export type ChoiceId = "typesafe" | "nexos" | "openrouter" | "ollama" | "custom";
export type PresetId = Exclude<ChoiceId, "typesafe">;

/** What the bridge says about the provider (bridge/targeting.ts TargetingInfo). */
export type TargetingInfo = {
  provider: "typesafe" | "openai";
  preset: PresetId;
  label: string;
  baseUrl: string;
  /** Where page outlines go, e.g. "api.nexos.ai" or "127.0.0.1:11434". */
  host: string;
  /** That host is this computer. */
  local: boolean;
  model: string;
  keyNeeded: boolean;
  /** Probabilities are real (Jev, or token logprobs); null until the model has answered once. */
  calibrated: boolean | null;
};

export interface Choice {
  id: ChoiceId;
  label: string;
  /** Filled in for every choice but Custom. */
  baseUrl: string;
  /** Where to make a key, when there is a page for it. */
  keyUrl?: string;
  keyWhere?: string;
}
export const CHOICES: Choice[] = [
  { id: "typesafe", label: "TypeSafe Jev", baseUrl: "https://api.typesafe.ai", keyUrl: "https://console.typesafe.ai/keys", keyWhere: "console.typesafe.ai/keys" },
  { id: "nexos", label: "nexos.ai", baseUrl: "https://api.nexos.ai/v1", keyWhere: "your nexos.ai workspace, under API keys" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/keys", keyWhere: "openrouter.ai/keys" },
  { id: "ollama", label: "Local (Ollama)", baseUrl: "http://127.0.0.1:11434/v1" },
  { id: "custom", label: "Custom", baseUrl: "" },
];
export const choiceById = (id: string) => CHOICES.find((c) => c.id === id) ?? CHOICES[0];
const PRESETS = ["nexos", "openrouter", "ollama", "custom"] as const;
const isPreset = (x: unknown): x is PresetId => typeof x === "string" && (PRESETS as readonly string[]).includes(x);
export const MODEL_RE = /^[\w.:/@+-]{1,200}$/;

/** Only the fields we know, with the types we expect; anything else → null. */
export function readTargeting(v: any): TargetingInfo | null {
  if (!v || typeof v !== "object" || (v.provider !== "typesafe" && v.provider !== "openai")) return null;
  const str = (x: unknown) => (typeof x === "string" ? x.slice(0, 500) : "");
  return {
    provider: v.provider,
    preset: isPreset(v.preset) ? v.preset : "nexos",
    label: str(v.label) || (v.provider === "typesafe" ? "TypeSafe Jev" : "Custom"),
    baseUrl: str(v.baseUrl),
    host: str(v.host),
    local: v.local === true,
    model: str(v.model),
    keyNeeded: v.keyNeeded !== false,
    calibrated: typeof v.calibrated === "boolean" ? v.calibrated : null,
  };
}

/** The picker's value for what the bridge has. Bridges before providers report none: TypeSafe. */
export const choiceOf = (t: TargetingInfo | null | undefined): ChoiceId => (!t || t.provider === "typesafe" ? "typesafe" : t.preset);

/** Where page outlines go, in one sentence (`backticks` become code). */
export function privacyText(t: TargetingInfo | null | undefined): string {
  if (!t || t.provider === "typesafe") return "While it's on, each lookup sends the page address, title, control names and visible text to `api.typesafe.ai`. Password values never leave this computer.";
  if (!t.host) return "Set the API address first. Nothing is sent until then.";
  if (t.local) return `Lookups go to \`${t.host}\` on this computer, so page outlines stay here. Password values are never sent.`;
  return `While it's on, each lookup sends the page address, title, control names and visible text to \`${t.host}\`. Password values never leave this computer.`;
}

/** The popup's one line under "Find controls by description". */
export function popupHint(on: boolean, t: TargetingInfo | null | undefined): string {
  const where = !t || t.provider === "typesafe" ? "TypeSafe" : t.local ? null : t.label;
  if (where == null) return on ? `On. Runs on this computer (${t!.label.replace(/^Local \((.*)\)$/, "$1")}).` : "Off. When on, runs on this computer.";
  return on ? `On. Sends page outlines to ${where}.` : `Off. When on, sends page outlines to ${where}.`;
}
/** The popup's setup button when there is no key yet. */
export function popupSetup(t: TargetingInfo | null | undefined): string {
  if (!t || t.provider === "typesafe") return "Off. Add a TypeSafe key in Settings →";
  if (!t.host) return "Off. Finish setting it up in Settings →";
  return `Off. Add a ${t.label} key in Settings →`;
}

/** A line about calibration for the Settings page. */
export function calibrationText(t: TargetingInfo | null | undefined): string {
  if (!t || t.calibrated == null) return "Run Test to see whether this model gives calibrated answers.";
  return t.calibrated
    ? "Calibrated: the percentages Claude sees come from the model's own token probabilities."
    : "Uncalibrated: this model can't report token probabilities, so it rates itself. Claude gets a shortlist instead of a click unless the model is very sure.";
}

/**
 * The provider messages a Settings page may send, cleaned for the bridge. Null =
 * not one of them, or malformed. The bridge checks everything again; this keeps
 * odd values from ever reaching the socket.
 */
export function hubMessage(msg: any): Record<string, unknown> | null {
  switch (msg?.type) {
    case "setTargeting": {
      if (msg.choice === "typesafe") return { type: "setTargeting", provider: "typesafe" };
      if (!isPreset(msg.choice)) return null;
      const out: Record<string, unknown> = { type: "setTargeting", provider: "openai", preset: msg.choice };
      if (msg.choice === "custom" && typeof msg.baseUrl === "string") out.baseUrl = msg.baseUrl.trim().slice(0, 500);
      if (typeof msg.model === "string") { if (msg.model && !MODEL_RE.test(msg.model)) return null; out.model = msg.model; }
      return out;
    }
    case "setTargetingKey": {
      const key = typeof msg.key === "string" ? msg.key.trim() : "";
      return /^[!-~]{8,512}$/.test(key) ? { type: "setTargetingKey", key } : null;
    }
    case "removeTargetingKey": case "listModels": case "testTargeting": return { type: msg.type };
  }
  return null;
}

/** What the bridge answers each message with, and how long to wait for it. */
export const REPLY: Record<string, { type: string; ms: number }> = {
  setTargeting: { type: "jev", ms: 1500 },
  setTargetingKey: { type: "jev", ms: 1500 },
  removeTargetingKey: { type: "jev", ms: 1500 },
  listModels: { type: "models", ms: 12_000 },
  testTargeting: { type: "targetingTest", ms: 120_000 },
};

/** The answer to Test, as the Settings page shows it. */
export type TestResult = {
  ok: boolean;
  error?: string;
  provider?: string;
  model?: string;
  calibrated?: boolean;
  rows?: { target: string; ok: boolean; correct: boolean; ms: number; p: number; picked: string }[];
};
