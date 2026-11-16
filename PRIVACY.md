# Privacy

Browsteer has two parts: a browser extension, and a bridge (the "hub") that
runs on the same computer. This page says what each one can see, what it
keeps, and what leaves the machine.

## In short

- The extension talks to one address only: `ws://127.0.0.1:8787`, the bridge on
  your own computer. It contains no analytics, no remote code and no remote
  assets.
- The bridge listens on the loopback interface only and refuses connections
  opened by web pages.
- Page content reaches Claude only because Claude Code asked the bridge for it
  during a session where you pasted this browser's pairing key.
- One optional feature, semantic targeting, sends page outlines to a third
  party. It is off unless you turn it on.

## The extension

| What | Detail |
|---|---|
| Reads | The page in the tab Claude is working in: its visible text, controls, links and, on request, HTML. Tab titles and addresses, to list tabs. |
| Acts | Clicks, typing, key presses, navigation and same-site requests in that tab, using the sessions you are signed in to. |
| Keeps in memory | The address, method, status and submitted form data (first 4,000 characters) of the last 300 requests made by pages, so Claude can find a page's own API. Cleared when the browser or the extension restarts. Never written to disk. |
| Stores | In extension storage: the pairing key and the selector of the last element you picked. |
| Sends | Only to the local bridge, and only in reply to a request from it. |
| Dialogs | Replaces `alert`, `confirm` and `prompt` on pages so a dialog cannot freeze the tab. `alert` is answered automatically and its text reported; `confirm` and `prompt` still wait for you unless Claude set an answer for the next one. |

It does not run in private/incognito windows unless you allow that in the
browser's extension settings.

## The bridge

| What | Detail |
|---|---|
| Network | Listens on `127.0.0.1:8787`. Accepts the extension and local command-line clients; a socket opened by a web page is refused. |
| Stores | `~/.browsteer/browsteer.db` (SQLite): an action log (time, page address, tool, element reference, outcome), saved snapshot filters, and learned "target → control" names per site. Text typed into fields is logged as a length only. Delete the file to clear everything. |
| Sends | Results go back to the Claude Code session over stdio. The bridge makes no network requests of its own unless semantic targeting is on. |

## Claude

Whatever the bridge returns becomes part of the Claude Code conversation and is
handled under the terms of your Claude plan, like any file or output Claude
reads. Browsteer adds nothing to that and sends nothing to Anthropic itself.

## Semantic targeting (optional)

`browser_find`, `browser_pursue` and `browser_do` can ask Jev, a model run by
TypeSafe, which control matches a description. Each such question sends the
page address, title and an outline of the page (control names and visible text,
up to 60,000 characters) to `api.typesafe.ai`.

This is off by default. It is on only if `~/.browsteer/config.json` contains
`{"jev": true}` or the hub is started with `BROWSTEER_JEV=1`, and a
`TYPESAFE_API_KEY` is present. The hub prints the current state when it starts.
Do not turn it on for pages whose content must not leave your organisation.

## Pairing key

The key (`bst-xxxx-xxxx`) selects which browser a session works in. Anyone who
can run commands on your computer and knows the key can operate that browser
profile through the bridge, so treat it like access to the profile. *New key*
in the popup replaces it immediately.

## Stopping

- *New key* in the popup ends the current pairing.
- Disabling or removing the extension ends all access.
- `bun run hub:stop` stops the bridge.
