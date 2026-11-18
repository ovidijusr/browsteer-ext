# UI: screenshots and the harness

The screenshots here show the popup, the setup guide and Settings, taken from the
UI harness at popup width (340 px) and at 1440 px for the pages.

| File | State |
|---|---|
| `01-setup-1-connect.png` | Setup guide, step 1 |
| `03-setup-2-allow-site.png` | Setup guide, step 2 |
| `04-setup-3-key.png` | Setup guide, step 3 |
| `06-setup-done.png` | Setup guide, finish |
| `09-popup-locked-site-not-allowed.png` | Popup, locked, site not allowed yet |
| `12-popup-open-working.png` | Popup, open, Claude paired |
| `13-popup-open-more-expanded.png` | Popup, open, More expanded |
| `14-popup-last-5-minutes.png` | Popup, under five minutes left |
| `17-popup-dangerous-settings-on.png` | Popup, both dangerous settings on |
| `22-popup-open-dark.png`, `24-popup-locked-dark.png` | Popup, dark mode |
| `25-settings-defaults-empty.png` | Settings, defaults |
| `26-settings-confirm-dangerous.png` | Settings, confirming a dangerous option |
| `29-settings-lists-and-jev-on-dark.png` | Settings, sites listed, semantic targeting on, dark |

## The harness

`test/ui/serve.ts` serves the built popup, setup guide and Settings in an ordinary
browser tab, with a stand-in for the extension API (`test/ui/stub.js`) and canned
states. No extension, bridge or browser profile is involved, and buttons work:
they change the canned state the way `background.ts` would.

```sh
bun run build
bun run test/ui/serve.ts                 # http://127.0.0.1:8790/ lists every state
```

Pages are `/popup.html?state=<name>&theme=light|dark`, `/welcome.html?…` and
`/options.html?…`. Extra parameters: `&open=more` opens every disclosure,
`&click=id1,id2` clicks elements after load, `&focus=id` gives one keyboard
focus, `&type=id:text` fills a field, `&stuck` shows the setup guide's
"taking long" help at once. `theme` forces the colour scheme.

For a full-page screenshot with headless Chrome or Edge, set the window to the
popup width and add `--virtual-time-budget=2500` so the clicks and timers run:

```sh
msedge --headless=new --window-size=340,700 --virtual-time-budget=2500 \
  --screenshot=popup.png "http://127.0.0.1:8790/popup.html?state=allowed&theme=light"
```
