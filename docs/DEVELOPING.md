# Developing Browsteer

How the parts fit together, what shapes a snapshot, where the code lives, and
how to test it. For setup and everyday use, see the [README](../README.md).

## How the parts connect

```
browser extension        hub (one local daemon)          per-session MCP shims
 content script ─ws:8787─▶ bridge/hub.ts ◀─ws:8787─ bridge/mcp.ts ─stdio─▶ claude (session A)
 (snapshot, click,         127.0.0.1 only                 bridge/mcp.ts ─stdio─▶ claude (session B)
  fill, read)              ~/.browsteer/browsteer.db
```

The README calls the hub and the shims together "the bridge". One hub process
(`bridge/hub.ts`) owns the browser connection and keeps running across
sessions. Claude Code starts a small MCP shim (`bridge/mcp.ts`) for each
session. The shim forwards `browser_*` calls to the hub and starts the hub if
it is not running.

The hub listens on `127.0.0.1:8787`. To use another port, set `BRIDGE_PORT`
both when you build the extension (`BRIDGE_PORT=8799 bun run build`) and in
the environment that the hub and the MCP shim run in.

## Develop

```sh
bun run dev            # Firefox: rebuild on save, auto-reload in a throwaway profile
bun run dev chrome     # Chrome: rebuild dist/chrome on save; reload from chrome://extensions
bun run typecheck
bun test
bun run package        # writes artifacts/browsteer-{chrome,firefox}-<version>.zip
```

The version lives in `package.json`. The build writes it into both manifests.
After a content-script change, reload the target tab so the browser injects the
new script.

## The tools Claude uses

The `/browse` skill calls `browser_pair(key)`, then works with
`browser_snapshot`, `browser_click`, `browser_fill`, and `browser_read`. Refs
come from the latest snapshot and are invalid after navigation. For a form that
won't submit, `browser_form` lists every control's live state in one call:
value, `*checked`, chosen option, required, error text, hidden `<select>`
elements behind custom dropdowns, and each submit button's `*disabled`.

With semantic targeting off, `browser_find` still resolves targets that name a
control exactly and ones it has learned before, both without any network call.
`browser_pursue` is unavailable, and clicks on controls that sound irreversible
are refused.

## Pairing model

The extension generates a key, persists it, and registers under it at the
bridge. The bridge keeps a `key → socket` registry, and `browser_pair(key)`
selects the active browser. Several browsers can be connected at once, each
addressed by its key. The key is both the selector and a shared secret: only
someone who sees the popup can drive that browser.

> **MV3 gotcha:** the extension's `connect-src` CSP must list the bridge socket
> (`ws://127.0.0.1:8787`), or the browser blocks the WebSocket without any
> error. See `extension/manifest.base.json`.

## What becomes a snapshot line

`classify()` in `extension/src/snapshot.ts` decides what becomes a snapshot
line. It is the salience policy, the setting that trades "too noisy, too many
tokens" against "missed the price or the button". Tune it as you learn what
real booking pages need.

## Reduction passes

Beyond the accessibility reduction, three structural passes run on every
snapshot. The response header reports each one
(`Reduced: collapsed 30, deduped 19, chrome 2`), and `raw: true` switches off
all three.

| Pass | What it does | Why |
|------|--------------|-----|
| **collapse** | Runs of 5+ childless look-alike sibling controls become one ranged line, `[13-43] button "Weiter 1…Weiter 31" ×31 collapsed`. Every ref in the range is still individually clickable. | A 31-photo gallery shipped 31 refs of zero information on every listing page. |
| **dedup** | A subtree repeated verbatim later on the page becomes `↩ identical to an earlier block (14 lines omitted, refs [92-96] still clickable)`. | autoplius renders its whole financing calculator twice, byte-identical. |
| **chrome** | Drops `footer`/`[role=contentinfo]`, Google-Maps widgets (`.gm-style`), and consent containers addressed by their own well-known ids. | ~20 refs of legal links and map zoom controls per page. |

One asymmetry shapes the design. Over-collapsing a gallery costs nothing.
Silently dropping the block that held the one number you needed costs a wrong
answer that nobody detects. So structural collapsing is automatic and
universal, while anything semantic stays explicit:

- The chrome list has no fuzzy class matching.
- Collapsible names have a length cap. Result cards normalise their digits to
  the same skeleton as `"Weiter 1"`, and folding them would hide 20 distinct
  cars. A regression test covers this.
- Every elided block keeps its refs.

## Getting off a list page cheaply

Extraction filters append an implicit `url` column, with the shared head and
tail of the hrefs moved into the legend once:

```
# mobile-de-srp | 20 items | id;title;price;specs;url
# url = "https://suchen.mobile.de/fahrzeuge/details.html?id=" + <url> + "&con=USED&…&vc=Car"
[1] M50 M Sport Pro AHK Laser HUD;46.940 €;EZ 05/2023 • 67.675 km;453073528
```

`browser_links` does the same for any page or subtree. Both replace the old
four-call detour to reach one result: snapshot, then `browser_html(ref)`, then
parse the href out of truncated HTML, then navigate.

## Tab targeting

The first operation that reaches a tab pins the session to it and says so.
A later call therefore can't answer about whatever tab the user happened to
focus. If an unpinned read lands on a different tab, the hub returns an error
instead of the payload: a one-line error costs less than a few thousand tokens
of the wrong document. `browser_pin` with no `tabId` turns pinning off for the
session.

## Files

| Path | Role |
|------|------|
| `bridge/hub.ts` | the daemon: WebSocket server, pairing registry, every `browser_*` op |
| `bridge/mcp.ts` | per-session MCP shim that forwards to the hub |
| `bridge/security.ts` | token, extension binding, site lock, fetch and download limits, config |
| `bridge/jev.ts` | optional semantic targeting: questions, thresholds, opt-in switch |
| `bridge/db.ts` | `bun:sqlite` action log, filters, memos (`~/.browsteer/browsteer.db`) |
| `bridge/cli.ts` | run any single op from a shell |
| `bridge/version.ts` | the bridge version and the extension/bridge mismatch notes |
| `extension/manifest.base.json` | manifest shared by both browsers; `scripts/build.ts` adds the per-browser keys |
| `extension/src/ext.ts` | one name for the WebExtensions API in both browsers |
| `extension/src/background.ts` | socket to the hub, key registration, relays ops to the tab (event page in Firefox, service worker in Chrome) |
| `extension/src/policy.ts` | access rules: key generation, arming, site lists, read-only, the gate every request passes |
| `extension/src/risk.ts` | which control names count as a commitment (shared with the hub) |
| `extension/src/guard.ts` | the check before a click or key press activates a control |
| `extension/src/site.ts` | what counts as one site (shared with the hub) |
| `extension/src/content.ts` | actions (click, fill, read, press), element picker, message plumbing |
| `extension/src/snapshot.ts` | snapshot core: pure DOM in, string out, unit-tested under happy-dom |
| `extension/src/fallback.ts` | hit-test scan, coordinate clicks, keyboard-style typing |
| `extension/src/dialogs.ts`, `dialogs-main.ts` | alert, confirm, and prompt handling; the second file is Chrome's page-world half |
| `extension/src/popup.ts`, `welcome.ts`, `keyview.ts` | popup and setup page |
| `scripts/build.ts`, `package.ts`, `dev.ts` | build, package, dev loop |
| `scripts/update.ts`, `updates-json.ts` | `bun run update`; the `updates.json` Firefox reads for new versions |
| `scripts/check-manifest.ts` | CI check: the built manifests ask for exactly what is documented |
| `.github/workflows/release.yml` | on a `v*` tag: test, build, submit to addons.mozilla.org with the source, publish the GitHub release ([RELEASING.md](RELEASING.md)) |
| `.github/workflows/ci.yml` | typecheck, tests, build, manifest check, Firefox lint, package; and the end-to-end test in Chromium |
| `bridge/activity.ts` | the action log in plain words for Settings › Activity (asked for by the registered extension only) |
| `test/e2e/run.ts` | `bun run test:e2e`: the real extension in a real browser against a hub on its own port |
| `skill/browse/SKILL.md` | the `/browse` slash command for Claude Code |

## Tests

```sh
bun test                    # unit and integration tests, no browser needed
bun run reduction           # bytes and tokens before and after the reduction passes
```

`test/snapshot.test.ts` drives the snapshot core under happy-dom against
`test/fixtures.ts`. The fixtures are structural replicas of a mobile.de detail
page and results list, with the element counts seen in real use: 31 gallery
thumbnails, a duplicated financing block, 12 map controls, and 10 footer links.
`test/hub.test.ts` exercises auto-pin and the drift refusal against a fake
extension socket. Together they cover the targeting logic, the connection
rules, and the semantic-targeting default without launching a browser.

End to end, with the real extension in a real browser (not part of `bun test`):

```sh
bun run test:e2e                       # Edge on Windows, Playwright's Chromium elsewhere
E2E_CHANNEL=chromium bun run test:e2e  # needs: node_modules/.bin/playwright install chromium
```

It builds the Chrome extension for port 8799 (`E2E_PORT`) into a temp folder, starts a
hub there with its own data folder, loads the unpacked build with Playwright, checks
that the popup shows Locked, allows a local test page and opens access the way the
popup does, pairs a controller with the browser's key, runs snapshot, fill and click on
the page, and reads Settings › Activity back. Nothing in `dist/` or `~/.browsteer` and
no hub on 8787 is touched.

Older manual checks:

```sh
bun run test/serve.ts &     # fixture page on :8080
bun run test/mcp-client.ts  # spawns the bridge, launches Firefox, snapshots and acts
bun run test/measure.ts     # snapshot vs raw DOM on your current active tab
```

## Inspect the action log

Settings › Activity in the extension shows it in plain words. Raw:

```sh
sqlite3 ~/.browsteer/browsteer.db 'SELECT ts, browser, session, tool, ref, ok, error FROM actions ORDER BY id DESC LIMIT 20;'
```
