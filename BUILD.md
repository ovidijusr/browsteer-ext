# Build instructions — Browsteer extension

The extension's `dist/*.js` files are produced from the TypeScript in
`extension/src/` using [Bun](https://bun.sh)'s bundler/minifier. No other tooling.

## Build environment

- **OS:** macOS, Linux, or Windows (built/tested on macOS 15, arm64).
- **Only required program: Bun ≥ 1.3** (built with **Bun 1.3.9**). Install it with:
  ```sh
  curl -fsSL https://bun.sh/install | bash      # macOS / Linux
  # or: npm i -g bun   |   Windows: powershell -c "irm bun.sh/install.ps1 | iex"
  ```
  No Node.js/npm required. The extension has **no runtime dependencies**; `bun install`
  only fetches TypeScript type-definitions used at build time.

## One-step build script

```sh
./build.sh        # runs: bun install && bun run build:prod
```

## Reproduce the packaged add-on

Requires **Bun ≥ 1.3** (the build was made with Bun 1.3.9).

```sh
bun install            # installs dev type-defs only (no runtime deps in the extension)
bun run build:prod     # → extension/dist/{content,background,popup}.js  (minified)
```

`build:prod` runs exactly:

```sh
bun build extension/src/content.ts extension/src/background.ts extension/src/popup.ts \
  --outdir extension/dist --target browser --minify --sourcemap=none
```

The add-on package is the `extension/` folder — `manifest.json`, `popup.html`,
`icon.svg`, and the three generated `dist/*.js` files. To reproduce the exact
zip that was submitted:

```sh
bun run package        # = build:prod + `web-ext build --ignore-files "src/**"`
```

## Source ↔ output mapping

| Source | Output in the add-on |
|--------|----------------------|
| `extension/src/content.ts`    | `extension/dist/content.js`    |
| `extension/src/background.ts` | `extension/dist/background.js` |
| `extension/src/popup.ts`      | `extension/dist/popup.js`      |

Each source file is self-contained (no local imports); the build only
transpiles TypeScript → JavaScript and minifies. `browser` is the WebExtension
global provided by the browser at runtime.
