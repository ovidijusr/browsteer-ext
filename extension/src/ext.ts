// One name for the WebExtensions API in both browsers.
//
// Firefox exposes `browser` (promise-based). Chrome exposes `chrome`, which is
// promise-based too under Manifest V3 for every call this extension makes, so
// the same code runs on either without a polyfill. Types come from
// @types/firefox-webext-browser; only APIs present in both are used.
const g = globalThis as unknown as { browser?: typeof browser; chrome?: typeof browser };

export const ext: typeof browser = g.browser ?? g.chrome!;

/** True in Firefox (Gecko), false in Chrome and other Chromium browsers. */
export const isFirefox: boolean = typeof g.browser !== "undefined" && typeof (g.browser as any).runtime?.getBrowserInfo === "function";
