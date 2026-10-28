# Browsteer

Let a local **Claude Code** instance drive your **real, logged-in** Firefox tab —
click, fill, and read — over a token-efficient **accessibility snapshot** instead
of raw HTML.

```
Firefox extension        shared HUB (one daemon)        per-session MCP shims
 content.ts  ──ws:8787──▶  bridge/hub.ts  ◀──ws:8787/control──  bridge/mcp.ts ──stdio──▶ claude (session A)
 (a11y snapshot,           owns browser + filters         bridge/mcp.ts ──stdio──▶ claude (session B)
  click/fill/read)         (~/.browsteer/browsteer.db)
```

The bridge is split so it's lightweight and frictionless: a single **hub**
daemon owns the WebSocket + the browser connection + the SQLite filters and
**persists** across sessions; a thin **MCP shim** is what Claude spawns per
session — it binds no port and just forwards `browser_*` calls to the hub,
**lazily starting the hub** on first use. Many sessions share one hub.

## MVP scope

The **snapshot + action loop**: `browser_snapshot`, `browser_click`,
`browser_fill`, `browser_read`. Learn→template→replay and booking-compare are
later phases.

## Setup on a new machine

```sh
# 1. Install Bun (>= 1.3) — https://bun.sh
curl -fsSL https://bun.sh/install | bash

# 2. Clone + install + build (extension/dist/ is generated, not committed)
git clone git@github.com:ovidijusr/browsteer.git && cd browsteer
bun install
bun run build

# 3. Register the MCP shim with Claude Code (run from the repo root)
claude mcp add browsteer -- bun run "$PWD/bridge/mcp.ts"
```

**4. Install the extension in Firefox:** download `browsteer-<version>.xpi` from
[GitHub Releases](https://github.com/ovidijusr/browsteer/releases) and open it
with Firefox — it's AMO-signed (unlisted channel), so it installs permanently
and survives restarts. For development instead, load it temporarily via
`about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* →
`extension/manifest.json` (drops on restart). New releases: bump `version` in
`extension/manifest.json`, `bun run sign` (AMO credentials), attach the signed
`.xpi` to a new GitHub release.

**5. Copy the `/browse` skill** to `~/.claude/skills/browse/` if you use the
slash command (it lives in the user's skills dir, not this repo).

> Port note: the hub listens on `:8787`. `BRIDGE_PORT` moves the bridge side
> only — the extension hardcodes it in `extension/src/background.ts` and the
> manifest CSP, so changing the port means editing those too.

## Run it

**1. Start the extension dev loop** (bundler watch + Firefox auto-reload):

```sh
bun run dev
```

A dev Firefox launches with the extension loaded. Edit `extension/src/*.ts` →
it rebuilds → Firefox reloads the add-on. (After a *content-script* change,
refresh the target tab so the new script injects.)

**2. Register the bridge with Claude Code** (one-time — Claude spawns the thin
shim per session; the shim lazily starts the shared hub):

```sh
claude mcp add browsteer -- bun run "$PWD/bridge/mcp.ts"   # from the repo root
```

The hub persists across sessions (so the extension stays paired). To stop it:
`bun run hub:stop` (or `bun run bridge/hub.ts --stop`).

**3. Pair + drive.** Click the Browsteer toolbar icon → the popup shows a
key like `bst-ab12-cd34` and a button that copies `/browse <key> ` to your
clipboard. Paste it into Claude Code and add a task:

```
/browse bst-ab12-cd34 compare the prices in the flight results
```

The `/browse` skill calls `browser_pair(key)`, then drives the page with
`browser_snapshot` / `browser_click` / `browser_fill` / `browser_read`. Refs
come from the latest snapshot and are invalid after navigation — re-snapshot
after each action. For a form that won't submit, `browser_form` lists every
control's live state (value, `*checked`, chosen option, required, error text,
hidden `<select>`s behind custom dropdowns) and each submit's `*disabled` in one
call.

### Pairing model

The extension generates a key, persists it, and registers under it at the
bridge. The bridge keeps a `key → socket` registry; `browser_pair(key)` selects
the active browser — so several browsers can be connected and addressed by key.
The key is both selector and shared secret (only someone who sees the popup can
drive that browser).

> **MV3 gotcha:** the extension's `connect-src` CSP must list the bridge socket
> (`ws://127.0.0.1:8787`) or the WebSocket is blocked *silently*. See
> `extension/manifest.json`.

## The one knob that matters

`classify()` in `extension/src/snapshot.ts` decides what becomes a snapshot line.
It is the salience policy — the lever between "too noisy / too many tokens" and
"missed the price / the button". Tune it as you learn what real booking pages need.

## Reduction passes

Beyond the a11y reduction, three structural passes run on every snapshot. Each is
reported in the response header (`Reduced: collapsed 30, deduped 19, chrome 2`)
and all three are switched off by `raw: true`.

| Pass | What it does | Why |
|------|--------------|-----|
| **collapse** | Runs of 5+ childless look-alike sibling controls become one ranged line, `[13-43] button "Weiter 1…Weiter 31" ×31 collapsed`. Every ref in the range is still individually clickable. | A 31-photo gallery shipped 31 refs of zero information on every listing page. |
| **dedup** | A subtree repeated verbatim later on the page becomes `↩ identical to an earlier block (14 lines omitted, refs [92-96] still clickable)`. | autoplius renders its whole financing calculator twice, byte-identical. |
| **chrome** | Drops `footer`/`[role=contentinfo]`, Google-Maps widgets (`.gm-style`), and consent containers addressed by their own well-known ids. | ~20 refs of legal links and map zoom controls per page. |

**The asymmetry that shapes the design:** over-collapsing a gallery costs
nothing; silently dropping the block that held the one number you needed costs a
wrong answer nobody detects. So structural collapsing is automatic and universal,
while anything semantic stays explicit — hence no fuzzy class matching in the
chrome list, a length cap on collapsible names (result cards digit-normalise to
the same skeleton as `"Weiter 1"`, and folding *them* would hide 20 distinct
cars — see the regression test), and refs preserved on every elided block.

## Getting off a list page cheaply

Extraction filters append an implicit `url` column, with the shared head and tail
of the hrefs hoisted into the legend once:

```
# mobile-de-srp | 20 items | id;title;price;specs;url
# url = "https://suchen.mobile.de/fahrzeuge/details.html?id=" + <url> + "&con=USED&…&vc=Car"
[1] M50 M Sport Pro AHK Laser HUD;46.940 €;EZ 05/2023 • 67.675 km;453073528
```

`browser_links` does the same for an arbitrary page or subtree. Both exist to
kill the old four-call detour to reach one result: *snapshot → browser_html(ref)
→ parse the href out of truncated HTML → navigate*.

## Tab targeting

The first op that reaches a tab **auto-pins** to it and says so, so a later call
can't quietly answer about whatever the user happened to focus. If an unpinned
read does land somewhere else, the hub returns an **error instead of the
payload** — being told in one line beats paying for a few thousand tokens of the
wrong document. `browser_pin` with no `tabId` opts out for the session.

## Files

| Path | Role |
|------|------|
| `bridge/index.ts` | WS server + MCP server (`browser_pair` + snapshot/click/fill/read) + keyed registry |
| `bridge/db.ts` | `bun:sqlite` action log + filters (`~/.browsteer/browsteer.db`, `BROWSTEER_DB_DIR` overrides) |
| `extension/src/snapshot.ts` | snapshot core — pure DOM-in/string-out, unit-tested under happy-dom |
| `extension/src/content.ts` | actions (click/fill/read/press), element picker, message plumbing |
| `extension/src/background.ts` | WS client, key registration, relays ops to the active tab |
| `extension/src/popup.ts` | shows the pairing key + copies `/browse <key>` |
| `scripts/dev.ts` | bundler watch + `web-ext run` |
| `test/mcp-client.ts` | self-contained E2E: spawns bridge → Firefox → drives the fixture |
| `~/.claude/skills/browse/SKILL.md` | the `/browse` slash command |

## Tests

```sh
bun test                    # 30 unit + integration tests, no browser needed
bun run reduction           # before/after bytes+tokens for the reduction passes
```

`test/snapshot.test.ts` drives the snapshot core under happy-dom against
`test/fixtures.ts` — structural replicas of a mobile.de detail page and results
list, carrying the element counts observed in real use (31 gallery thumbs, a
duplicated financing block, 12 map controls, 10 footer links). `test/hub.test.ts`
exercises auto-pin and the drift refusal against a fake extension socket, so the
targeting logic is covered without launching Firefox.

With a real browser:

```sh
bun run test/serve.ts &     # booking-like fixture on :8080
bun run test/mcp-client.ts  # spawns bridge, launches Firefox, snapshots + acts
bun run test/measure.ts     # snapshot vs raw DOM on your CURRENT active tab
```

## Inspect the action log

```sh
sqlite3 ~/.browsteer/browsteer.db 'SELECT ts, tool, ref, ok, error FROM actions ORDER BY id DESC LIMIT 20;'
```
