# Browsteer

Browsteer lets Claude Code read and operate the pages open in your own Chrome
or Firefox, where you are already signed in. It is a browser extension and a
local MCP server. Claude sees each page as a compact accessibility snapshot
instead of raw HTML, then clicks buttons, fills forms, and reads values by
reference.

Use it for work that needs your logged-in browser: filling a form on a site
with no API, comparing listings across tabs, or reading a dashboard behind
single sign-on.

```
browser extension        hub (one local daemon)          per-session MCP shims
 content script ─ws:8787─▶ bridge/hub.ts ◀─ws:8787─ bridge/mcp.ts ─stdio─▶ claude (session A)
 (snapshot, click,         127.0.0.1 only                 bridge/mcp.ts ─stdio─▶ claude (session B)
  fill, read)              ~/.browsteer/browsteer.db
```

One hub process (`bridge/hub.ts`) owns the browser connection and keeps running
across sessions. Claude Code starts a small MCP shim (`bridge/mcp.ts`) for each
session. The shim forwards `browser_*` calls to the hub and starts the hub if
it is not running.

Access is closed by default. Claude can use the browser only while you have
allowed it for an hour, only on sites you have allowed, and one site per
session. [SECURITY.md](SECURITY.md) lists every limit and what it does not
cover, [PRIVACY.md](PRIVACY.md) says what is kept and what leaves the machine,
and [docs/PERMISSIONS.md](docs/PERMISSIONS.md) explains every permission the
extension asks for.

## Setup

Requires [Bun](https://bun.sh) 1.3 or newer.

```sh
git clone <this repository> browsteer && cd browsteer
bun install
bun run build          # → dist/chrome and dist/firefox

# Register the bridge with Claude Code (run from the repository root)
claude mcp add -s user browsteer -- bun run "$PWD/bridge/mcp.ts"

# Optional: the /browse slash command
mkdir -p ~/.claude/skills && cp -R skill/browse ~/.claude/skills/browse
```

**Chrome** (116 or newer; Edge and Brave work the same way): open
`chrome://extensions`, turn on *Developer mode*, choose *Load unpacked* and
select `dist/chrome`.

**Firefox** (128 or newer): install
[Browsteer from addons.mozilla.org](https://addons.mozilla.org/firefox/addon/browsteer/).
Firefox keeps it up to date. For a session-only install of your own build,
open `about:debugging#/runtime/this-firefox`, choose *Load Temporary Add-on…*
and select `dist/firefox/manifest.json`.

A setup page opens after install. It shows this browser's pairing key and turns
green once the bridge is found.

> The hub listens on `127.0.0.1:8787`. To use another port, set `BRIDGE_PORT`
> both when building the extension (`BRIDGE_PORT=8799 bun run build`) and in the
> environment the hub and MCP shim run in.

## Updating

```sh
bun run update      # pull, install, rebuild dist/, restart the hub
```

Firefox updates the extension from addons.mozilla.org (about:addons →
⚙ → *Check for Updates* to do it now). Chrome and temporary installs need
**Reload** on the extensions page after `bun run update`. The popup and
`browser_pair` say when the extension and the bridge are on different versions.
How releases are signed and published: [docs/RELEASING.md](docs/RELEASING.md).

## Use it

Open the page you want help with and click the Browsteer toolbar button:

1. **Allow Claude for 1 hour.** Access closes by itself afterwards; *Stop now* closes it at once.
2. **Allow** the site in the tab. Sites you have not allowed cannot be read or operated.
3. **Copy /browse command**, paste it into Claude Code and add a task:

```
/browse bst-ab12-cd34-ef56 list the open pull requests on this page
```

Optional switches in the popup: **Read only** (Claude can look but not click or
type) and **Let Claude switch site** (a session stays on the site it started
on; this lets the current one continue elsewhere).

The `/browse` skill calls `browser_pair(key)`, then works with
`browser_snapshot` / `browser_click` / `browser_fill` / `browser_read`. Refs
come from the latest snapshot and are invalid after navigation. For a form that
won't submit, `browser_form` lists every control's live state (value,
`*checked`, chosen option, required, error text, hidden `<select>`s behind
custom dropdowns) and each submit's `*disabled` in one call.

To stop the hub: `bun run hub:stop`. To cut off a paired session: *New key* in
the popup.

### Semantic targeting (optional, off by default)

`browser_find`, `browser_pursue` and `browser_do` can locate controls from a
description ("the export button next to the date range") by asking Jev, a
TypeSafe model. That sends an outline of the current page to `api.typesafe.ai`,
so it is **off** unless you turn it on:

```sh
echo '{"jev": true}' > ~/.browsteer/config.json     # plus TYPESAFE_API_KEY
bun run hub:stop                                    # the next session restarts the hub
```

While off, `browser_find` still resolves targets that name a control exactly
and ones it has learned before, both without any network call; `browser_pursue`
is unavailable; and clicks on controls that sound irreversible are refused.

## Develop

```sh
bun run dev            # Firefox: rebuild on save, auto-reload in a throwaway profile
bun run dev chrome     # Chrome: rebuild dist/chrome on save; reload from chrome://extensions
bun run typecheck
bun test
bun run package        # → artifacts/browsteer-{chrome,firefox}-<version>.zip
```

The version lives in `package.json`; the build writes it into both manifests.
After a content-script change, reload the target tab so the new script is
injected.

### Pairing model

The extension generates a key, persists it, and registers under it at the
bridge. The bridge keeps a `key → socket` registry; `browser_pair(key)` selects
the active browser — so several browsers can be connected and addressed by key.
The key is both selector and shared secret (only someone who sees the popup can
drive that browser).

> **MV3 gotcha:** the extension's `connect-src` CSP must list the bridge socket
> (`ws://127.0.0.1:8787`) or the WebSocket is blocked *silently*. See
> `extension/manifest.base.json`.

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
| `bridge/hub.ts` | the daemon: WebSocket server, pairing registry, every `browser_*` op |
| `bridge/mcp.ts` | per-session MCP shim that forwards to the hub |
| `bridge/security.ts` | token, extension binding, site lock, fetch and download limits, config |
| `bridge/jev.ts` | optional semantic targeting: questions, thresholds, opt-in switch |
| `bridge/db.ts` | `bun:sqlite` action log, filters, memos (`~/.browsteer/browsteer.db`) |
| `bridge/cli.ts` | run any single op from a shell |
| `extension/manifest.base.json` | manifest shared by both browsers; `scripts/build.ts` adds the per-browser keys |
| `extension/src/ext.ts` | one name for the WebExtensions API in both browsers |
| `extension/src/background.ts` | socket to the hub, key registration, relays ops to the tab (event page in Firefox, service worker in Chrome) |
| `extension/src/policy.ts` | access rules: key generation, arming, site lists, read-only, the gate every request passes |
| `extension/src/risk.ts` | which control names count as a commitment (shared with the hub) |
| `extension/src/guard.ts` | the check before a click or key press activates a control |
| `extension/src/site.ts` | what counts as one site (shared with the hub) |
| `extension/src/content.ts` | actions (click/fill/read/press), element picker, message plumbing |
| `extension/src/snapshot.ts` | snapshot core — pure DOM-in/string-out, unit-tested under happy-dom |
| `extension/src/fallback.ts` | hit-test scan, coordinate clicks, keyboard-style typing |
| `extension/src/dialogs.ts`, `dialogs-main.ts` | alert/confirm/prompt handling; the second file is Chrome's page-world half |
| `extension/src/popup.ts`, `welcome.ts`, `keyview.ts` | popup and setup page |
| `scripts/build.ts`, `package.ts`, `dev.ts` | build, package, dev loop |
| `scripts/update.ts`, `updates-json.ts` | `bun run update`; the `updates.json` Firefox reads for new versions |
| `bridge/version.ts` | the bridge version and the extension/bridge mismatch notes |
| `scripts/check-manifest.ts` | CI check: the built manifests ask for exactly what is documented |
| `.github/workflows/release.yml` | on a `v*` tag: test, build, submit to addons.mozilla.org with the source, publish the GitHub release ([docs/RELEASING.md](docs/RELEASING.md)) |
| `.github/workflows/ci.yml` | typecheck, tests, build, manifest check, Firefox lint, package |
| `skill/browse/SKILL.md` | the `/browse` slash command for Claude Code |

## Tests

```sh
bun test                    # unit + integration tests, no browser needed
bun run reduction           # before/after bytes+tokens for the reduction passes
```

`test/snapshot.test.ts` drives the snapshot core under happy-dom against
`test/fixtures.ts` — structural replicas of a mobile.de detail page and results
list, carrying the element counts observed in real use (31 gallery thumbs, a
duplicated financing block, 12 map controls, 10 footer links). `test/hub.test.ts`
exercises auto-pin and the drift refusal against a fake extension socket, so the
targeting logic, the connection rules and the semantic-targeting default are
covered without launching a browser.

With a real browser:

```sh
bun run test/serve.ts &     # fixture page on :8080
bun run test/mcp-client.ts  # spawns bridge, launches Firefox, snapshots + acts
bun run test/measure.ts     # snapshot vs raw DOM on your CURRENT active tab
```

## Inspect the action log

```sh
sqlite3 ~/.browsteer/browsteer.db 'SELECT ts, tool, ref, ok, error FROM actions ORDER BY id DESC LIMIT 20;'
```

## License

[MIT](LICENSE). Forks are welcome under the license. Please give a fork its own name, so users can tell it apart from Browsteer.
