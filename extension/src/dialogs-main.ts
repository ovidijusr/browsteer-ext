// Chrome only — runs in the page's own JavaScript world at document_start, so
// the page's calls to alert / confirm / prompt reach the handlers below. It has
// no extension APIs and does nothing else; the content script reaches it
// through the relay in dialogs.ts.
import { createDialogs, REQ, RES, type RelayReq, type RelayRes } from "./dialogs";

const d = createDialogs(window);
try {
  window.alert = d.alert;
  window.confirm = d.confirm;
  window.prompt = d.prompt;
} catch { /* page froze its window props — natives stay in place */ }

document.addEventListener(REQ, (e) => {
  let req: RelayReq = {};
  try { req = JSON.parse((e as CustomEvent).detail); } catch {}
  if (req.touch) d.touch();
  const res: RelayRes = { policy: d.setPolicy(req.policy ?? {}), seen: req.drain ? d.drain() : [] };
  document.dispatchEvent(new CustomEvent(RES, { detail: JSON.stringify(res) }));
});
