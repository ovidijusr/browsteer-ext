# Releasing and updating

Browsteer has two halves that update separately:

| Half | Lives in | How it updates |
|---|---|---|
| **Extension** (Firefox) | the browser, installed from addons.mozilla.org | by itself: Firefox checks AMO about once a day |
| **Extension** (Chrome, or a temporary Firefox install) | `dist/chrome` / `dist/firefox`, loaded unpacked | `bun run update`, then **Reload** on the extensions page |
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
              4. GitHub release vX.Y.Z: the Chrome zip and the source archive
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
3. Push a tag.

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
