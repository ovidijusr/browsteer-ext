// Which controls sound like a commitment. Shared by the hub (bridge/jev.ts, to
// decide when to ask for a second opinion) and the content script (to refuse a
// direct click until the caller says the user confirmed it).
//
// English words are whole-word (`\bbook\b` does not fire on "Booking.com",
// `\bpost\b` not on "Posts"); Lithuanian entries stay stems because of inflection.
// STRONG words guard every role. WEAK words are commitments only on buttons
// ("Order" / "Post" / "Share" as a nav link is a section, not an action).
export const RISK_RE = /\b(buy|purchase|checkout|pay|payment|subscribe|unsubscribe|send|submit|confirm|approve|publish|delete|remove|erase|log ?out|sign ?out|transfer|donate)\b|(pirkti|užsakyti|apmok|mokė|prenumer|siųsti|siusti|patvirtin|ištrin|istrin|šalin|salin|atšauk|atsauk|atsijung|užsisak|rezervuo|paskelb|dalintis|atsakyti)/i;
export const RISK_WEAK_RE = /\b(order|post|reply|share|cancel|book|reserve)\b/i;

export function needsGuard(c: { role: string; name: string }): boolean {
  if (RISK_RE.test(c.name)) return true;
  if (c.role === "link") return false;
  return RISK_WEAK_RE.test(c.name) || c.name.trim().length < 2; // nameless controls stay guarded
}
