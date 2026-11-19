// Settings › Activity: what Claude did, as the bridge's action log tells it.
// The bridge words each action (bridge/activity.ts); this file only filters and
// groups them by day and by Claude session. No DOM here: unit-tested in
// test/activity.test.ts.

export type Outcome = "ok" | "refused" | "error";
/** One action, as the bridge sends it (bridge/activity.ts ActivityItem). */
export type ActivityItem = {
  id: number;
  ts: number;
  browser: string | null;
  thisBrowser: boolean;
  session: string | null;
  site: string | null;
  action: string;
  outcome: Outcome;
  why: string | null;
};
export type ActivityReply = { type: "activity"; items: ActivityItem[]; keepDays: number; browser: string | null; now: number };

/** Only well-formed items get drawn; anything else from the bridge is dropped. */
export function readActivity(r: unknown): ActivityReply | null {
  const m = r as any;
  if (!m || m.type !== "activity" || !Array.isArray(m.items)) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const items: ActivityItem[] = m.items.filter((i: any) => i && Number.isFinite(i.ts) && typeof i.action === "string").map((i: any) => ({
    id: Number(i.id) || 0,
    ts: Number(i.ts),
    browser: str(i.browser),
    thisBrowser: i.thisBrowser === true,
    session: str(i.session),
    site: str(i.site),
    action: i.action,
    outcome: i.outcome === "refused" || i.outcome === "error" ? i.outcome : "ok",
    why: str(i.why),
  }));
  return { type: "activity", items, keepDays: Number(m.keepDays) || 30, browser: str(m.browser), now: Number(m.now) || Date.now() };
}

const NAMES: Record<string, string> = { edge: "Edge", firefox: "Firefox", chrome: "Chrome", brave: "Brave", opera: "Opera" };
/** "Edge", "Firefox"…; actions logged before the log kept the browser say "A browser". */
export const browserName = (b: string | null) => (b ? NAMES[b] ?? b.charAt(0).toUpperCase() + b.slice(1) : "A browser");
/** The host part of "host/path". */
export const hostPart = (site: string | null) => (site ? site.split("/")[0] : null);

export type Filters = { browser: string; site: string; problems: boolean };
export const ALL = "";

export function applyFilters(items: ActivityItem[], f: Filters): ActivityItem[] {
  return items.filter((i) =>
    (f.browser === ALL || (i.browser ?? "?") === f.browser) &&
    (f.site === ALL || hostPart(i.site) === f.site) &&
    (!f.problems || i.outcome !== "ok"));
}

/** The browsers and sites in the log, for the filter menus (most used first). */
export function choices(items: ActivityItem[]): { browsers: { value: string; label: string }[]; sites: string[] } {
  const count = <T,>(keys: T[]) => { const m = new Map<T, number>(); for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k); };
  const mine = new Set(items.filter((i) => i.thisBrowser).map((i) => i.browser ?? "?"));
  const browsers = count(items.map((i) => i.browser ?? "?")).map((b) => ({
    value: b,
    label: `${browserName(b === "?" ? null : b)}${mine.has(b) ? " (this one)" : ""}`,
  }));
  const sites = count(items.map((i) => hostPart(i.site)).filter((h): h is string => !!h));
  return { browsers, sites };
}

export type SessionGroup = { session: string | null; items: ActivityItem[]; first: number; last: number; browsers: string[]; problems: number };
export type DayGroup = { day: string; label: string; sessions: SessionGroup[] };

const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
export function dayLabel(ms: number, now: number): string {
  if (dayKey(ms) === dayKey(now)) return "Today";
  if (dayKey(ms) === dayKey(now - 86_400_000)) return "Yesterday";
  return new Date(ms).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}

/** Newest day first; within a day, the session with the latest action first; within a session, newest first. */
export function group(items: ActivityItem[], now: number): DayGroup[] {
  const days = new Map<string, Map<string, ActivityItem[]>>();
  for (const i of [...items].sort((a, b) => b.ts - a.ts || b.id - a.id)) {
    const d = dayKey(i.ts);
    if (!days.has(d)) days.set(d, new Map());
    const s = days.get(d)!;
    const k = i.session ?? "";
    if (!s.has(k)) s.set(k, []);
    s.get(k)!.push(i);
  }
  return [...days.entries()].map(([day, sessions]) => {
    const list: SessionGroup[] = [...sessions.entries()].map(([k, its]) => ({
      session: k || null,
      items: its,
      first: its[its.length - 1].ts,
      last: its[0].ts,
      browsers: [...new Set(its.filter((i) => i.browser).map((i) => browserName(i.browser)))],
      problems: its.filter((i) => i.outcome !== "ok").length,
    }));
    list.sort((a, b) => b.last - a.last);
    return { day, label: dayLabel(list[0].last, now), sessions: list };
  });
}

/** "Edge", "Edge and Firefox", "Edge, Firefox and Chrome". */
export function andList(xs: string[]): string {
  return xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
