// What counts as "one site". Shared by the hub (bridge/security.ts) and the
// background, which both enforce the one-site-per-session lock.
//
// This is the registrable domain, approximated without the full public-suffix
// list: two labels, three under common country second levels, and one extra
// label under shared hosting domains where each subdomain is a different owner.
const COUNTRY_SECOND_LEVEL = /\.(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/;
const SHARED_HOSTS = [
  "github.io", "gitlab.io", "pages.dev", "workers.dev", "vercel.app", "netlify.app", "web.app",
  "firebaseapp.com", "herokuapp.com", "azurewebsites.net", "cloudfront.net", "amazonaws.com",
  "appspot.com", "blogspot.com", "onrender.com", "fly.dev", "repl.co", "glitch.me", "ngrok.io",
  "ngrok-free.app", "translate.goog", "googleusercontent.com", "sharepoint.com", "atlassian.net",
  "zendesk.com", "myshopify.com", "wordpress.com", "notion.site", "webflow.io", "surge.sh",
];

/** The site an address belongs to, or null when it is not a web page. */
export function siteOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return null; host = u.hostname.toLowerCase(); } catch { return null; }
  if (/^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return host; // IP or single label
  const parts = host.split(".");
  const shared = SHARED_HOSTS.find((s) => host.endsWith(`.${s}`));
  if (shared) return parts.slice(-(shared.split(".").length + 1)).join(".");
  return parts.slice(COUNTRY_SECOND_LEVEL.test(host) ? -3 : -2).join(".");
}

export function sameSite(a: string | null | undefined, b: string | null | undefined): boolean {
  const sa = siteOf(a), sb = siteOf(b);
  return !!sa && sa === sb;
}
