# Releasing and updating

Browsteer has two halves that update separately:

| Half | Lives in | How it updates |
|---|---|---|
| **Extension** (Firefox) | the browser, installed from addons.mozilla.org | by itself: Firefox checks AMO about once a day |
| **Extension** (Chrome, Edge, Brave from the Chrome Web Store) | the browser | by itself: Chrome checks the store every few hours |
| **Extension** (unpacked Chrome, or a temporary Firefox install) | `dist/chrome` / `dist/firefox`, loaded unpacked | `bun run update`, then **Reload** on the extensions page |
| **Bridge** (hub + per-session MCP shim) | this checkout | `bun run update` |

Both report their version to each other. The popup and `browser_pair` say when they
disagree, and a Claude Code session that started before an update is told to start a
new session.

## How a Firefox release reaches users

Firefox installs only extensions that Mozilla has signed. Mozilla's add-on site (AMO)
offers two channels:

- **Listed** (what Browsteer uses): public at
  <https://addons.mozilla.org/firefox/addon/browsteer/>. Mozilla reviews each version.
  Because the build is minified, each version is submitted with its source code.
  Firefox updates listed add-ons from AMO.
- **Unlisted:** signed for self-distribution and not shown on AMO. The publisher hosts
  the file and an `updates.json`, and the manifest carries `update_url`. AMO rejects
  `update_url` in listed versions, so the default build has none.

The flow for one release:

```
bump "version" in package.json ─▶ commit ─▶ git tag vX.Y.Z ─▶ git push origin main vX.Y.Z
                                                                   │
            .github/workflows/release.yml (on the tag) ◀───────────┘
              1. test, typecheck, build, permission check, lint   (no credentials)
              2. git archive the tagged source
              3. web-ext sign --channel listed                    (AMO credentials, this step only)
                 └─ uploads dist/firefox, the source archive, and .github/amo-metadata.json
              4. Chrome Web Store: upload the Chrome zip, submit for review
                                                                  (Google credentials, this step only)
              5. GitHub release vX.Y.Z: the Chrome zip and the source archive
                                                                   │
  Mozilla reviews the version (minutes to days) ─▶ AMO publishes it ─▶ Firefox installs update
```

The workflow does not wait for the review. The new version shows on AMO under
**Manage Status & Versions** right away and goes public when Mozilla approves it.
`.github/amo-metadata.json` holds the license, category, homepage, and the build notes
for reviewers. The listing text (summary and description) is edited on AMO itself.

Each version number can be submitted once only. If a run fails after AMO accepted the
upload, bump to the next patch version.

### A self-distributed build

To host your own signed build (a fork, for example): set `BROWSTEER_UPDATE_URL` to the
https address of your `updates.json` when building, sign with
`web-ext sign --channel unlisted`, run `bun run updates-json <signed .xpi>`, and publish
both files.

## Credentials

The release process uses two sets of credentials, kept the same way: the **AMO API key**
(below) and the **Chrome Web Store OAuth client** (see [Chrome](#chrome)).

The **AMO API key** is a JWT issuer, which looks like `user:12345:67`, and its secret. It can
sign new versions of every add-on on the Mozilla account, so:

- It is stored as two secrets, `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`, of a GitHub
  **environment** named `amo`, not as repository-wide secrets. Only a job that names the
  environment can read them.
- Only the signing step receives them, through its `env:`. Tests and the build run in the same
  job but never see them, and the publishing job does not have them at all.
- The workflow runs only for pushed `v*` tags, never for pull requests, so a fork's code
  never runs where the secrets are.
- Every action is pinned to a commit, and dependencies install with
  `--frozen-lockfile --ignore-scripts`. `web-ext` is a locked dev dependency, not fetched by
  `bunx` at run time.
- The repository never holds them: `.env`, `.env.*`, `.op.env`, `*.pem`, `*.xpi` and
  `.amo-upload-uuid` are ignored. Keep a local copy only in a password manager.
- If one leaks: revoke it at <https://addons.mozilla.org/developers/addon/api/key/>
  (generating a new one revokes the old one), then update the two secrets.

### One-time setup (repository owner)

1. AMO → *Tools → Manage API Keys* (<https://addons.mozilla.org/developers/addon/api/key/>):
   create or reuse a key.
2. GitHub → repository **Settings → Environments → New environment** `amo`:
   - **Deployment branches and tags:** *Selected* → add the tag rule `v*`.
   - **Required reviewers:** yourself (optional; each release then waits for one click).
   - **Environment secrets:** `AMO_JWT_ISSUER` = the JWT issuer, `AMO_JWT_SECRET` = the secret.
3. Push a tag.

## Chrome

Chrome, Edge and Brave auto-update extensions installed from the Chrome Web Store. The
release workflow's `chrome-web-store` job uploads `browsteer-chrome-X.Y.Z.zip` and submits
it for review; Google publishes the version when the review passes (usually hours to a few
days). Until the store item exists, the job is skipped and Chrome installs stay unpacked
(`bun run update`, then **Reload**).

The job talks to the [Chrome Web Store API v2](https://developer.chrome.com/docs/webstore/using-api)
with `curl` and `jq` only: it exchanges a refresh token for an access token, uploads the zip,
waits for processing, and calls `publish`.

### Credentials

An OAuth client (ID and secret) plus a refresh token for the Google account that owns the
store item. Together they can publish any item of that account, so they are kept like the AMO
key:

- Secrets `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET` and `CWS_REFRESH_TOKEN` of a GitHub
  environment named `chrome-web-store`. Only the upload step receives them, and the access
  token it gets is masked in the log.
- The publisher ID and the item ID are not secret. They are repository **variables**
  `CWS_PUBLISHER_ID` and `CWS_ITEM_ID`; the job runs only when both are set.
- If they leak: delete the OAuth client in Google Cloud (that also kills the refresh token),
  create a new one, and update the secrets.

### One-time setup (repository owner)

1. **Developer account.** Register at
   <https://chrome.google.com/webstore/devconsole> (a one-time registration fee) and turn on
   2-step verification for the Google account; publishing requires it.
2. **First version by hand.** The API cannot create items. In the dashboard choose
   **New item**, upload `browsteer-chrome-X.Y.Z.zip` from a GitHub release (or
   `bun run package`), and fill in:
   - **Store listing:** text from [store-listing.md](store-listing.md#chrome-web-store),
     the 128 px icon, at least one 1280×800 screenshot (`docs/store/`).
   - **Privacy:** single purpose, the permission justifications and the data-use answers,
     also in [store-listing.md](store-listing.md#chrome-web-store). Privacy policy URL:
     `https://github.com/ovidijusr/browsteer-ext/blob/main/PRIVACY.md`.
   - Submit for review. Note the **item ID** (32 letters, on the Package tab) and the
     **publisher ID** (Account → Publisher settings).
3. **OAuth client.** In <https://console.cloud.google.com>: create a project, enable the
   **Chrome Web Store API**, set up the OAuth consent screen (External, add yourself as a test
   user), and create an OAuth client of type *Web application* with the redirect URI
   `https://developers.google.com/oauthplayground`.
4. **Refresh token.** In <https://developers.google.com/oauthplayground>: gear icon → *Use your
   own OAuth credentials* (the client above), scope
   `https://www.googleapis.com/auth/chromewebstore`, authorise with the owner account,
   *Exchange authorization code for tokens*, copy the refresh token. While the consent screen
   is in *Testing*, Google expires refresh tokens after 7 days, so publish the consent screen
   (it stays unverified, which is fine for your own account).
5. **GitHub.** Environment `chrome-web-store` (tag rule `v*`, optional required reviewer) with
   the three secrets; repository variables `CWS_PUBLISHER_ID` and `CWS_ITEM_ID`.

From then on every pushed tag submits the new version.

### Store installs and the bridge

The bridge trusts the extension origins listed under `"extensions"` in
`~/.browsteer/config.json`, remembers the first one that connects, and also trusts the
official store builds listed in `STORE_EXTENSIONS` in `bridge/security.ts`. That list is
empty until the Chrome Web Store item exists. Once it does:

1. Add `"chrome-extension://<32-letter item ID>"` to `STORE_EXTENSIONS` (the item ID is on
   the dashboard's Package tab, and it is the ID a store install shows on
   `chrome://extensions`). Keep the comment there.
2. Ship it in the next release. A bridge with that version accepts a store install next to
   an unpacked one without a config change.

Only store IDs go in that list: a Chrome Web Store ID is the same on every computer. An
unpacked build's ID follows from its folder path and a Firefox install gets a random
`moz-extension://` UUID per profile, so those can never be listed; they rely on the
first-connect rule or on the person's `extensions` list. Edge Add-ons, if Browsteer is ever
published there, has its own item ID, which would be a second entry.

With an older bridge, or any other build, the popup shows *This bridge doesn't trust this
browser yet* with the exact origin, a *Copy prompt for Claude Code* button (add the origin
to `"extensions"`; nothing needs restarting), and the manual steps. The hub also prints the
origin when it refuses one.

## Updating the bridge

```sh
bun run update
```

This pulls (fast-forward only), installs the locked dependencies, rebuilds `dist/`, and
stops the running hub. The next `browser_*` call starts the new hub. Without this command,
a session whose code is newer than the running hub replaces the hub by itself. Sessions
that started before the update keep their old tools; their replies say to start a new
session.
