/**
 * Regenerates src/delivery/ibadan-areas.data.ts from OpenStreetMap.
 *
 * Delivery fees are priced off these coordinates, so they must come from a real
 * source rather than being typed from memory. Run this when you want to add
 * areas or refresh the data:
 *
 *   node scripts/build-ibadan-areas.js
 *
 * Respects the Nominatim usage policy: one request per second, real User-Agent.
 * Results outside a generous Ibadan bounding box are dropped, which is what
 * filters out the bogus entries (e.g. "Ikeja", which is in Lagos).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const UA = 'ojarun-delivery-pricing/1.0 (https://ojarun.ng; ops@ojarun.ng)';
const DELAY_MS = 1200;

// Generous box around greater Ibadan — anything outside is a bad match.
const BOUNDS = { south: 7.15, north: 7.65, west: 3.70, east: 4.10 };

// Entries are either a plain name (queried as "<name>, Ibadan, Oyo, Nigeria")
// or { name, query } when the default query resolves badly.
//
// Deliberately excluded after manual review of the OSM results:
//   Gate, Barracks      - generic words; they'd match "near UI gate" and
//                         silently price it as Agodi.
//   Bashorun            - resolves to "Bashorun Apampa Avenue", a street ~8km
//                         from the Basorun area it looks like. "Basorun" is
//                         already here and resolves correctly.
//   Ajibode             - OSM's match is in Afijio LGA, ~25km north, not the
//                         Ajibode beside UI.
//   Odo Ona             - resolves to the exact same node as Podo, which can't
//                         be right for both. Left out so it falls through to
//                         the geocoder rather than pricing off a wrong point.
//   Ibadan North/South West - LGA centroids, far too coarse to price from.
//   Ojurin              - OSM resolves it ~0.9km from Bodija, but the Ojurin
//                         customers mean is in Akobo, ~3km east. Keeping it
//                         would under-charge every Akobo Ojurin delivery;
//                         "Akobo" already covers that area correctly.
const AREAS = [
  'Bodija', 'New Bodija', 'Bodija Market', 'Agodi', 'Agodi Gate', 'Akobo',
  'Aleshinloye', 'Basorun', 'Beere', 'Challenge', 'Dugbe', 'Eleyele', 'Felele',
  'Gbagi', 'Idi Ape', 'Iwo Road', 'Jericho', 'Molete', 'Mokola', 'Moniya',
  'Ojoo', 'Oluyole', 'Onireke', 'Orogun', 'Oke Ado', 'Oke Bola', 'Olodo',
  'Podo', 'Ring Road', 'Sango', 'Samonda', 'Yemetu', 'Agbowo', 'Total Garden',
  'Adamasingba', 'Omi Adio', 'Kudeti', 'Agugu', 'Aperin', 'Odinjo', 'Olomi',
  'Alalubosa', 'Oja Oba', 'Ijokodo', 'Poly Road', 'Ashi', 'Awotan', 'Apete',
  'University of Ibadan', 'University College Hospital',
  'Lekan Salami Stadium', 'Cocoa House', 'Mapo Hall', 'Agodi Gardens',
  { name: 'Alakia', query: 'Alakia, Oyo, Nigeria' },
  { name: 'Egbeda', query: 'Egbeda, Oyo State, Nigeria' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shells out to curl rather than using fetch(): on Windows behind a
// TLS-intercepting proxy, curl trusts the OS certificate store while Node does
// not, and fetch fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE.
async function lookup(entry) {
  const query =
    typeof entry === 'string' ? `${entry}, Ibadan, Oyo, Nigeria` : entry.query;
  const q = encodeURIComponent(query);
  const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&countrycodes=ng`;
  const raw = execFileSync(
    'curl.exe',
    ['-s', '--max-time', '25', '-A', UA, url],
    { encoding: 'utf8' },
  );
  const json = JSON.parse(raw);
  if (!json.length) return null;

  const lat = parseFloat(json[0].lat);
  const lng = parseFloat(json[0].lon);
  if (
    lat < BOUNDS.south || lat > BOUNDS.north ||
    lng < BOUNDS.west || lng > BOUNDS.east
  ) {
    return { rejected: true, lat, lng, display: json[0].display_name };
  }
  return { lat, lng, display: json[0].display_name };
}

(async () => {
  const resolved = [];
  const skipped = [];

  for (const entry of AREAS) {
    const name = typeof entry === 'string' ? entry : entry.name;
    try {
      const hit = await lookup(entry);
      if (!hit) {
        skipped.push(`${name} — no result`);
      } else if (hit.rejected) {
        skipped.push(`${name} — outside Ibadan (${hit.lat}, ${hit.lng}) ${hit.display}`);
      } else {
        resolved.push({ name, lat: hit.lat, lng: hit.lng });
        console.log(`ok   ${name.padEnd(32)} ${hit.lat.toFixed(5)}, ${hit.lng.toFixed(5)}`);
      }
    } catch (err) {
      skipped.push(`${name} — ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  console.log(`\nResolved ${resolved.length}, skipped ${skipped.length}`);
  skipped.forEach((s) => console.log(`skip ${s}`));

  const body = resolved
    .map(
      (r) =>
        `  { name: ${JSON.stringify(r.name)}, lat: ${r.lat}, lng: ${r.lng} },`,
    )
    .join('\n');

  const out = `/**
 * Ibadan areas with coordinates, generated from OpenStreetMap via
 * scripts/build-ibadan-areas.js. Do not hand-edit — rerun the script instead.
 *
 * Delivery fees are priced from these points, so every entry is a real
 * OSM-resolved location rather than an estimate.
 *
 * Data (c) OpenStreetMap contributors, ODbL 1.0 — https://osm.org/copyright
 */
export interface IbadanArea {
  name: string;
  lat: number;
  lng: number;
}

export const IBADAN_AREA_COORDS: IbadanArea[] = [
${body}
];
`;

  const dest = path.join(__dirname, '..', 'src', 'delivery', 'ibadan-areas.data.ts');
  fs.writeFileSync(dest, out, 'utf8');
  console.log(`\nWrote ${resolved.length} areas to ${dest}`);
})();
