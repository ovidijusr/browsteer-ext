// Measure the reduction passes on the fixture page shapes:
//   bun run test/reduction.ts
//
// Offline and deterministic — no browser, no network. For the same measurement
// against a live tab, use test/measure.ts instead.
import { Window } from "happy-dom";
import { listingPage, searchResultsPage } from "./fixtures";
import { snapshot, type Filter } from "../extension/src/snapshot";

const RAW = { chrome: false, collapse: false, dedup: false } as const;
const tok = (b: number) => Math.round(b / 4); // rough but consistent across rows

function docOf(html: string, url: string): Document {
  const win = new Window({ url });
  win.document.write(html);
  return win.document as unknown as Document;
}

function row(label: string, bytes: number, base: number, extra = "") {
  const pct = base ? ((bytes / base) * 100).toFixed(0) + "%" : "—";
  console.log(
    label.padEnd(34) +
      String(bytes).padStart(8) +
      String(tok(bytes)).padStart(9) +
      pct.padStart(8) +
      (extra ? "   " + extra : "")
  );
}

function header(title: string) {
  console.log(`\n${title}`);
  console.log("lens".padEnd(34) + "bytes".padStart(8) + "~tokens".padStart(9) + "vs raw".padStart(8));
}

// ── Detail page ──────────────────────────────────────────────────────────────
{
  const doc = docOf(listingPage(), "https://suchen.mobile.de/fahrzeuge/details.html?id=453073528");
  const raw = snapshot(doc, RAW);
  const reduced = snapshot(doc);
  const io = snapshot(doc, { interactiveOnly: true });

  header("DETAIL PAGE (mobile.de listing shape)");
  row("raw (no passes)", raw.tree.length, raw.tree.length);
  row(
    "reduced (default)",
    reduced.tree.length,
    raw.tree.length,
    `collapsed ${reduced.collapsed}, deduped ${reduced.deduped}, chrome ${reduced.chrome}`
  );
  row("reduced + interactiveOnly", io.tree.length, raw.tree.length);
  console.log(
    `\nrefs: ${raw.count} raw → ${reduced.count} reduced` +
      `   lines: ${raw.tree.split("\n").length} → ${reduced.tree.split("\n").length}` +
      `   saved ${(100 - (reduced.tree.length / raw.tree.length) * 100).toFixed(0)}%`
  );
}

// ── Results page ─────────────────────────────────────────────────────────────
{
  const url = "https://suchen.mobile.de/fahrzeuge/search.html?vc=Car&sb=p";
  const doc = docOf(searchResultsPage(20), url);
  const filter: Filter = {
    name: "mobile-de-srp",
    match: "suchen.mobile.de/fahrzeuge/search.html*",
    extract: {
      item: ".mN_WC",
      fields: [
        { name: "title", sel: ".dc_Br" },
        { name: "price", sel: "[data-testid=price-label]" },
        { name: "specs", sel: "[data-testid=listing-details-attributes]" },
        { name: "seller", sel: ".Kh0Rn" },
      ],
    },
  };

  const raw = snapshot(doc, RAW);
  const reduced = snapshot(doc);
  const extracted = snapshot(doc, { filters: [filter] });
  const urlBytes = Array.from(doc.querySelectorAll(".mN_WC a[href]")).reduce(
    (n, a) => n + (a as HTMLAnchorElement).href.length,
    0
  );

  header("RESULTS PAGE (20 cards)");
  row("raw (no passes)", raw.tree.length, raw.tree.length);
  row("reduced (default)", reduced.tree.length, raw.tree.length);
  row("extraction filter (+urls)", extracted.tree.length, raw.tree.length, `${extracted.count} rows`);
  console.log(
    `\nthe 20 absolute urls alone would be ${urlBytes} bytes (~${tok(urlBytes)} tok);` +
      ` factored into the legend they cost ${extracted.tree.length - snapshotWithoutUrls(doc, filter)} bytes.`
  );
  console.log(
    "and the old path to reach one listing was: snapshot → browser_html(ref) → parse href → navigate (4 calls)."
  );
}

/** Same extraction with the implicit url column stripped, for the delta above. */
function snapshotWithoutUrls(doc: Document, filter: Filter): number {
  const withUrls = snapshot(doc, { filters: [filter] }).tree;
  const stripped = withUrls
    .split("\n")
    .filter((l) => !l.startsWith("# url = "))
    .map((l) => (l.startsWith("[") ? l.split(";").slice(0, -1).join(";") : l.replace(";url", "")))
    .join("\n");
  return stripped.length;
}
