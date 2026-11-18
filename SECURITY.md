# Security model

Browsteer gives an AI assistant hands inside a browser that is signed in to
your accounts. This page states what stands between "Claude can help with the
page I am looking at" and "something can use my browser", and what does not.

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
| Access window | locked | Nothing is read or done until *Allow Claude for 1 hour*; it closes by itself. |
| Sites | none allowed | A page is readable and operable only if its site is allowed and not blocked. Other tabs are not even listed by name. |
| Read only | off | When on: snapshots and reads only; no clicks, typing, navigation or non-GET requests. |
| Passwords | always | Password field contents are masked in snapshots, form reports, reads and HTML. |
| Commitment buttons | always | Controls named like delete, pay, send, sign out, and real buttons with no name at all, are not activated by `browser_click` (by ref or by coordinates, including inside web components) or by Enter/Space in `browser_press`, unless the call carries `confirm: true`, which Claude is instructed to set only after asking. Enter in a form field is judged by the form's submit button. |
| Working indicator | always | A bar across the top of the tab while requests arrive. Page styles cannot hide it; a page script could remove the element, so the toolbar badge is the indicator to trust. |

These are enforced in the bridge:

| Limit | Default | Effect |
|---|---|---|
| One site per session | on | A session stays on the site of the first page it touched. The bridge names that site with every request and the extension refuses to read, click, type or navigate in a tab on any other site, before anything happens. Lifted once by *Let Claude switch site* in the popup. |
| `browser_fetch` | GET/HEAD, same site, checked redirects | No state-changing requests and no requests to other sites. A redirect is followed one hop at a time, and each hop must pass the same checks as the first address (allowed, not blocked, same site) before it is requested, so an open redirect on the allowed site cannot carry cookies or data elsewhere. At most 5 hops. `saveTo` only writes inside one download folder. |
| Log | 30 days, owner-only | Typed text is logged as a length; request bodies are never captured. |

## Prompt injection

Page text is untrusted input to the model: a page can contain "ignore your
instructions and…". Nothing can stop a model from reading that. What the design
does is bound the damage if the model is fooled:

- it cannot leave the site the session started on, or reach a site you did not allow;
- it cannot send data elsewhere with `browser_fetch`;
- it cannot press a button that sounds final without stating that you agreed;
- it cannot widen any of these limits, because they are not reachable from the bridge.

A fooled model can still act **within the allowed site**: for example, change a
setting through ordinary controls that do not sound risky. Use *Read only* when
you only need Claude to look, and do not allow sites where that risk is not
acceptable.

## What this does not protect against

- **Malware running as you.** A process with your user's rights can read the
  token, the browser profile and everything else. Browsteer adds no exposure
  there, and no protection.
- **"Site" is an approximation.** It is the registrable domain worked out without the full public-suffix list: `app.example.com` and `example.com` are one site; subdomains of common hosting platforms (`github.io`, `vercel.app` and similar, listed in `extension/src/site.ts`) are separate sites. A platform missing from that list is treated as one site.
- **The first extension to connect is trusted.** On a fresh install, start the browser with Browsteer before anything else on the machine could register. A local program that fakes an extension address can only register its own key; it cannot answer requests sent to your browser.
- **Sites can tell the extension is installed**, even while it is locked: an empty marker element is added to pages, and in Chrome the dialog functions are wrapped.
- **A leaked pairing key plus local access.** Both are needed; *New key*
  invalidates the key at once.
- **What Claude does with what it reads.** Page content returned to the session
  goes to Anthropic like the rest of the conversation.
- **Semantic targeting, if you turn it on.** Page outlines then go to TypeSafe.

## Configuration

`~/.browsteer/config.json`. Every key is optional; these are the defaults.

```json
{
  "jev": false,
  "extensions": [],
  "siteLock": true,
  "fetchWrite": false,
  "fetchAnySite": false,
  "downloadDir": "~/Downloads/browsteer",
  "logDays": 30
}
```

`extensions` is filled in with the first extension that connects. After
reinstalling the extension in Firefox (its internal address changes), or when
adding a second browser, add the origin the hub prints when it refuses it.

## Releases and updates

The Firefox build checks
`https://github.com/ovidijusr/browsteer-ext/releases/latest/download/updates.json`
for new versions, over https only, and installs one only if Mozilla signed it and its
sha256 matches the one in `updates.json`. Releases are built and signed by
`.github/workflows/release.yml` from a pushed tag. The Mozilla signing key is a
secret of a GitHub environment that only the signing step can read, and pull requests
never run that workflow. Details: [docs/RELEASING.md](docs/RELEASING.md).

## Reporting a problem

Open a private security advisory on the repository, or contact the owner
directly. Please do not file public issues for vulnerabilities.
