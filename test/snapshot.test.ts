// Unit tests for the snapshot core. Runs under happy-dom, no browser needed:
//   bun test
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { listingPage, searchResultsPage } from "./fixtures";
import { snapshot, collectLinks, factorUrls, accessibleName, type Filter } from "../extension/src/snapshot";

const LISTING_URL = "https://suchen.mobile.de/fahrzeuge/details.html?id=453073528";
const SEARCH_URL = "https://suchen.mobile.de/fahrzeuge/search.html?vc=Car&sb=p";

function docOf(html: string, url: string): Document {
  const win = new Window({ url });
  win.document.write(html);
  return win.document as unknown as Document;
}

const lines = (s: string) => s.split("\n").filter((l) => l.trim().length > 0);

describe("run collapsing", () => {
  test("collapses the 31 gallery thumbnails into one ranged line", () => {
    const doc = docOf(listingPage(), LISTING_URL);
    const r = snapshot(doc);
    const collapsedLine = lines(r.tree).find((l) => l.includes("collapsed"));
    expect(collapsedLine).toBeDefined();
    expect(collapsedLine).toContain("×31");
    expect(collapsedLine).toContain("Weiter 1…Weiter 31");
    expect(r.collapsed).toBe(30); // 31 lines → 1
  });

  test("every ref inside a collapsed range is still individually addressable", () => {
    const doc = docOf(listingPage(), LISTING_URL);
    const r = snapshot(doc);
    const m = lines(r.tree).find((l) => l.includes("collapsed"))!.match(/\[(\d+)-(\d+)\]/);
    expect(m).not.toBeNull();
    const [, a, b] = m!;
    expect(Number(b) - Number(a) + 1).toBe(31);
    // and the range is inside the reported ref count, i.e. refs were really assigned
    expect(Number(b)).toBeLessThanOrEqual(r.count);
  });

  test("leaves short runs alone (4 identical buttons stay visible)", () => {
    const doc = docOf(listingPage(), LISTING_URL);
    const r = snapshot(doc);
    const recos = lines(r.tree).filter((l) => l.includes("Weitere Fahrzeugempfehlungen anzeigen"));
    expect(recos.length).toBe(4);
  });

  test("never folds search-result cards, whose digits are the information", () => {
    // Regression: every listing digit-normalises to the same skeleton
    // ("BMW i4 M50 … #.### € … #.### km"), so shape-equality alone would have
    // collapsed 20 distinct cars into a single line.
    const doc = docOf(searchResultsPage(20), SEARCH_URL);
    const r = snapshot(doc);
    expect(r.collapsed).toBe(0);
    expect(r.tree).not.toContain("collapsed");
    expect(lines(r.tree).filter((l) => l.includes("M50 xDrive Variant")).length).toBe(20);
    expect(r.tree).toContain("Variant 7");
  });

  test("raw:true disables collapsing", () => {
    const doc = docOf(listingPage(), LISTING_URL);
    const r = snapshot(doc, { collapse: false, dedup: false, chrome: false });
    expect(r.collapsed).toBe(0);
    expect(r.tree).not.toContain("collapsed");
    expect(lines(r.tree).filter((l) => /"Weiter \d+"/.test(l)).length).toBe(31);
  });
});

describe("subtree dedup", () => {
  test("replaces the second verbatim financing block with a marker", () => {
    const doc = docOf(listingPage(), LISTING_URL);
    const r = snapshot(doc);
    const markers = lines(r.tree).filter((l) => l.includes("identical to an earlier block"));
    expect(markers.length).toBe(1);
    expect(r.deduped).toBeGreaterThan(5);
    // the first copy survives in full
    expect(r.tree).toContain("Gaukite paskolos pasiūlymą");
  });

  test("an elided block keeps its refs, so a repeated table stays reachable", () => {
    const doc = docOf(listingPage(), LISTING_URL);
    const r = snapshot(doc);
    const marker = lines(r.tree).find((l) => l.includes("identical to an earlier block"))!;
    const m = marker.match(/refs \[(\d+)-(\d+)\] still clickable/);
    expect(m).not.toBeNull();
    // the duplicate financing block has 4 controls (2 sliders, a text input, a
    // select) plus its button — all still addressable
    expect(Number(m![2]) - Number(m![1]) + 1).toBe(5);
    expect(Number(m![2])).toBeLessThanOrEqual(r.count);
  });

  test("does not dedup blocks that differ in their text", () => {
    // Same structure, different values — must both survive.
    const html = `<!doctype html><html><body>
      <article><h2>A</h2><p>one</p><p>two</p></article>
      <article><h2>B</h2><p>three</p><p>four</p></article>
    </body></html>`;
    const r = snapshot(docOf(html, LISTING_URL));
    expect(r.deduped).toBe(0);
    expect(r.tree).toContain('"three"');
  });

  test("raw:true disables dedup", () => {
    const doc = docOf(listingPage(), LISTING_URL);
    const r = snapshot(doc, { collapse: false, dedup: false, chrome: false });
    expect(r.deduped).toBe(0);
    expect(r.tree).not.toContain("identical to an earlier block");
  });
});

describe("universal chrome", () => {
  test("drops the footer and the Google Maps widget, and reports the count", () => {
    const doc = docOf(listingPage(), LISTING_URL);
    const r = snapshot(doc);
    expect(r.chrome).toBe(2); // <footer> + .gm-style
    expect(r.tree).not.toContain("Rechtliches 1");
    expect(r.tree).not.toContain("Kartensteuerung 1");
    // content that merely sits near them is untouched
    expect(r.tree).toContain("Zur Homepage des Händlers");
  });

  test("raw:true brings the chrome back", () => {
    const doc = docOf(listingPage(), LISTING_URL);
    const r = snapshot(doc, { chrome: false, collapse: false, dedup: false });
    expect(r.chrome).toBe(0);
    expect(r.tree).toContain("Rechtliches 1");
    expect(r.tree).toContain("Kartensteuerung 1");
  });
});

describe("nothing meaningful is lost", () => {
  test("the facts a buyer actually needs survive all three passes", () => {
    const doc = docOf(listingPage(), LISTING_URL);
    const r = snapshot(doc);
    for (const needle of [
      "Batterie-Information", "93 %", "Sehr gut", "Bis 05/2031 oder 160.000 km",
      "83 kWh", "67.675 km", "400 kW (544 PS)", "46.940 €", "39.445 € (Netto)",
      "Anhängerkupplung schwenkbar", "Head-Up Display", "Laserlicht", "Beheizbares Lenkrad",
    ]) {
      expect(r.tree).toContain(needle);
    }
  });
});

describe("url factoring", () => {
  test("hoists the shared head and tail", () => {
    const urls = [
      "https://x.de/details.html?id=111&con=USED&refId=abc",
      "https://x.de/details.html?id=222&con=USED&refId=abc",
      "https://x.de/details.html?id=333&con=USED&refId=abc",
    ];
    const { prefix, suffix, mids } = factorUrls(urls);
    expect(prefix).toBe("https://x.de/details.html?id=");
    expect(suffix).toBe("&con=USED&refId=abc");
    expect(mids).toEqual(["111", "222", "333"]);
    // rebuilding must be lossless
    expect(mids.map((m) => prefix + m + suffix)).toEqual(urls);
  });

  test("does not bother when there is nothing to share", () => {
    const { prefix, mids } = factorUrls(["https://a.com/1", "https://b.org/2"]);
    expect(prefix).toBe("");
    expect(mids).toEqual(["https://a.com/1", "https://b.org/2"]);
  });

  test("handles a single url", () => {
    const { prefix, mids } = factorUrls(["https://a.com/1"]);
    expect(prefix).toBe("");
    expect(mids).toEqual(["https://a.com/1"]);
  });
});

describe("extraction rows carry hrefs", () => {
  const filter: Filter = {
    name: "mobile-de-srp",
    match: "suchen.mobile.de/fahrzeuge/search.html*",
    extract: {
      item: ".mN_WC",
      fields: [
        { name: "title", sel: ".dc_Br" },
        { name: "price", sel: "[data-testid=price-label]" },
        { name: "specs", sel: "[data-testid=listing-details-attributes]" },
      ],
    },
  };

  test("appends a url column and factors the shared parts into the legend", () => {
    const doc = docOf(searchResultsPage(20), SEARCH_URL);
    const r = snapshot(doc, { filters: [filter] });
    expect(r.extracted).toBe(true);
    expect(r.count).toBe(20);

    const out = lines(r.tree);
    expect(out[0]).toContain("id;title;price;specs;url");
    expect(out[1]).toContain("# url = ");

    // The per-row url is just the differing part…
    const firstRow = out[2];
    expect(firstRow.startsWith("[1] ")).toBe(true);
    const cols = firstRow.replace(/^\[1\] /, "").split(";");
    expect(cols[0]).toBe("M50 xDrive Variant 1");
    const mid = cols[cols.length - 1];
    expect(mid.length).toBeLessThan(20);

    // …and rebuilding it from the legend yields a working absolute URL.
    const [, prefix, suffix] = out[1].match(/# url = "(.*)" \+ <url> \+ "(.*)"/)!;
    const rebuilt = prefix + mid + suffix;
    expect(rebuilt).toContain("https://suchen.mobile.de/fahrzeuge/details.html?id=459000000");
    expect(rebuilt).toContain("refId=7c8ee30a-77c4-37db-eb21-97fa9b2b3299");
  });

  test("the url column costs far less than printing whole urls", () => {
    const doc = docOf(searchResultsPage(20), SEARCH_URL);
    const withHref = snapshot(doc, { filters: [filter] }).tree.length;
    // What it would cost if every row carried its full absolute URL.
    const full = Array.from(doc.querySelectorAll(".mN_WC a[href]"))
      .reduce((n, a) => n + (a as HTMLAnchorElement).href.length, 0);
    expect(full).toBeGreaterThan(3000);
    // the whole table, urls included, is smaller than the urls alone would be
    expect(withHref).toBeLessThan(full);
  });
});

describe("browser_links", () => {
  test("returns label → url pairs with the shared parts hoisted", () => {
    const doc = docOf(listingPage(), LISTING_URL);
    const r = collectLinks(doc);
    const reco = r.links.find((l) => l.text.includes("eDrive40"));
    expect(reco).toBeDefined();
    expect(r.prefix + reco!.url + r.suffix).toBe(
      "https://suchen.mobile.de/fahrzeuge/details.html?id=111111111&con=USED&refId=abc"
    );
  });

  test("can be scoped to one subtree", () => {
    const doc = docOf(searchResultsPage(20), SEARCH_URL);
    const card = doc.querySelector(".mN_WC") as Element;
    const r = collectLinks(doc, { root: card });
    expect(r.total).toBe(1);
  });

  test("honours the limit and reports the true total", () => {
    const doc = docOf(searchResultsPage(20), SEARCH_URL);
    const r = collectLinks(doc, { limit: 5 });
    expect(r.links.length).toBe(5);
    expect(r.total).toBe(21); // 20 cards + the footer link
  });
});

describe("image-only control naming", () => {
  const nameOf = (html: string) => {
    const doc = docOf(`<body>${html}</body>`, "https://example.com/");
    return accessibleName(doc.querySelector("a, button") as Element);
  };

  // Regression: a real itch.io devlog figure printed as a bare `[18] link`
  // even though its <img> carried alt="Depth buffer".
  test("a link wrapping an <img> borrows the img's alt", () => {
    expect(
      nameOf(`<a href="/z"><img title="Depth buffer" alt="Depth buffer" src="z.png"></a>`)
    ).toBe("Depth buffer");
  });

  test("falls back to the img's title when alt is empty", () => {
    expect(nameOf(`<a href="/z"><img alt="" title="Sea floor" src="z.png"></a>`)).toBe("Sea floor");
  });

  test("an icon button borrows its inline svg's <title>", () => {
    expect(nameOf(`<button><svg><title>Close</title><path d="M0 0"/></svg></button>`)).toBe("Close");
  });

  test("an aria-label on a descendant is used when there is no img or svg", () => {
    expect(nameOf(`<a href="/z"><span aria-label="Play" class="i"></span></a>`)).toBe("Play");
  });

  test("the control's own text still wins over descendant labels", () => {
    expect(nameOf(`<a href="/z">Read more<img alt="arrow" src="z.png"></a>`)).toBe("Read more");
  });

  test("an unlabelled image-only link is still nameless (no invented text)", () => {
    expect(nameOf(`<a href="/z"><img src="z.png"></a>`)).toBe("");
  });

  test("aria-label on the control itself keeps precedence", () => {
    expect(nameOf(`<a href="/z" aria-label="Home"><img alt="logo" src="z.png"></a>`)).toBe("Home");
  });
});
