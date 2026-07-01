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
after each action.

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

`classify()` in `extension/src/content.ts` decides what becomes a snapshot line.
It is the salience policy — the lever between "too noisy / too many tokens" and
"missed the price / the button". Tune it as you learn what real booking pages need.

## Files

| Path | Role |
|------|------|
| `bridge/index.ts` | WS server + MCP server (`browser_pair` + snapshot/click/fill/read) + keyed registry |
| `bridge/db.ts` | `bun:sqlite` action log + filters (`~/.browsteer/browsteer.db`) |
| `extension/src/content.ts` | a11y snapshot + click/fill/read |
| `extension/src/background.ts` | WS client, key registration, relays ops to the active tab |
| `extension/src/popup.ts` | shows the pairing key + copies `/browse <key>` |
| `scripts/dev.ts` | bundler watch + `web-ext run` |
| `test/mcp-client.ts` | self-contained E2E: spawns bridge → Firefox → drives the fixture |
| `~/.claude/skills/browse/SKILL.md` | the `/browse` slash command |

## Test end-to-end

```sh
bun run test/serve.ts &     # booking-like fixture on :8080
bun run test/mcp-client.ts  # spawns bridge, launches Firefox, snapshots + acts
```

## Inspect the action log

```sh
sqlite3 ~/.browsteer/browsteer.db 'SELECT ts, tool, ref, ok, error FROM actions ORDER BY id DESC LIMIT 20;'
```
