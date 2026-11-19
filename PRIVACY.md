# Privacy

Browsteer has two parts: a browser extension, and a bridge (the "hub") that
runs on the same computer. This page says what each one can see, what it
keeps, and what leaves the machine.

## In short

- The extension talks to one address only: `ws://127.0.0.1:8787`, the bridge on
  your own computer. It contains no analytics, no remote code and no remote
  assets.
- The bridge listens on the loopback interface only, refuses connections
  opened by web pages, and requires a secret that only your user can read.
- Nothing is read until you allow access for an hour, and then only on sites
  you have allowed.
- Page content reaches Claude only when Claude Code asks the bridge for it, in
  a session where you pasted this browser's pairing key.
- One optional feature, semantic targeting, sends page outlines to a third
  party. It is off unless you turn it on.

## The extension

| What | Detail |
|---|---|
| Reads | The page in the tab Claude is working in, if its site is allowed: visible text, controls, links and, on request, HTML. Titles and addresses of tabs on allowed sites. Password field contents are never included. |
| Acts | Clicks, typing, key presses, navigation and same-site requests in that tab, using the sessions you are signed in to. |
| Keeps in memory | The address, method, status and content type of the last 300 requests sent to allowed sites, from any tab, while access is on, so Claude can find a page's own API. No request or response contents. Cleared when the browser or the extension restarts. Never written to disk. |
| Stores | In extension storage: the pairing key, your access settings (allowed and blocked sites, read-only, when access ends) the selector of the last element you picked, and whether the setup guide was finished. |
| Sends | Only to the local bridge, and only in reply to a request from it. |
| Dialogs | For one minute after each request from Claude, a page's `alert` is answered automatically and its text reported, so a dialog cannot freeze the tab; `confirm` and `prompt` still wait for you unless Claude set an answer for the next one. At all other times dialogs are the browser's own. |

It does not run in private/incognito windows unless you allow that in the
browser's extension settings.

## The bridge

| What | Detail |
|---|---|
| Network | Listens on `127.0.0.1:8787`. Accepts the one extension it is bound to, and local clients that present the secret in `~/.browsteer/token`. Sockets opened by web pages are refused. |
| Stores | `~/.browsteer/browsteer.db` (SQLite): an action log (time, page address, tool, element reference, the role and name the page gives that control, which browser and which Claude session it came from, outcome), saved snapshot filters, and learned "target → control" names per site. Text typed into fields is logged as a length only; options chosen in drop-downs are logged as chosen. Rows older than 30 days are removed when the hub starts and every six hours after (`logDays` in `~/.browsteer/config.json` changes this). The folder and its files are readable by your user only. Delete the file to clear everything. |
| Shows | The action log, in **Settings › Activity** of the extension: time, browser, site, what was done, and whether it worked, was refused or failed. Only the extension the bridge is bound to can ask for it, and only from its Settings page; Claude Code sessions cannot. Addresses are shown as host and path, without the query string or fragment. Typed text is never shown, only its length; options chosen in drop-downs, `browser_pursue` goals and `browser_do` steps are left out. |
| Sends | Results go back to the Claude Code session over stdio. The bridge makes no network requests of its own unless semantic targeting is on, or you ask for the model list or run Test in Settings. |

## Claude

Whatever the bridge returns becomes part of the Claude Code conversation and is
handled under the terms of your Claude plan, like any file or output Claude
reads. Browsteer adds nothing to that and sends nothing to Anthropic itself.

## Semantic targeting (optional)

`browser_find`, `browser_pursue` and `browser_do` can ask a language model which
control matches a description. Each such question sends the page address, title
and an outline of the page (control names and visible text, up to 60,000
characters) to the provider chosen in Settings:

- **TypeSafe Jev** (the default): `api.typesafe.ai`.
- **nexos.ai**: `api.nexos.ai`. **OpenRouter**: `openrouter.ai`, which passes it
  on to the company that runs the model you chose.
- **Local (Ollama)**: `127.0.0.1:11434`. Nothing leaves this computer.
- **Custom**: the address you typed. It must be `https://`, or `http://` on
  127.0.0.1 / localhost.

That provider's own privacy terms apply to what it receives. Settings names the
host that page outlines go to, and the hub prints it when it starts.

This is off by default. It is on only if `~/.browsteer/config.json` contains
`{"jev": true}` or the hub is started with `BROWSTEER_JEV=1`, and the provider
has a key (a provider on this computer needs none). You can switch it under
*More* in the popup, in Settings, or with `bun run setup`; the popup and Settings
show whether it is on, which provider answers, and whether the bridge has a key.
Keys stay on this computer: pasted into Settings (or, for TypeSafe, typed into
`bun run setup`), they are saved in `~/.config/typesafe/env` (TypeSafe) or
`~/.browsteer/keys.env` (the others), readable only by you, or can be set in the
bridge's environment (`TYPESAFE_API_KEY`, `NEXOS_API_KEY`, `OPENROUTER_API_KEY`).
The extension passes a pasted key to the bridge and does not keep it. **Test** in
Settings sends three sample pages written for the test, never one of yours. Do
not turn it on for pages whose content must not leave your organisation, unless
the provider is one your organisation runs or allows.

## Pairing key

The key (`bst-xxxx-xxxx-xxxx`) selects which browser a session works in, and
is required: the bridge never picks a browser by itself. It is generated from
the browser's cryptographic random source. A program on your computer that can
read `~/.browsteer/token` and knows the key can use the browser within the
limits you set in the popup, so treat the key like access to the profile.
*New key* replaces it immediately.

## Stopping

- *Stop now* in the popup closes access at once. Access also closes by itself after an hour.
- *New key* in the popup ends the current pairing.
- Disabling or removing the extension ends all access.
- `bun run hub:stop` stops the bridge.

See [SECURITY.md](SECURITY.md) for the full list of limits and what they do not cover.
