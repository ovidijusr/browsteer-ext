# Store listing

The text for the Browsteer page on addons.mozilla.org (AMO), and the GitHub
repository description. Paste each block into the matching field. The facts
here must agree with [SECURITY.md](../SECURITY.md) and
[PRIVACY.md](../PRIVACY.md). Change those first.

## Name

Proposed: **Browsteer for Claude Code** (25 characters; AMO allows 50).

The current name, "Browsteer", says nothing to someone who finds it in a
search. The longer name tells them what it works with. Before switching, check
that AMO and Anthropic's brand guidelines accept "for Claude Code" in a
third-party name.

## Summary

AMO limit: 250 characters. This one is 166.

```text
Let Claude Code read and use pages in your signed-in Firefox. Locked by default: you allow it for an hour, on the sites you choose, one site per session. Open source.
```

## Description

AMO renders a small Markdown subset: bold, italics, lists, and links. It has no
headings, so the section titles are bold lines.

```markdown
Browsteer is open source. It lets Claude Code read and use the pages in the Firefox where you are already signed in. Use it to fill in a form on a site with no API, compare listings across tabs, or read a dashboard behind single sign-on.

**Locked until you allow it**

- Nothing happens until you click "Allow ‹site› and open for 1 hour". "Stop now" ends access at once.
- Claude works only on the sites you allow, and on one site per session.
- Read-only mode lets Claude look without clicking or typing.
- Claude must say that you agreed before it clicks buttons such as delete, pay, or send.
- Password fields are always masked.

Only you can change these settings, in the toolbar popup, so a page that tries to trick Claude cannot lift them.

**Stays on your computer**

The extension talks only to the Browsteer bridge at 127.0.0.1, which needs a secret token and this browser's pairing key. It has no analytics and collects no data. What Claude reads becomes part of your Claude Code conversation.

**What you need**

Claude Code, Bun 1.3 or newer, and the bridge from [GitHub](https://github.com/ovidijusr/browsteer-ext) (MIT license). The README has setup, and SECURITY.md has the full security model.
```

About 206 words, down from 510 in the 2.0.1 listing.

## Tags

AMO offers a fixed list of tags. Pick the closest matches to these ideas:

- AI
- automation
- developer tools

## GitHub repository

Description (140 characters):

```text
Let Claude Code read and use pages in your signed-in Chrome or Firefox, on the sites you allow. A browser extension plus a local MCP bridge.
```

Topics: keep the current 16. Add `browser-mcp`, a common name for this kind
of tool. `llm` adds nothing that `ai-agent` and
`claude` don't already say, so it can go.

## Chrome Web Store

### Summary

Store limit: 132 characters.

```text
Let Claude Code read and use pages in your signed-in browser. Locked by default: you allow each site, one hour at a time. Open source.
```

### Description

Plain text, no Markdown.

```text
Browsteer is open source. It lets Claude Code read and use the pages in the browser where you are already signed in: fill in a form on a site with no API, compare listings across tabs, or read a dashboard behind single sign-on.

Locked until you allow it
- Nothing happens until you click "Allow <site> and open for 1 hour". Stop now ends access at once.
- Claude works only on the sites you allow, and on one site per session.
- Read only lets Claude look without clicking or typing.
- Claude must say that you agreed before it clicks buttons such as delete, pay or send.
- Password fields are always masked.
Only you can change these settings, so a page that tries to trick Claude cannot lift them.

Stays on your computer
The extension talks only to the Browsteer bridge at 127.0.0.1, which needs a secret token and this browser's pairing key. It has no analytics and collects no data. What Claude reads becomes part of your Claude Code conversation.

What you need
Claude Code, Bun 1.3 or newer, and the bridge from https://github.com/ovidijusr/browsteer-ext (MIT license).
```

Category: Developer Tools. Language: English.

### Privacy tab

**Single purpose:** Let the user's own Claude Code session read and operate web pages in this
browser, on sites the user allows, through a bridge program running on the same computer.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `tabs` | List the user's tabs (allowed sites only) and target the tab Claude works in. |
| `storage` | Keep the user's settings: allowed and blocked sites, access time, read-only mode, the pairing key. |
| `alarms` | Keep the connection to the local bridge alive, and update the toolbar badge when the hour is up. |
| `webRequest` | Record the requests a page makes on allowed sites, so Claude can read a page's own data API when asked. |
| Host permission `<all_urls>` | The user chooses which sites to allow at run time; the extension does nothing on a site until the user allows it. |

**Remote code:** No. All code is in the package.

**Data use:** none of the categories is collected or sent to the developer. Page content goes
only to the bridge on the user's own computer, and from there into the user's own Claude Code
conversation. Certify the three disclosures (no selling, no unrelated use, no credit
decisions).

Privacy policy: `https://github.com/ovidijusr/browsteer-ext/blob/main/PRIVACY.md`

