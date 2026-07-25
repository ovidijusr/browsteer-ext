// Structural replicas of the two page shapes that dominated a real browsing
// session (six BMW listings across mobile.de + autoplius, July 2026). These are
// NOT captures — they reproduce the *structures* that wasted tokens, with the
// element counts actually observed, so the reduction passes are measured against
// realistic shapes rather than a toy page.
//
//   listingPage()       — a vehicle detail page
//   searchResultsPage() — a results list, using the real class names/testids

/** Gallery thumbnails on a mobile.de detail page: one button per photo. */
const GALLERY_THUMBS = 31;
/** Google Maps widget controls, all inside .gm-style. */
const MAP_CONTROLS = 12;
/** Legal/footer links. */
const FOOTER_LINKS = 10;
/** "Weitere Fahrzeugempfehlungen anzeigen" — repeated verbatim on the real page. */
const RECO_BUTTONS = 4;
/** Equipment bullet list length. */
const EQUIPMENT_ITEMS = 60;

const EQUIPMENT = [
  "Abgedunkelte Scheiben", "ABS", "Abstandstempomat", "Abstandswarner",
  "Adaptives Fahrwerk", "Adaptives Kurvenlicht", "Allradantrieb",
  "Ambiente-Beleuchtung", "Android Auto", "Anhängerkupplung schwenkbar",
  "Apple CarPlay", "Armlehne", "Batteriezertifikat", "Beheizbares Lenkrad",
  "Berganfahrassistent", "Blendfreies Fernlicht", "Bluetooth", "Bordcomputer",
  "Elektr. Fensterheber", "Elektr. Heckklappe", "Head-Up Display", "Isofix",
  "Laserlicht", "Lederlenkrad", "LED-Tagfahrlicht", "Leichtmetallfelgen",
  "Lichtsensor", "Lordosenstütze", "Müdigkeitswarner", "Navigationssystem",
];

/**
 * The financing calculator. autoplius renders this block twice, byte-identical,
 * top and bottom of the page — the case subtree dedup exists for.
 */
function financingBlock(): string {
  return `
  <section>
    <h2>Automobilis išsimokėtinai</h2>
    <p>Norėdami įsigyti automobilį išsimokėtinai, užpildykite paraišką.</p>
    <ul>
      <li>0% pradinis įnašas</li>
      <li>Nereikia įkeisti automobilio</li>
      <li>Nebūtinas KASKO draudimas</li>
    </ul>
    <p>Su likutine verte 9 622 €</p>
    <label for="amt">Pasirinkite paskolos sumą:</label>
    <input id="amt" type="range" name="amount" value="38491">
    <input type="text" name="amount-text" value="38491">
    <label for="mp">Pasirinkite mėnesio įmoką:</label>
    <input id="mp" type="range" name="monthly-payment" value="84">
    <select name="months"><option>84</option><option>60</option></select>
    <button>Gaukite paskolos pasiūlymą</button>
  </section>`;
}

export function listingPage(): string {
  const thumbs = Array.from(
    { length: GALLERY_THUMBS },
    (_, i) => `<button aria-label="Weiter ${i + 1}">›</button>`
  ).join("\n      ");

  const mapControls = Array.from(
    { length: MAP_CONTROLS },
    (_, i) => `<button aria-label="Kartensteuerung ${i + 1}">map${i + 1}</button>`
  ).join("\n        ");

  const footerLinks = Array.from(
    { length: FOOTER_LINKS },
    (_, i) => `<li><a href="/legal/${i}">Rechtliches ${i + 1}</a></li>`
  ).join("\n      ");

  const recoButtons = Array.from(
    { length: RECO_BUTTONS },
    () => `<button>Weitere Fahrzeugempfehlungen anzeigen</button>`
  ).join("\n      ");

  const equipment = Array.from({ length: EQUIPMENT_ITEMS }, (_, i) =>
    `<li>${EQUIPMENT[i % EQUIPMENT.length]}${i >= EQUIPMENT.length ? ` ${i}` : ""}</li>`
  ).join("\n        ");

  return `<!doctype html>
<html><body>
  <nav>
    <a href="/">Zur mobile.de Startseite</a>
    <button>Suchen</button>
    <button>Verkaufen</button>
    <button>Informieren</button>
    <button>Benachrichtigungen</button>
    <button>Meine Suchen</button>
  </nav>

  <article>
    <section>
      <button aria-label="Zurück">‹</button>
      <button aria-label="Weiter">›</button>
      <button>Alle Bilder</button>
      <button>Vergrößern</button>
      ${thumbs}
    </section>
  </article>

  <article>
    <section>
      <span>Kilometerstand</span><span>67.675 km</span>
      <span>Leistung</span><span>400 kW (544 PS)</span>
      <span>Erstzulassung</span><span>05/2023</span>
      <span>Fahrzeughalter</span><span>1</span>
    </section>
  </article>

  <article>
    <section>
      <h2>Batterie-Information</h2>
      <span>Batterie-Status (SoH)</span>
      <button>Batterie-Status</button>
      <span>93 %</span><span>Sehr gut</span>
      <button>Batterie-Zertifikat anzeigen</button>
      <span>Garantie ab Erstzulassung</span>
      <span>Bis 05/2031 oder 160.000 km</span>
      <span>Batteriekapazität</span><span>83 kWh</span>
    </section>
  </article>

  <article>
    <section>
      <h2>Ausstattung</h2>
      <ul>
        ${equipment}
      </ul>
    </section>
  </article>

  ${financingBlock()}

  <article>
    <section>
      <h2>Händler</h2>
      <p>Autohaus Ehrl GmbH Halle BMW &amp; MINI Vertragshändler</p>
      <a href="https://www.ehrl-gruppe.de/">Zur Homepage des Händlers</a>
      <div class="gm-style">
        <div role="region" aria-label="Karte">
          ${mapControls}
        </div>
      </div>
    </section>
  </article>

  <article>
    <section>
      <h2>Preis</h2>
      <span>46.940 €</span>
      <button>Guter Preis</button>
      <span>39.445 € (Netto)</span>
    </section>
  </article>

  <article>
    <section>
      <h2>Ähnliche Fahrzeuge</h2>
      <a href="/fahrzeuge/details.html?id=111111111&amp;con=USED&amp;refId=abc">BMW i4 eDrive40 · 37.406 €</a>
      <a href="/fahrzeuge/details.html?id=222222222&amp;con=USED&amp;refId=abc">BMW i4 eDrive35 · 41.907 €</a>
      <a href="/fahrzeuge/details.html?id=333333333&amp;con=USED&amp;refId=abc">BMW i4 M50 · 48.990 €</a>
      ${recoButtons}
    </section>
  </article>

  ${financingBlock()}

  <footer>
    <ul>
      ${footerLinks}
    </ul>
  </footer>
</body></html>`;
}

/**
 * A results list built with the real mobile.de class names and test ids used to
 * drive the extraction filter in the session, including the long query strings
 * that differ only by `id`.
 */
export function searchResultsPage(count = 20): string {
  const cards = Array.from({ length: count }, (_, i) => {
    const id = 459000000 + i * 137;
    const href =
      `/fahrzeuge/details.html?id=${id}&amp;con=USED&amp;dam=false&amp;fe=HEAD_UP_DISPLAY` +
      `&amp;fe=HEATED_STEERING_WHEEL&amp;isSearchRequest=true&amp;od=up` +
      `&amp;refId=7c8ee30a-77c4-37db-eb21-97fa9b2b3299&amp;s=Car&amp;sb=p&amp;vc=Car`;
    return `
  <div class="mN_WC">
    <a class="FWtU1" href="${href}" target="_blank">
      <h2><span class="eO87w">BMW i4</span><span class="dc_Br">M50 xDrive Variant ${i + 1}</span></h2>
      <span data-testid="price-label">${40 + i}.940 €</span>
      <div data-testid="listing-details-attributes">EZ 05/2023 • ${50 + i}.675 km • 400 kW (544 PS) • Elektro</div>
      <div class="Kh0Rn">Autohaus ${i + 1}<span>4.6 Sterne</span>06179 Halle</div>
    </a>
  </div>`;
  }).join("\n");

  return `<!doctype html>
<html><body>
  <main>
    <h1>${count} BMW i4 Angebote</h1>
    ${cards}
  </main>
  <footer><a href="/impressum">Impressum</a></footer>
</body></html>`;
}
