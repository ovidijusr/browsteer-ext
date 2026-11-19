// "What Claude did": the action log in plain words, for the Settings page.
//
// The hub answers the registered extension's {type:"activity"} with these items
// (never a controller's). Each one says when, in which browser, on which site
// (host and path; the query string and fragment are dropped, they often carry
// tokens), what happened in words a person reads, and whether it worked, was
// refused, or failed.
//
// Nothing typed is shown: fills are already logged as a length (redact in
// security.ts) and only that length is used. Values chosen in drop-downs, the
// goals given to pursue and the steps of `do` are left out too, since they can
// hold what the person would type. What a control is called on the page (its
// role and name) is shown, as Claude saw it.
import type { ActionRow } from "./db";

export type Outcome = "ok" | "refused" | "error";
export interface ActivityItem {
  id: number;
  ts: number;
  /** "edge", "firefox", … or null for rows logged before the log kept it. */
  browser: string | null;
  /** The browser asking is the one this action ran in. */
  thisBrowser: boolean;
  /** One id per Claude session (a controller connection); null for rows logged before that. */
  session: string | null;
  /** "example.com/account/settings", or null when the action had no page. */
  site: string | null;
  action: string;
  outcome: Outcome;
  /** Why it was refused or failed, short. */
  why: string | null;
}

export const ACTIVITY_LIMIT = { default: 300, max: 1000 };

/** Host and path, no credentials, query or fragment. */
export function siteText(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${path}`.slice(0, 200);
  } catch { return null; }
}

/** Any address inside free text, reduced the same way. */
const scrubUrls = (s: string) => s.replace(/https?:\/\/[^\s"'<>)]+/g, (m) => siteText(m.replace(/[.,;:]+$/, "")) ?? "a page");

const quote = (s: string, max = 70) => {
  const t = s.replace(/\s+/g, " ").trim();
  return `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”`;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "button “Save”" from what the content script reported about the element, or "". */
function element(detail: any): string {
  const el = detail?.el;
  if (!el || typeof el !== "object") return "";
  const role = typeof el.role === "string" && /^[a-z]{1,20}$/.test(el.role) ? el.role : "";
  const name = typeof el.name === "string" && el.name.trim() ? quote(el.name, 60) : "";
  return [role, name].filter(Boolean).join(" ");
}
const refPart = (ref: number | null, detail: any) => {
  const what = element(detail);
  return [ref != null ? `[${ref}]` : "", what].filter(Boolean).join(" ");
};
/** The length from a redacted value ("‹8 chars›"), or null. */
function typedLength(v: unknown): number | null {
  const m = /^‹(\d+) chars›$/.exec(String(v ?? ""));
  return m ? Number(m[1]) : null;
}
const chars = (n: number | null) => (n == null ? "" : ` (${plural(n, "character")})`);
/** Named keys are shown; a single character could be typed text, so it is not. */
function keyText(k: unknown): string {
  const s = String(k ?? "");
  const parts = s.split("+");
  const last = parts[parts.length - 1];
  if (last.length > 1 && /^[A-Za-z0-9+]{2,40}$/.test(s)) return s;
  if (parts.length > 1 && /^(Control|Ctrl|Alt|Shift|Meta|Cmd)$/i.test(parts[0])) return s.slice(0, 40);
  return "a key";
}

const parse = (s: string | null) => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };

/** The action in plain words. */
export function describe(r: ActionRow, detail = parse(r.detail)): string {
  const target = typeof r.value === "string" && r.value ? r.value : "";
  switch (r.tool) {
    case "snapshot": return r.value === "jev" ? "Read the page to find a control" : "Read the page";
    case "links": return r.ref != null ? `Listed the links in [${r.ref}]` : "Listed the links";
    case "form": return r.ref != null ? `Read the form in [${r.ref}]` : "Read the form";
    case "html": return r.ref != null ? `Read the HTML of [${r.ref}]` : "Read the page's HTML";
    case "read": return r.ref != null ? `Read the text of [${r.ref}]` : "Read the page's text";
    case "scan": return "Scanned the page for clickable spots";
    case "options": return `Listed the options in [${r.ref}]`;
    case "click": {
      if (r.ref == null) return r.value ? "Clicked a point on the page" : "Clicked";
      return `Clicked ${refPart(r.ref, detail)}`;
    }
    case "fill": {
      const where = refPart(r.ref, detail);
      const verb = detail?.how ? "Typed into" : "Filled";
      return `${verb} ${where || "a field"}${chars(typedLength(r.value))}`;
    }
    case "select": return `Chose an option in ${refPart(r.ref, detail) || "a list"}`;
    case "upload": {
      const n = target ? target.split(", ").length : 0;
      return n ? `Uploaded ${plural(n, "file")}` : "Uploaded a file";
    }
    case "navigate": return "Opened the page";
    case "press": return `Pressed ${keyText(r.value)}${r.ref != null ? ` in [${r.ref}]` : ""}`;
    case "pick": return "Asked you to pick an element";
    case "fetch": return "Fetched an address on the site";
    case "save_filter": return "Saved a page filter";
    case "delete_filter": return "Deleted a page filter";
    case "compare": return `Compared ${plural(r.element_count ?? 2, "browser")}`;
    case "do": return `Ran ${plural(r.element_count ?? 0, "step")}`;
    case "pursue": return `Worked toward a goal (${plural(r.element_count ?? 0, "step")})`;
    case "find": {
      const what = target.includes(" | ") ? `${target.split(" | ").length} controls` : quote(target);
      const outcome = String(detail?.outcome ?? "");
      if (outcome === "clicked") return `Found and clicked ${what}${r.ref != null ? ` [${r.ref}]` : ""}`;
      if (outcome === "filled") return `Found and filled ${what}${chars(typedLength(detail?.fillValue))}`;
      if (outcome.startsWith("refused")) return `Didn't click ${what}`;
      return `Looked for ${what}`;
    }
    default: return `Used ${r.tool.replace(/_/g, " ")}`;
  }
}

// Refusals are Browsteer's own limits doing their job; errors are everything else.
const REFUSALS: [RegExp, string][] = [
  [/^drift refused$|not the page you were working on/, "The tab had moved to another page"],
  [/^site lock$|This session is locked to/, "Outside the session's site"],
  [/Browsteer is locked/, "Access was locked"],
  [/read-only mode/, "Read only was on"],
  [/allowed list/, "The site isn't allowed"],
  [/blocked list/, "The site is blocked"],
  [/not a web page Browsteer|browser page that extensions cannot read/, "Not a web page"],
  [/confirm: ?true|sounds like a commitment|needs the user's/i, "Needs your OK first"],
  [/^jev off$/, "Find by description is off"],
];
const ERRORS: [RegExp, string][] = [
  [/timed out/i, "The page didn't answer in time"],
  [/No live element|page changed/, "The element was gone"],
  [/no longer connected|No browser connected/, "The browser wasn't connected"],
  [/^no match$/, "Nothing matched"],
];

export function outcomeOf(r: ActionRow, detail = parse(r.detail)): { outcome: Outcome; why: string | null } {
  const err = r.error ?? "";
  if (String(detail?.outcome ?? "").startsWith("refused")) return { outcome: "refused", why: "Needs your OK first" };
  if (r.ok) return { outcome: "ok", why: null };
  for (const [re, why] of REFUSALS) if (re.test(err)) return { outcome: "refused", why };
  for (const [re, why] of ERRORS) if (re.test(err)) return { outcome: "error", why };
  if (!err) return { outcome: "error", why: r.tool === "fill" ? "The field didn't keep the text" : null };
  const first = scrubUrls(err.split(/\n|(?<=\.)\s/)[0]).trim();
  return { outcome: "error", why: first.length > 120 ? `${first.slice(0, 119)}…` : first };
}

export function toItem(r: ActionRow, askingKey: string | null): ActivityItem {
  const detail = parse(r.detail);
  const { outcome, why } = outcomeOf(r, detail);
  return {
    id: r.id,
    ts: r.ts,
    browser: r.browser,
    thisBrowser: !!askingKey && r.browser_key === askingKey,
    session: r.session,
    site: siteText(r.tab_url),
    action: describe(r, detail),
    outcome,
    why,
  };
}
