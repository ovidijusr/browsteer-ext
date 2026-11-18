// Stand-in for the WebExtensions API, so popup.html and welcome.html can run in an
// ordinary tab with canned state. Loaded by test/ui/serve.ts before the page's own
// script. The state comes from ?state=<name>; buttons change it the way
// background.ts would, so the pages can be clicked through.
(() => {
  const params = new URLSearchParams(location.search);
  const name = params.get("state") || "locked";
  const VERSION = "__VERSION__"; // filled in by serve.ts from package.json
  const soon = Date.now() + 42 * 60_000;

  const base = () => ({
    key: "bst-ab12-cd34-ef56",
    connected: true,
    version: VERSION,
    hubVersion: VERSION,
    bridgeDir: "/Users/sam/code/browsteer-ext",
    firefox: false,
    settings: { armedUntil: 0, alwaysOn: false, readOnly: false, siteMode: "allow", allow: [], block: [] },
    site: { host: "github.com" },
    jev: { on: false, keyPresent: false, envOverride: false },
    setupDone: true,
    pairedAt: 0,
  });

  // Each state is a change to the base. Popup and setup page states share the list.
  const STATES = {
    "bridge-off": (s) => { s.connected = false; s.hubVersion = null; s.jev = null; },
    // A fresh install: the popup offers only "Finish setup".
    fresh: (s) => { s.connected = false; s.hubVersion = null; s.jev = null; s.setupDone = false; },
    // The setup guide, one state per step.
    "setup-1": (s) => { s.connected = false; s.hubVersion = null; s.jev = null; s.setupDone = false; },
    "setup-2": (s) => { s.setupDone = false; },
    "setup-3": (s) => { s.setupDone = false; s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; },
    "setup-finished": () => {},
    locked: () => {},
    "locked-allowed": (s) => { s.settings.allow = ["github.com"]; },
    ending: (s) => { s.settings.armedUntil = Date.now() + 4 * 60_000; s.settings.allow = ["github.com"]; },
    "jev-ready-on": (s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com", "linear.app"]; s.settings.block = ["mybank.example"]; s.jev = { on: true, keyPresent: true, envOverride: false }; },
    armed: (s) => { s.settings.armedUntil = soon; },
    allowed: (s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; s.pairedAt = Date.now() - 3 * 60_000; },
    "long-host": (s) => { s.settings.armedUntil = soon; s.site = { host: "dashboard.internal-analytics.example-company.com" }; },
    blocked: (s) => { s.settings.armedUntil = soon; s.settings.block = ["github.com"]; },
    "read-only": (s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; s.settings.readOnly = true; },
    "bridge-old": (s) => { s.hubVersion = "2.0.1"; s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; },
    "firefox-old": (s) => { s.firefox = true; s.hubVersion = VERSION.replace(/^\d+/, (m) => String(+m + 1)); s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; },
    mismatch: (s) => { s.hubVersion = VERSION.replace(/^\d+/, (m) => String(+m + 1)); s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; },
    "no-site": (s) => { s.settings.armedUntil = soon; s.site = null; },
    "every-site": (s) => { s.settings.armedUntil = soon; s.settings.siteMode = "block"; },
    "always-on": (s) => { s.settings.alwaysOn = true; s.settings.armedUntil = 8_640_000_000_000_000; s.settings.allow = ["github.com"]; },
    "wide-open": (s) => { s.settings.alwaysOn = true; s.settings.armedUntil = 8_640_000_000_000_000; s.settings.siteMode = "block"; s.settings.block = ["mybank.example"]; },
    "jev-key-off": (s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; s.jev = { on: false, keyPresent: true, envOverride: false }; },
    "jev-on": (s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; s.jev = { on: true, keyPresent: true, envOverride: false }; },
    "jev-no-key": (s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; s.jev = { on: true, keyPresent: false, envOverride: false }; },
    picked: (s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; },
    "setup-done":(s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com", "linear.app"]; s.settings.block = ["mybank.example"]; },
  };

  const state = base();
  (STATES[name] || (() => {}))(state);
  if (params.get("open") === "more") document.addEventListener("DOMContentLoaded", () => {
    for (const d of document.querySelectorAll("details")) d.open = true;
  });
  // &click=id1,id2 clicks those elements after the page has drawn (copied, confirm and error states);
  // &focus=id gives one keyboard focus; &type=id:text fills a field first.
  window.addEventListener("load", () => setTimeout(() => {
    const t = params.get("type");
    if (t) { const [id, ...v] = t.split(":"); const el = document.getElementById(id); if (el) el.value = v.join(":"); }
    for (const id of (params.get("click") || "").split(",").filter(Boolean)) document.getElementById(id)?.click();
    const f = params.get("focus");
    if (f) document.getElementById(f)?.focus();
  }, 300));

  const covers = (e, h) => h === e || h.endsWith(`.${e}`);
  const status = () => {
    const s = JSON.parse(JSON.stringify(state));
    s.armed = s.settings.armedUntil > Date.now();
    if (s.site) {
      const h = s.site.host;
      const blocked = s.settings.block.some((e) => covers(e, h));
      s.site = { host: h, blocked, allowed: !blocked && (s.settings.siteMode === "block" || s.settings.allow.some((e) => covers(e, h))) };
    }
    return s;
  };
  const without = (l, h) => l.filter((e) => e !== h);

  async function sendMessage(msg) {
    const st = state.settings;
    switch (msg.type) {
      case "arm": st.armedUntil = st.alwaysOn ? 8_640_000_000_000_000 : Date.now() + 60 * 60_000; break;
      case "setAlwaysOn": st.alwaysOn = msg.value === true; if (st.armedUntil > Date.now()) st.armedUntil = st.alwaysOn ? 8_640_000_000_000_000 : Math.min(st.armedUntil, Date.now() + 60 * 60_000); break;
      case "removeJevKey": if (state.jev) { state.jev.keyPresent = false; state.jev.on = false; } break;
      case "setJevKey": if (state.jev) { state.jev.keyPresent = true; state.jev.on = true; } break;
      case "disarm": st.armedUntil = 0; break;
      case "setReadOnly": st.readOnly = msg.value === true; break;
      case "setSiteMode": st.siteMode = msg.value === "block" ? "block" : "allow"; break;
      case "allowSite": st.allow = [...without(st.allow, msg.host), msg.host]; st.block = without(st.block, msg.host);
        if (msg.open && !(st.armedUntil > Date.now())) st.armedUntil = st.alwaysOn ? 8_640_000_000_000_000 : Date.now() + 60 * 60_000; break;
      case "blockSite": st.block = [...without(st.block, msg.host), msg.host]; st.allow = without(st.allow, msg.host); break;
      case "forgetSite": st.allow = without(st.allow, msg.host); st.block = without(st.block, msg.host); break;
      case "regenerate": state.key = "bst-pq4r-mn8s-tv2w"; break;
      case "setJev": if (state.jev) state.jev.on = msg.value === true; break;
      case "finishSetup": state.setupDone = true; break;
    }
    return status();
  }

  const api = {
    runtime: {
      id: "harness",
      sendMessage,
      getManifest: () => ({ version: VERSION }),
      getURL: (p) => new URL(p, location.href).href,
      openOptionsPage: async () => { location.href = `/options.html${location.search}`; },
    },
    tabs: {
      create: async ({ url }) => { location.href = url + location.search; },
      getCurrent: async () => null,
      remove: async () => {},
    },
    storage: { local: {
      get: async (k) => (k === "lastPick" && name === "picked" ? { lastPick: { selector: "main .repo-list > li", matchCount: 12 } } : {}),
      set: async () => {},
    } },
  };
  // Screenshots: no transitions caught half-way, and a clipboard that always works.
  document.addEventListener("DOMContentLoaded", () => {
    const st = document.createElement("style");
    st.textContent = "*,*::before,*::after{transition:none!important;animation-duration:0s!important}";
    document.head.append(st);
  });
  try { Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => {} } }); } catch {}
  // &stuck shows the "taking long" help in the setup guide at once.
  if (params.has("stuck")) globalThis.__browsteerPatienceMs = -1;
  // ext.ts takes `browser` first, then `chrome`.
  globalThis.chrome = api;
  globalThis.close = () => console.log("[harness] window.close()");
})();
