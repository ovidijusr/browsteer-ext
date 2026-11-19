// Stand-in for the WebExtensions API, so popup.html and welcome.html can run in an
// ordinary tab with canned state. Loaded by test/ui/serve.ts before the page's own
// script. The state comes from ?state=<name>; buttons change it the way
// background.ts would, so the pages can be clicked through.
(() => {
  const params = new URLSearchParams(location.search);
  const name = params.get("state") || "locked";
  const VERSION = "__VERSION__"; // filled in by serve.ts from package.json
  const soon = Date.now() + 42 * 60_000;

  // The targeting provider as the bridge reports it (bridge/targeting.ts targetingInfo).
  const PROVIDERS = {
    typesafe: { provider: "typesafe", preset: "nexos", label: "TypeSafe Jev", baseUrl: "https://api.typesafe.ai", host: "api.typesafe.ai", local: false, model: "jev-1.13.0", keyNeeded: true, calibrated: true },
    nexos: { provider: "openai", preset: "nexos", label: "nexos.ai", baseUrl: "https://api.nexos.ai/v1", host: "api.nexos.ai", local: false, model: "", keyNeeded: true, calibrated: null },
    openrouter: { provider: "openai", preset: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", host: "openrouter.ai", local: false, model: "", keyNeeded: true, calibrated: null },
    ollama: { provider: "openai", preset: "ollama", label: "Local (Ollama)", baseUrl: "http://127.0.0.1:11434/v1", host: "127.0.0.1:11434", local: true, model: "", keyNeeded: false, calibrated: null },
    custom: { provider: "openai", preset: "custom", label: "Custom", baseUrl: "", host: "", local: false, model: "", keyNeeded: true, calibrated: null },
  };
  const provider = (id, extra = {}) => ({ ...PROVIDERS[id], ...extra });
  const MODELS = {
    nexos: ["claude-sonnet-4.5", "gemini-2.5-flash", "gpt-4.1", "gpt-4.1-mini", "gpt-5", "mistral-large"],
    openrouter: ["anthropic/claude-haiku-4.5", "google/gemini-2.5-flash", "openai/gpt-4.1-mini"],
    ollama: ["llama3.1:8b", "qwen2.5:7b"],
    custom: ["local-model"],
  };
  const TEST = {
    type: "targetingTest", ok: true, provider: "nexos.ai", model: "gpt-4.1-mini", calibrated: true,
    rows: [
      { target: "the button that takes me to payment", ok: true, correct: true, ms: 612, p: 0.97, picked: "[10] button \"Proceed to checkout\"" },
      { target: "where I type my password", ok: true, correct: true, ms: 548, p: 0.99, picked: "[2] textbox \"Password\"" },
      { target: "the field for a discount code", ok: true, correct: false, ms: 701, p: 0.55, picked: "[8] button \"Apply\"" },
    ],
  };

  // Settings › Activity, as the bridge words it (bridge/activity.ts). Times are relative to now.
  const at = (min) => Date.now() - min * 60_000;
  const DAY = 24 * 60;
  const item = (id, min, browser, session, site, action, outcome = "ok", why = null) =>
    ({ id, ts: at(min), browser, thisBrowser: browser === "edge", session, site, action, outcome, why });
  const ACTIVITY = [
    item(40, 2, "edge", "a1b2c3d4", "github.com/acme/site/settings", "Clicked [31] button “Save changes”"),
    item(39, 3, "edge", "a1b2c3d4", "github.com/acme/site/settings", "Filled [12] textbox “Description” (48 characters)"),
    item(38, 3, "edge", "a1b2c3d4", "github.com/acme/site/settings", "Didn't click “Delete this repository”", "refused", "Needs your OK first"),
    item(37, 4, "edge", "a1b2c3d4", "github.com/acme/site/settings", "Read the page"),
    item(36, 5, "edge", "a1b2c3d4", "github.com/acme/site", "Opened the page"),
    item(35, 6, "edge", "a1b2c3d4", "mail.example.com/inbox", "Read the page", "refused", "Outside the session's site"),
    item(34, 7, "edge", "a1b2c3d4", "github.com/acme/site/pulls", "Read the page"),
    item(30, 52, "firefox", "e5f6a7b8", "linear.app/acme/issue/ENG-212", "Chose an option in [8] combobox “Status”"),
    item(29, 53, "firefox", "e5f6a7b8", "linear.app/acme/issue/ENG-212", "Clicked [44] button “Assign to me”", "error", "The element was gone"),
    item(28, 53, "firefox", "e5f6a7b8", "linear.app/acme/issue/ENG-212", "Read the page"),
    item(27, 55, "firefox", "e5f6a7b8", "linear.app/acme/team/ENG", "Found and clicked “the ENG-212 issue” [19]"),
    item(20, DAY + 30, "edge", "c9d0e1f2", "shop.example/checkout", "Compared 2 browsers"),
    item(19, DAY + 31, "firefox", "c9d0e1f2", "shop.example/checkout", "Typed into [5] textbox “Postcode” (6 characters)"),
    item(18, DAY + 32, "edge", "c9d0e1f2", "shop.example/checkout", "Pressed Enter in [5]"),
    item(17, DAY + 33, "edge", "c9d0e1f2", "shop.example/cart", "Read the form"),
    item(10, 3 * DAY + 70, null, null, "docs.example.org/guide/install", "Read the page"),
    item(9, 3 * DAY + 72, null, null, "docs.example.org/guide", "Read the page's text", "error", "The page didn't answer in time"),
  ];

  const base = () => ({
    key: "bst-ab12-cd34-ef56",
    connected: true,
    version: VERSION,
    hubVersion: VERSION,
    bridgeDir: "/Users/sam/code/browsteer-ext",
    firefox: false,
    settings: { armedUntil: 0, alwaysOn: false, readOnly: false, siteMode: "allow", allow: [], block: [] },
    site: { host: "github.com" },
    jev: { on: false, keyPresent: false, envOverride: false, targeting: provider("typesafe") },
    setupDone: true,
    pairedAt: 0,
    refused: null,
  });

  // Each state is a change to the base. Popup and setup page states share the list.
  const STATES = {
    // The bridge does not trust this extension (a store install next to an unpacked one, say).
    refused: (s) => { s.connected = false; s.hubVersion = null; s.jev = null; s.refused = "chrome-extension://adffpefpkgmmeakcpfmgkbpogeljjaan"; },
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
    "jev-ready-on": (s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com", "linear.app"]; s.settings.block = ["mybank.example"]; s.jev = { on: true, keyPresent: true, envOverride: false, targeting: provider("typesafe") }; },
    // Providers other than TypeSafe (Settings › Find controls by description, and the popup's More row).
    "jev-nexos-on": (s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; s.jev = { on: true, keyPresent: true, envOverride: false, targeting: provider("nexos", { model: "gpt-4.1-mini", calibrated: true }) }; },
    "jev-nexos-no-key": (s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; s.jev = { on: false, keyPresent: false, envOverride: false, targeting: provider("nexos") }; },
    "jev-nexos-uncal": (s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; s.jev = { on: true, keyPresent: true, envOverride: false, targeting: provider("nexos", { model: "gpt-5", calibrated: false }) }; },
    "jev-local": (s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; s.jev = { on: true, keyPresent: true, envOverride: false, targeting: provider("ollama", { model: "llama3.1:8b" }) }; },
    "jev-custom": (s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; s.jev = { on: false, keyPresent: false, envOverride: false, targeting: provider("custom") }; },
    // A bridge from before providers: no targeting field, TypeSafe only.
    "jev-old-bridge": (s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; s.jev = { on: true, keyPresent: true, envOverride: false }; },
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
    "jev-key-off": (s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; s.jev = { on: false, keyPresent: true, envOverride: false, targeting: provider("typesafe") }; },
    "jev-on": (s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; s.jev = { on: true, keyPresent: true, envOverride: false, targeting: provider("typesafe") }; },
    "jev-no-key": (s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; s.jev = { on: true, keyPresent: false, envOverride: false, targeting: provider("typesafe") }; },
    picked: (s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; },
    // Settings › Activity: canned actions over three days, two browsers, refusals and failures.
    activity: (s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com", "linear.app", "shop.example"]; },
    "activity-empty": (s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; },
    // A bridge from before Activity: it never answers the request.
    "activity-old-bridge": (s) => { s.hubVersion = "2.1.0"; s.settings.armedUntil = soon; s.settings.allow = ["github.com"]; },
    "setup-done":(s) => { s.settings.armedUntil = soon; s.settings.allow = ["github.com", "linear.app"]; s.settings.block = ["mybank.example"]; },
  };

  const state = base();
  (STATES[name] || (() => {}))(state);
  // &section=jev shows one Settings section only, so it fits a screenshot without scrolling.
  if (params.get("section")) document.addEventListener("DOMContentLoaded", () => {
    for (const sec of document.querySelectorAll("main > section")) if (sec.id !== params.get("section")) sec.hidden = true;
  });
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
    const t = state.jev && state.jev.targeting;
    let reply;
    switch (msg.type) {
      case "setTargeting": {
        if (!state.jev) break;
        if (msg.choice !== (t.provider === "typesafe" ? "typesafe" : t.preset)) {
          state.jev.targeting = provider(msg.choice);
          state.jev.keyPresent = msg.choice === "ollama";
          state.jev.on = msg.choice === "ollama" ? state.jev.on : false;
        }
        const nt = state.jev.targeting;
        if (msg.choice === "custom" && typeof msg.baseUrl === "string") {
          const m = /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:|\/))([^/?#]+)/.exec(msg.baseUrl);
          if (!m) { reply = { type: "jev", error: "Use https://. Plain http:// works only for 127.0.0.1 or localhost." }; break; }
          nt.baseUrl = msg.baseUrl.replace(/\/+$/, ""); nt.host = new URL(nt.baseUrl).host; nt.local = /^(127\.0\.0\.1|localhost)/.test(nt.host); nt.keyNeeded = !nt.local; state.jev.keyPresent = nt.local;
        }
        if (typeof msg.model === "string") nt.model = msg.model;
        reply = { type: "jev" };
        break;
      }
      case "setTargetingKey": if (state.jev) { state.jev.keyPresent = true; state.jev.on = true; } reply = { type: "jev" }; break;
      case "removeTargetingKey": if (state.jev) { state.jev.keyPresent = false; state.jev.on = false; } reply = { type: "jev" }; break;
      case "listModels": await new Promise((r) => setTimeout(r, 150)); reply = { type: "models", models: t.provider === "typesafe" ? ["jev-1.13.0"] : MODELS[t.preset] }; break;
      case "testTargeting": await new Promise((r) => setTimeout(r, 400)); reply = { ...TEST, provider: t.label, model: t.model, calibrated: t.calibrated !== false }; if (t.calibrated == null) t.calibrated = true; break;
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
      case "activity":
        if (!state.connected || name === "activity-old-bridge") break;
        reply = { type: "activity", items: name === "activity" ? ACTIVITY : [], keepDays: 30, browser: "edge", now: Date.now() };
        break;
    }
    return reply ? { ...status(), reply } : status();
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
