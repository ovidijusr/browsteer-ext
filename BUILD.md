# Build instructions

Both extension packages are produced from the TypeScript in `extension/src/`
with [Bun](https://bun.sh)'s bundler. No other tooling is involved.

## Environment

- macOS, Linux or Windows.
- **Bun 1.3 or newer** (built and tested with 1.3.9). No Node.js needed.
  ```sh
  curl -fsSL https://bun.sh/install | bash          # macOS / Linux
  powershell -c "irm bun.sh/install.ps1 | iex"      # Windows
  ```
- The extension has no runtime dependencies. `bun install` fetches type
  definitions and the bridge's dependencies only.

## Build

```sh
bun install
bun run build          # dist/firefox and dist/chrome, minified
bun run package        # also zips them into artifacts/
```

`scripts/build.ts` does three things per browser:

1. Bundles each entry point to a classic (IIFE) script with `Bun.build`,
   minified, no source maps.
2. Copies `popup.html`, `welcome.html`, `ui.css` and `icons/` unchanged.
3. Writes `manifest.json` from `extension/manifest.base.json`, adding the
   version from `package.json` and the browser-specific keys.

## Source to output

| Source | Output | In |
|---|---|---|
| `extension/src/background.ts` | `background.js` | both |
| `extension/src/content.ts` (+ `snapshot.ts`, `fallback.ts`, `dialogs.ts`) | `content.js` | both |
| `extension/src/popup.ts` (+ `keyview.ts`) | `popup.js` | both |
| `extension/src/welcome.ts` (+ `keyview.ts`) | `welcome.js` | both |
| `extension/src/dialogs-main.ts` (+ `dialogs.ts`) | `dialogs-main.js` | Chrome only |
| `extension/src/ext.ts` | bundled into each of the above | both |

## What differs between the two packages

| | Firefox | Chrome |
|---|---|---|
| Background | `background.scripts` (event page) | `background.service_worker` |
| Dialog handling | exported into the page by the content script | `dialogs-main.js` as a `"world": "MAIN"` content script |
| Extra manifest keys | `browser_specific_settings.gecko` | `minimum_chrome_version` |

Everything else, including every other line of JavaScript, is identical.

## Release

1. Bump `version` in `package.json` and commit.
2. `git tag vX.Y.Z && git push origin main vX.Y.Z`
3. `.github/workflows/release.yml` tests, builds, submits the Firefox build to
   addons.mozilla.org (listed) with a source archive, and publishes a GitHub
   release with the Chrome zip and the source archive. Firefox installs update
   from AMO once Mozilla approves the version.

The whole flow, the credentials it uses and the one-time setup:
[docs/RELEASING.md](docs/RELEASING.md).
