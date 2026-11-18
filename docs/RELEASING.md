# Releasing and updating

Browsteer has two halves that update separately:

| Half | Lives in | How it updates |
|---|---|---|
| **Extension** (Firefox) | the browser, as a Mozilla-signed `.xpi` | by itself: Firefox checks `update_url` about once a day |
| **Extension** (Chrome, or a temporary Firefox install) | `dist/chrome` / `dist/firefox`, loaded unpacked | `bun run update`, then **Reload** on the extensions page |
| **Bridge** (hub + per-session MCP shim) | this checkout | `bun run update` |

Both report their version to each other. The popup and `browser_pair` say when they
disagree, and a Claude Code session that started before an update is told to start a
new session.

## How a Firefox release reaches users

Firefox only installs extensions that Mozilla has signed. Mozilla's add-on site (AMO)
offers two channels:

- **Listed:** public on addons.mozilla.org; Mozilla reviews every version (can take days,
  and minified code needs a source upload); Firefox updates from AMO.
- **Unlisted** (what Browsteer uses): signed for self-distribution, not shown on
  addons.mozilla.org; signing is automated and usually takes minutes; *we* host the file
  and tell Firefox where to look for updates.

The flow for one release:

```
bump "version" in package.json ─▶ commit ─▶ git tag vX.Y.Z ─▶ git push origin main vX.Y.Z
                                                                   │
            .github/workflows/release.yml (on the tag) ◀───────────┘
              1. test, typecheck, build, permission check, lint   (no credentials)
              2. web-ext sign --channel unlisted                  (AMO credentials, this step only)
                 └─ uploads dist/firefox to AMO ─▶ Mozilla signs ─▶ signed .xpi comes back
              3. write updates.json (version, download link, sha256 of the .xpi)
              4. GitHub release vX.Y.Z: the .xpi, updates.json, the Chrome zip
                                                                   │
  Installed Firefoxes ── update_url ─▶ releases/latest/download/updates.json
                       ── newer version? ─▶ download the .xpi, check its sha256, install
```

The Firefox build's manifest carries
`update_url: https://github.com/ovidijusr/browsteer-ext/releases/latest/download/updates.json`.
`latest` always resolves to the newest release, so nothing has to be committed back to the
repository after a release. Firefox checks about once a day;
**about:addons → ⚙ → Check for Updates** checks now.

Every version number can be signed once only. A failed run after AMO has accepted the
upload means bumping to the next patch version.

### First install

Download `browsteer-firefox-X.Y.Z.xpi` from the
[latest release](https://github.com/ovidijusr/browsteer-ext/releases/latest) and open it in
Firefox (or drag it onto a Firefox window). From then on it updates by itself.

### Without the workflow

`bun run sign:firefox` with `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET` in the environment signs
from your machine (the `.xpi` lands in `artifacts/`). Then
`bun run updates-json artifacts/<file>.xpi` and attach both files to a GitHub release named
`vX.Y.Z`, with the `.xpi` renamed to `browsteer-firefox-X.Y.Z.xpi` first.

## Credentials

The only credential in the release process is the **AMO API key** (a JWT issuer, which looks
like `user:12345:67`, and its secret). It can sign new versions of every add-on on the
Mozilla account, so:

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
3. Push a tag. The first signed release is the one to install by hand (see above).

## Chrome

Chrome only auto-updates extensions installed from the Chrome Web Store. Until Browsteer is
there, a Chrome install is an unpacked folder: run `bun run update`, then press **Reload** on
`chrome://extensions`. The release also attaches `browsteer-chrome-X.Y.Z.zip`, which is the
file a Web Store submission takes.

## Updating the bridge

```sh
bun run update
```

This pulls (fast-forward only), installs the locked dependencies, rebuilds `dist/`, and
stops the running hub. The next `browser_*` call starts the new hub. Without this command,
a session whose code is newer than the running hub replaces the hub by itself. Sessions
that started before the update keep their old tools; their replies say to start a new
session.
