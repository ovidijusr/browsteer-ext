// The last check before the content script activates something.
//
// browser_click and browser_press are the ways to activate a control without a
// second opinion, so controls that sound like a commitment need the caller to
// state that the user agreed (confirm: true). The words are in ./risk.ts. A real
// control with no name at all is treated the same way: an icon-only trash button
// says nothing about what it does.
//
// DOM-in, throw-or-return, no extension APIs: unit-tested in test/guard.test.ts.
import { accessibleName, roleOf, clean } from "./snapshot";
import { needsGuard } from "./risk";

const CONTROL_SEL = "a[href], button, input[type=submit], input[type=button], input[type=image], input[type=reset], [role=button], [role=link], [role=menuitem], [role=tab]";
const SUBMIT_SEL = "button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]";

/** The control an element belongs to, climbing out of shadow roots; null for plain content. */
export function closestControl(el: Element): Element | null {
  for (let cur: Element | null = el; cur; ) {
    const hit = cur.closest(CONTROL_SEL);
    if (hit) return hit;
    const root = cur.getRootNode() as ShadowRoot | Document;
    cur = "host" in root ? root.host : null;
  }
  return null;
}

/** Why this element must not be activated without the user's yes, or null when it is fine. */
export function guardReason(el: Element | null): string | null {
  if (!el) return null;
  const control = closestControl(el);
  const subject = control ?? el;
  const name = accessibleName(subject) || clean(subject.textContent).slice(0, 60);
  // A real control goes through the full rule (weak words, namelessness). Plain
  // content — a div someone made clickable — is only stopped by a strong word.
  const risky = control ? needsGuard({ role: roleOf(control), name }) : !!name && needsGuard({ role: "link", name });
  if (!risky) return null;
  return name ? `“${name}” sounds like an action that cannot be undone` : "An unnamed button could be an action that cannot be undone";
}

export function guardClick(el: Element | null, confirm: boolean, how = "browser_click({ ref, confirm: true })"): void {
  if (confirm) return;
  const why = guardReason(el);
  if (why) throw new Error(`${why}, so it was not activated. Ask the user; if they agree, repeat with ${how}.`);
}

/** Enter and Space activate things: the focused control, or (Enter) the form the field is in. */
export function guardPress(el: Element, key: string, confirm: boolean): void {
  if (key !== "Enter" && key !== " " && key !== "Space") return;
  const how = "browser_press({ key, ref, confirm: true })";
  if (closestControl(el)) return guardClick(el, confirm, how);
  const form = key === "Enter" && el.tagName === "INPUT" ? (el as HTMLInputElement).form : null;
  const submit = form?.querySelector(SUBMIT_SEL);
  if (submit) guardClick(submit, confirm, how);
}
