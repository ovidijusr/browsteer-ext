// Line icons for the popup, setup guide and settings: one icon per meaning, drawn
// on a 24px grid with a 2px stroke. Built as DOM nodes (no innerHTML, no network).
const P: Record<string, string[]> = {
  lock: ["M7 11V8a5 5 0 0 1 10 0v3", "M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z", "M12 15v2"],
  open: ["M5 12.5l4.5 4.5L19 7.5"],
  danger: ["M12 3.5L22 20.5H2z", "M12 10v4", "M12 17.2v.1"],
  blocked: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z", "M5.6 5.6l12.8 12.8"],
  plug: ["M9 3v5", "M15 3v5", "M6 8h12v3a6 6 0 0 1-12 0z", "M12 17v4"],
  setup: ["M3 7l9-4 9 4-9 4z", "M3 7v10l9 4 9-4V7", "M12 11v10"],
  eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z", "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z"],
  settings: ["M4 7h9", "M19 7h1", "M4 17h3", "M13 17h7", "M16 4.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z", "M10 14.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z"],
  copy: ["M9 9h11v11H9z", "M5 15V4h11"],
  stop: ["M7 7h10v10H7z"],
  plus: ["M12 5v14", "M5 12h14"],
  key: ["M15 4a5 5 0 1 1 0 10a5 5 0 1 1 0-10z", "M11.5 12.5L3 21", "M6 18l2 2", "M8.5 15.5l2 2"],
  swap: ["M4 8h14l-3.5-3.5", "M20 16H6l3.5 3.5"],
  target: ["M12 3v4", "M12 17v4", "M3 12h4", "M17 12h4", "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z"],
  search: ["M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z", "M20 20l-4-4"],
  remove: ["M6 6l12 12", "M18 6L6 18"],
  external: ["M8 16L17 7", "M10 7h7v7"],
  puzzle: ["M4 8h3.5a2 2 0 1 1 4 0H15v3.5a2 2 0 1 1 0 4V19h-3.5a2 2 0 1 0-4 0H4v-3.5a2 2 0 1 0 0-4z"],
  pin: ["M9 3h6l-1 6 3 3H7l3-3z", "M12 12v9"],
  clock: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z", "M12 7v5l3 2"],
  terminal: ["M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z", "M7 10l3 2.5L7 15", "M13 15h4"],
  browser: ["M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z", "M3 9h18", "M6 6.5h.1", "M8.5 6.5h.1"],
  cursor: ["M5 3l13 7-5.5 1.8L10.5 18z", "M13 12l5 6"],
  update: ["M20 12a8 8 0 1 1-2.3-5.7", "M20 4v5h-5"],
};
const FILLED = new Set(["stop"]);
const NS = "http://www.w3.org/2000/svg";

export type IconName = keyof typeof P;

/** A 24×24 stroke icon, hidden from screen readers (the text next to it says the same). */
export function icon(name: IconName, size = 20): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `icon icon-${name}`);
  for (const d of P[name]) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    if (FILLED.has(name)) p.setAttribute("fill", "currentColor");
    svg.append(p);
  }
  return svg;
}

/** Replace the contents of every [data-icon] placeholder in the page with its icon. */
export function drawIcons(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-icon]")) {
    const name = el.dataset.icon as IconName;
    if (!P[name]) continue;
    el.replaceChildren(icon(name, Number(el.dataset.size) || 20));
  }
}

/** Point one placeholder at another icon. */
export function setIcon(el: HTMLElement, name: IconName): void {
  if (el.dataset.icon === name && el.firstChild) return;
  el.dataset.icon = name;
  el.replaceChildren(icon(name, Number(el.dataset.size) || 20));
}
