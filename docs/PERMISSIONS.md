# Permissions

Every permission in the manifest, what uses it, and what would break without
it. The text is written so it can be pasted into a Chrome Web Store or AMO
review form.

**Single purpose:** let a Claude Code session running on the same computer read
and operate the pages the user has open, through a local bridge the user starts.

| Permission | Used by | Why it is needed |
|---|---|---|
| `tabs` | `background.ts`: `tabs.query`, `tabs.get`, `tabs.update`, `tabs.sendMessage`, `tabs.create` | List open tabs with their titles and addresses so the user's session can choose one, address the chosen tab, navigate it, and open the setup page after install. |
| `storage` | `background.ts`, `content.ts`, `popup.ts` | Persist the pairing key, the user's access settings (allowed and blocked sites, read-only, when access ends) and the last element picked with the picker. Local only. |
| `alarms` | `background.ts` | Wake the background every 15–30 s to reconnect to the local bridge after it restarts and to show on the toolbar badge when the access hour has ended. Timers alone do not survive background suspension. |
| `webRequest` | `background.ts`: `onBeforeRequest`, `onCompleted`, `onHeadersReceived` | Observe (never block or modify) requests made by sites the user allowed, while access is on, to keep an in-memory list of the last 300: method, address, status, content type. Request bodies are not requested (`requestBody` is not used). This lets the assistant find the API call a page made instead of scraping. `onHeadersReceived` is also used, for the extension's own `browser_fetch` requests only, to read where a redirect points so that the next address can be checked before it is requested. |
| Host access `<all_urls>` | content script on every page; `fetch` from the background | The user decides at run time which sites to allow, so the content script that reads and operates the page must be available on any site; it reads and operates nothing on a site until the user allows that site in the popup. (It does add one empty, hidden marker element for the working indicator, and in Chrome wraps the page's dialog functions, on every page.) Also lets requests the user asks for carry that site's cookies. |

Chrome only:

| Key | Why |
|---|---|
| Content script with `"world": "MAIN"` (`dialogs-main.js`) | Page scripts call `alert`/`confirm`/`prompt` in the page's own JavaScript world; only a script in that world can answer them. The file does nothing else and has no access to extension APIs. |
| `minimum_chrome_version: 116` | From 116 an open WebSocket keeps the service worker alive, which the bridge link relies on. |

## Not requested

| Permission | Why not |
|---|---|
| `activeTab` | Redundant with host access. Removed in 1.7.0. |
| `scripting` | Nothing is injected at run time; all scripts are declared in the manifest. Removed in 1.7.0. |
| `webRequestBlocking`, `declarativeNetRequest` | Requests are observed, never altered. |
| `cookies`, `history`, `bookmarks`, `downloads`, `clipboardRead`, `nativeMessaging` | Not used. |

## Content security policy

```
script-src 'self'; object-src 'self'; connect-src ws://127.0.0.1:8787 https://*:* http://*:*
```

- No remote or inline scripts, no `eval`.
- `ws://127.0.0.1:8787` is the local bridge.
- `https://*:*` and `http://*:*` (any host, any port; without `:*` only ports 443 and 80 match, which breaks internal tools on other ports) allow the background to fetch a URL the user's
  session asks for (`browser_fetch`), for example a JSON export of the page
  being worked on. The extension makes no requests on its own.

## Remote code and data

- No remotely hosted code. Everything that runs is in the package and is built
  from `extension/src` by `scripts/build.ts` (see [BUILD.md](../BUILD.md)).
- No remote fonts, images or styles.
- Data handling is described in [PRIVACY.md](../PRIVACY.md). Firefox's
  `data_collection_permissions` is declared as `none`: the extension transmits
  nothing off the device.

## Kept honest by CI

`scripts/check-manifest.ts` runs in CI after the build and fails if either
manifest requests a permission, host pattern or CSP source that is not in the
list above, or if `externally_connectable` or web-accessible resources appear.
