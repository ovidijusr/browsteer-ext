# Security model

Browsteer lets an AI assistant read and operate a browser that is signed in
to your accounts. This page lists what keeps that access limited to "Claude can
help with the page I am looking at", and what it does not protect against.

## Who is kept out

| Who | What stops them |
|---|---|
| A web page, in any browser, opening a socket to the bridge | The bridge refuses any connection whose `Origin` is a web address. |
| Another browser extension | The bridge is bound to the first Browsteer extension that registers (`extensions` in `~/.browsteer/config.json`) and refuses others. Extensions can never act as a controller. |
| Another device on the network | The bridge listens on `127.0.0.1` only. |
| Another user account on this computer, or a process that cannot read your home folder | Controllers must present the secret in `~/.browsteer/token` (mode 600). |
| A local program that reaches the bridge but has no pairing key | There is no default browser. Without `browser_pair` and the right key nothing is targeted, and a wrong key is not answered with a list of right ones. |
| A page that addresses the extension directly | The manifest declares no `externally_connectable` and no web-accessible resources; settings messages are accepted from the extension's own pages only. |

## What limits a session that is let in

These are enforced in the extension, from settings only the person can change
in the popup. Neither Claude nor the bridge has a message that alters them.

| Limit | Default | Effect |
|---|---|---|
| Access window | locked, one hour at a time | Nothing is read or done until you open access in the popup (*Allow ‹site› and open for 1 hour*, or *Open access for 1 hour* on a site already allowed). Access then closes by itself after the hour; *Stop now* closes it at once. Settings offers *Until I press Stop* instead, marked dangerous; choosing it needs a confirmation. |
| Sites | none allowed | A page is readable and operable only if its site is allowed and not blocked. Other tabs are not even listed by name. Settings offers *Every site, except the ones I block*, marked dangerous; choosing it needs a confirmation. |
| Wide settings in sight | always | While either dangerous setting is on, the popup's status card turns red, says so, and links to the setting. |
| Read only | off | When on: snapshots and reads only; no clicks, typing, navigation or non-GET requests. Chosen in the popup before access opens. |
| Passwords | always | Password field contents are masked in snapshots, form reports, reads and HTML. |
| Commitment buttons | always | Controls named like delete, pay, send, or sign out, and real buttons with no name at all, are not activated by `browser_click` (by ref or by coordinates, including inside web components) or by Enter or Space in `browser_press`. The exception is a call that carries `confirm: true`, which Claude is instructed to set only after asking you. Enter in a form field is judged by the form's submit button. |
| Working indicator | always | A bar across the top of the tab while requests arrive. Page styles cannot hide it, but a page script could remove the element, so the toolbar badge is the indicator to trust: it shows a ✓ exactly while Claude may act (bridge connected, access open) and nothing otherwise. |

These are enforced in the bridge:

| Limit | Default | Effect |
|---|---|---|
| One site per session | on | A session stays on the site of the first page it touched. The bridge names that site with every request and the extension refuses to read, click, type or navigate in a tab on any other site, before anything happens. Lifted once by *More › Let Claude move to another site* in the popup. |
| `browser_fetch` | GET/HEAD, same site, checked redirects | No state-changing requests and no requests to other sites. A redirect is followed one hop at a time, and each hop must pass the same checks as the first address (allowed, not blocked, same site) before it is requested, so an open redirect on the allowed site cannot carry cookies or data elsewhere. At most 5 hops. `saveTo` only writes inside one download folder. |
| `browser_upload` | upload folder only, 10 MB | The one tool that sends a file from this computer to a page. It reads only from `uploadDir` (`~/Downloads/browsteer-upload`): a path outside it, or a link inside it that points outside, is refused before the browser hears of it. Folders and files over 10 MB are refused. It counts as a change, so read-only mode refuses it, and it works only on allowed sites within the session's one site, like a click. Claude can still copy a file into the folder with its own tools; Claude Code's permission prompts govern that step, not Browsteer. The log keeps file names and sizes, never contents. |
| Log | 30 days, owner-only | Typed text is logged as a length; request bodies are never captured. |

## Prompt injection

Page text is untrusted input to the model: a page can contain "ignore your
instructions and…". Nothing can stop a model from reading that. What the design
does is bound the damage if the model is fooled:

- it cannot leave the site the session started on, or reach a site you did not allow;
- it cannot send data elsewhere with `browser_fetch`;
- it cannot press a button that sounds final without stating that you agreed;
- it cannot widen any of these limits, because they are not reachable from the bridge;
- it cannot turn on semantic targeting, which only the extension's own pages and the terminal can change (below).

A fooled model can still act **within the allowed site**: for example, change a
setting through ordinary controls that do not sound risky. Use *Read only* when
you only need Claude to look, and do not allow sites where that risk is not
acceptable.

## What this does not protect against

- **Malware running as you.** A process with your user's rights can read the
  token, the browser profile and everything else. Browsteer adds no exposure
  there, and no protection.
- **"Site" is an approximation.** It is the registrable domain worked out without the full public-suffix list: `app.example.com` and `example.com` are one site; subdomains of common hosting platforms (`github.io`, `vercel.app` and similar, listed in `extension/src/site.ts`) are separate sites. A platform missing from that list is treated as one site.
- **The first extension to connect is trusted.** On a fresh install, start the browser with Browsteer before anything else on the machine could register. A local program that fakes an extension address can only register its own key; it cannot answer requests sent to your browser. If it fakes the address of *your* extension (a Chrome unpacked ID follows from the folder path), it can also flip the semantic targeting switch or save a TypeSafe API key of its choosing, since the extension has no secret to prove itself with. A program running as you could write those files directly anyway; this matters on a computer shared with other accounts. The bridge logs every change and the popup shows the current state.
- **Sites can tell the extension is installed**, even while it is locked: an empty marker element is added to pages, and in Chrome the dialog functions are wrapped.
- **A leaked pairing key plus local access.** Both are needed; *New key*
  invalidates the key at once.
- **What Claude does with what it reads.** Page content returned to the session
  goes to Anthropic like the rest of the conversation.
- **Semantic targeting, if you turn it on.** Page outlines then go to TypeSafe.

## Semantic targeting switch

Semantic targeting (Jev) is a setting of the bridge, not of the extension:
`"jev"` in `~/.browsteer/config.json`, off by default. When on, page outlines go
to TypeSafe (see [PRIVACY.md](PRIVACY.md)). Three places can change it:

- the switch under *More* in the popup, and the one in Settings (the extension's options page).
  These send the bridge a `setJev` message. It and `setJevKey` (below) are the
  only bridge settings the extension can change. The bridge accepts it only from the extension socket
  that registered a browser (so only the bound extension, after it passed the
  origin check), never from a controller: Claude, the MCP shim and `cli.ts`
  have no way to send it. Like every other settings message, the background
  accepts the request only from the extension's own pages, not from content scripts.
- `bun run setup`, in the terminal.
- editing `config.json`, or `BROWSTEER_JEV=1`/`0` in the bridge's environment,
  which overrides the saved value.

The API key can be pasted into Settings or typed into `bun run setup` (hidden
input). From Settings it goes one way: page, background, `setJevKey` to the
bridge, which writes it to `~/.config/typesafe/env` with mode 600 (on Windows the
file inherits your profile folder's permissions instead) and turns semantic
targeting on. The extension does not store it, and the bridge never sends it
back: it tells the extension only whether a key exists. The same checks as
`setJev` apply: own pages only, the registered extension socket only, never a
controller. Keys with spaces or line breaks are refused, so a key cannot add
lines to the file.

## Configuration

`~/.browsteer/config.json`. Every key is optional; these are the defaults. The
bridge writes `extensions` (below) and `jev` (the switch above) itself and keeps
everything else you put there.

```json
{
  "jev": false,
  "extensions": [],
  "siteLock": true,
  "fetchWrite": false,
  "fetchAnySite": false,
  "downloadDir": "~/Downloads/browsteer",
  "uploadDir": "~/Downloads/browsteer-upload",
  "logDays": 30
}
```

`extensions` is filled in with the first extension that connects. After
reinstalling the extension in Firefox (its internal address changes), or when
adding a second browser, add the origin the hub prints when it refuses it.

## Releases and updates

Firefox installs and updates Browsteer from addons.mozilla.org, which signs
each version after Mozilla's review. Releases are built and submitted by
`.github/workflows/release.yml` from a pushed tag, together with the exact source
archive, so a reviewer can rebuild and compare. The Mozilla signing key is a
secret of a GitHub environment that only the signing step can read, and pull requests
never run that workflow. Details: [docs/RELEASING.md](docs/RELEASING.md).

## Reporting a problem

Open a private security advisory on the repository, or contact the owner
directly. Please do not file public issues for vulnerabilities.
