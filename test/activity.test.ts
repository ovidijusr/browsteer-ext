// Settings › Activity: how the bridge words the action log (bridge/activity.ts)
// and how the Settings page filters and groups it (extension/src/activity.ts).
import { describe, expect, test } from "bun:test";
import { describe as words, outcomeOf, siteText, toItem } from "../bridge/activity";
import type { ActionRow } from "../bridge/db";
import { andList, applyFilters, choices, dayLabel, group, readActivity, type ActivityItem } from "../extension/src/activity";

const row = (r: Partial<ActionRow>): ActionRow => ({
  id: 1, ts: 0, tab_url: null, tool: "snapshot", ref: null, value: null, ok: 1, error: null,
  element_count: null, detail: null, browser: null, browser_key: null, session: null, ...r,
});

describe("site", () => {
  test("host and path only: no query, fragment or credentials", () => {
    expect(siteText("https://user:pw@mail.example.com:8443/inbox/42?token=abc#msg")).toBe("mail.example.com:8443/inbox/42");
    expect(siteText("https://example.com/?q=secret")).toBe("example.com");
    expect(siteText("chrome://settings")).toBe(null);
    expect(siteText(null)).toBe(null);
    expect(siteText("not a url")).toBe(null);
  });
});

describe("plain words", () => {
  test("clicks name the control as the page does", () => {
    expect(words(row({ tool: "click", ref: 12, detail: JSON.stringify({ el: { role: "button", name: "Save" } }) }))).toBe("Clicked [12] button “Save”");
    expect(words(row({ tool: "click", ref: 12 }))).toBe("Clicked [12]");
    expect(words(row({ tool: "click", value: "100,200" }))).toBe("Clicked a point on the page");
  });

  test("fills say how long the text was, never what it was", () => {
    const fill = row({ tool: "fill", ref: 3, value: "‹8 chars›", detail: JSON.stringify({ el: { role: "textbox", name: "Password" } }) });
    expect(words(fill)).toBe("Filled [3] textbox “Password” (8 characters)");
    expect(words(row({ tool: "fill", ref: 3, value: "‹1 chars›" }))).toBe("Filled [3] (1 character)");
    expect(words(row({ tool: "fill", value: "‹4 chars›", detail: JSON.stringify({ how: "keys" }) }))).toBe("Typed into a field (4 characters)");
  });

  test("chosen options, goals, steps and file names are left out", () => {
    expect(words(row({ tool: "select", ref: 5, value: "Lithuania" }))).toBe("Chose an option in [5]");
    expect(words(row({ tool: "pursue", value: "send mail to sam@example.com", element_count: 3 }))).toBe("Worked toward a goal (3 steps)");
    expect(words(row({ tool: "do", value: "email field | Send", element_count: 2 }))).toBe("Ran 2 steps");
    expect(words(row({ tool: "upload", value: "passport.pdf, photo.jpg" }))).toBe("Uploaded 2 files");
  });

  test("named keys are shown; a single character could be typing, so it is not", () => {
    expect(words(row({ tool: "press", value: "Enter" }))).toBe("Pressed Enter");
    expect(words(row({ tool: "press", value: "Control+a" }))).toBe("Pressed Control+a");
    expect(words(row({ tool: "press", value: "x", ref: 4 }))).toBe("Pressed a key in [4]");
  });

  test("find says what it looked for and what it did", () => {
    const find = (outcome: string, extra: object = {}) => row({ tool: "find", ref: 7, value: "the Save button", detail: JSON.stringify({ outcome, ...extra }) });
    expect(words(find("clicked"))).toBe("Found and clicked “the Save button” [7]");
    expect(words(find("filled", { fillValue: "‹5 chars›" }))).toBe("Found and filled “the Save button” (5 characters)");
    expect(words(find("refused:guard"))).toBe("Didn't click “the Save button”");
    expect(words(find("shortlist"))).toBe("Looked for “the Save button”");
    expect(words(row({ tool: "find", value: "a | b | c", detail: JSON.stringify({ outcome: "multi" }) }))).toBe("Looked for 3 controls");
  });

  test("reads", () => {
    expect(words(row({ tool: "snapshot" }))).toBe("Read the page");
    expect(words(row({ tool: "snapshot", value: "jev" }))).toBe("Read the page to find a control");
    expect(words(row({ tool: "navigate" }))).toBe("Opened the page");
  });
});

describe("outcome", () => {
  test("Browsteer's own limits are refusals, with a short reason", () => {
    expect(outcomeOf(row({ ok: 0, error: "drift refused" }))).toEqual({ outcome: "refused", why: "The tab had moved to another page" });
    expect(outcomeOf(row({ ok: 0, error: "site lock" }))).toEqual({ outcome: "refused", why: "Outside the session's site" });
    expect(outcomeOf(row({ ok: 0, error: "mail.example.com is not on the user's allowed list. Ask…" }))).toEqual({ outcome: "refused", why: "The site isn't allowed" });
    expect(outcomeOf(row({ ok: 1, tool: "find", detail: JSON.stringify({ outcome: "refused:guard" }) }))).toEqual({ outcome: "refused", why: "Needs your OK first" });
  });

  test("other failures are errors; addresses in the message lose their query", () => {
    expect(outcomeOf(row({ ok: 0, error: "Extension timed out after 15000ms on 'click'." }))).toEqual({ outcome: "error", why: "The page didn't answer in time" });
    const odd = outcomeOf(row({ ok: 0, error: "The request to https://api.example.com/v1/me?key=SECRET failed (403). More text." }));
    expect(odd.outcome).toBe("error");
    expect(odd.why).toBe("The request to api.example.com/v1/me failed (403).");
    expect(outcomeOf(row({ ok: 1 }))).toEqual({ outcome: "ok", why: null });
  });

  test("toItem marks the asking browser by its key, and never passes the key on", () => {
    const r = row({ id: 9, ts: 5, tab_url: "https://a.example/x?y=1", browser: "edge", browser_key: "bst-aaaa-bbbb-cccc", session: "s1" });
    const mine = toItem(r, "bst-aaaa-bbbb-cccc");
    expect(mine).toMatchObject({ id: 9, ts: 5, browser: "edge", thisBrowser: true, session: "s1", site: "a.example/x", outcome: "ok" });
    expect(JSON.stringify(mine)).not.toContain("bst-");
    expect(toItem(r, "bst-zzzz-zzzz-zzzz").thisBrowser).toBe(false);
    expect(toItem(r, null).thisBrowser).toBe(false);
  });
});

describe("Settings page grouping", () => {
  const now = new Date(2026, 10, 19, 15, 0).getTime();
  const at = (h: number, m: number, day = 19) => new Date(2026, 10, day, h, m).getTime();
  const it = (id: number, ts: number, extra: Partial<ActivityItem> = {}): ActivityItem =>
    ({ id, ts, browser: "edge", thisBrowser: true, session: "s1", site: "github.com/acme", action: "Read the page", outcome: "ok", why: null, ...extra });
  const items = [
    it(1, at(14, 0)),
    it(2, at(14, 5), { session: "s2", browser: "firefox", thisBrowser: false, site: "linear.app/x" }),
    it(3, at(14, 10), { outcome: "error" }),
    it(4, at(9, 0, 18), { session: "s3" }),
    it(5, at(9, 0, 15), { session: null, browser: null, thisBrowser: false }),
  ];

  test("days newest first, sessions by their latest action, actions newest first", () => {
    const g = group(items, now);
    expect(g.map((d) => d.label)).toEqual(["Today", "Yesterday", dayLabel(at(9, 0, 15), now)]);
    expect(g[0].sessions.map((s) => s.session)).toEqual(["s1", "s2"]);
    expect(g[0].sessions[0].items.map((i) => i.id)).toEqual([3, 1]);
    expect(g[0].sessions[0]).toMatchObject({ first: at(14, 0), last: at(14, 10), problems: 1, browsers: ["Edge"] });
    expect(g[2].sessions[0].session).toBe(null);
    expect(g[2].sessions[0].browsers).toEqual([]); // logged before the browser was kept
  });

  test("filters: browser, site (by host), refused and failed only", () => {
    expect(applyFilters(items, { browser: "firefox", site: "", problems: false }).map((i) => i.id)).toEqual([2]);
    expect(applyFilters(items, { browser: "", site: "github.com", problems: false }).map((i) => i.id)).toEqual([1, 3, 4, 5]);
    expect(applyFilters(items, { browser: "", site: "", problems: true }).map((i) => i.id)).toEqual([3]);
  });

  test("filter menus list what is in the log, this browser marked", () => {
    const c = choices(items);
    expect(c.browsers).toEqual([{ value: "edge", label: "Edge (this one)" }, { value: "firefox", label: "Firefox" }, { value: "?", label: "A browser" }]);
    expect(c.sites).toEqual(["github.com", "linear.app"]);
  });

  test("only well-formed replies are drawn", () => {
    expect(readActivity(null)).toBe(null);
    expect(readActivity({ type: "jev" })).toBe(null);
    const r = readActivity({ type: "activity", items: [{ id: 1, ts: 1, action: "Read the page", outcome: "weird" }, { ts: "x" }], keepDays: 30 });
    expect(r!.items).toHaveLength(1);
    expect(r!.items[0].outcome).toBe("ok");
  });

  test("andList", () => {
    expect(andList(["Edge"])).toBe("Edge");
    expect(andList(["Edge", "Firefox"])).toBe("Edge and Firefox");
    expect(andList(["Edge", "Firefox", "Chrome"])).toBe("Edge, Firefox and Chrome");
  });
});
