/**
 * Regenerates src/delivery/ibadan-areas.data.ts.
 *
 * Two phases:
 *   1. Resolve each area to coordinates via OpenStreetMap (Nominatim).
 *   2. Measure real driving distance from Bodija Market to each area via the
 *      OpenRouteService Matrix API.
 *
 * Both run at build time, so the app makes zero geocoding or routing calls at
 * runtime: the area list is fixed, so each distance is a constant. That keeps
 * checkout independent of any third-party API being up, and means the ORS free
 * quota is never touched in production.
 *
 *   ORS_API_KEY=... node scripts/build-ibadan-areas.js
 *
 * Without ORS_API_KEY the script still works and falls back to straight-line
 * distance x DEFAULT_ROAD_FACTOR, flagging those rows as approximate.
 *
 * Respects the Nominatim usage policy: one request per second, real User-Agent.
 * Results outside a generous Ibadan bounding box are dropped, which is what
 * filters out bogus matches in other states.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const UA = 'ojarun-delivery-pricing/1.0 (https://ojarun.ng; ops@ojarun.ng)';
const DELAY_MS = 1200;

// Bodija Market, from OSM. Must match delivery.originLat/Lng in configuration.ts.
const ORIGIN = { lat: 7.4359015, lng: 3.9157404 };

// api.openrouteservice.org is being deprecated in favour of api.heigit.org;
// both are tried so this keeps working through the switchover.
const ORS_HOSTS = [
  process.env.ORS_BASE_URL,
  'https://api.openrouteservice.org',
  'https://api.heigit.org',
].filter(Boolean);

// Used only when ORS is unavailable: streets never run straight, so crow-flight
// under-states real distance.
const DEFAULT_ROAD_FACTOR = 1.3;

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

/**
 * Reads a single value out of the local .env, so the key can stay in that file
 * (which is gitignored) instead of being passed through a shell command where
 * it would land in history and process listings. Never logged.
 */
function readEnvKey(name) {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    const line = fs
      .readFileSync(envPath, 'utf8')
      .split(/\r?\n/)
      .find((l) => l.trim().startsWith(`${name}=`));
    if (!line) return null;
    return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
  } catch {
    return null;
  }
}

const haversineKm = (a, b) => {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

/**
 * One Matrix call: Bodija Market as the single source, every area as a
 * destination. Well inside the 3,500-location cap, so this costs 1 of the
 * 500 daily Matrix requests no matter how many areas there are.
 *
 * Note ORS takes coordinates as [lng, lat], the opposite of the usual order.
 */
function fetchRoadDistances(areas, apiKey) {
  const locations = [
    [ORIGIN.lng, ORIGIN.lat],
    ...areas.map((a) => [a.lng, a.lat]),
  ];
  const body = JSON.stringify({
    locations,
    sources: [0],
    destinations: areas.map((_, i) => i + 1),
    metrics: ['distance'],
    units: 'km',
  });

  let lastError = null;
  for (const host of ORS_HOSTS) {
    const url = `${host}/v2/matrix/driving-car`;
    try {
      const raw = execFileSync(
        'curl.exe',
        [
          '-s', '--max-time', '60',
          '-X', 'POST', url,
          '-H', `Authorization: ${apiKey}`,
          '-H', 'Content-Type: application/json',
          '-H', `User-Agent: ${UA}`,
          '--data-binary', body,
        ],
        { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
      );
      const json = JSON.parse(raw);
      if (json.error) {
        lastError = `${url}: ${JSON.stringify(json.error)}`;
        continue;
      }
      const row = json.distances && json.distances[0];
      if (!Array.isArray(row)) {
        lastError = `${url}: unexpected response shape`;
        continue;
      }
      console.log(`Road distances via ${url}`);
      return row;
    } catch (err) {
      lastError = `${url}: ${err.message}`;
    }
  }
  throw new Error(lastError || 'no ORS host reachable');
}

// Nominatim is rate-limited to 1 req/sec, so a full geocode pass takes minutes.
// Cache the coordinates (they don't change) to keep reruns cheap; pass
// --refresh to force a fresh lookup.
const CACHE_PATH = path.join(__dirname, '.cache-ibadan-coords.json');

function loadCache() {
  if (process.argv.includes('--refresh')) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    const names = new Set(
      AREAS.map((e) => (typeof e === 'string' ? e : e.name)),
    );
    // Only reuse if the cache covers exactly the current area list.
    if (
      raw.length === names.size &&
      raw.every((r) => names.has(r.name))
    ) {
      return raw;
    }
    console.log('Area list changed — ignoring stale coordinate cache.');
  } catch {
    /* no cache yet */
  }
  return null;
}

(async () => {
  const resolved = [];
  const skipped = [];

  const cached = loadCache();
  if (cached) {
    console.log(`Using cached coordinates for ${cached.length} areas.`);
    resolved.push(...cached.map((c) => ({ ...c })));
  }

  for (const entry of cached ? [] : AREAS) {
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

  if (!cached) {
    fs.writeFileSync(
      CACHE_PATH,
      JSON.stringify(
        resolved.map(({ name, lat, lng }) => ({ name, lat, lng })),
        null,
        2,
      ),
      'utf8',
    );
  }

  // Phase 2: real driving distance from the market to each area.
  const apiKey = process.env.ORS_API_KEY || readEnvKey('ORS_API_KEY');
  let approximated = 0;
  if (!apiKey) {
    console.warn(
      '\nORS_API_KEY not set — falling back to straight-line x ' +
        `${DEFAULT_ROAD_FACTOR}. Distances will be approximate.`,
    );
    for (const r of resolved) {
      r.roadKm = Math.round(haversineKm(ORIGIN, r) * DEFAULT_ROAD_FACTOR * 100) / 100;
      r.approx = true;
      approximated++;
    }
  } else {
    const distances = fetchRoadDistances(resolved, apiKey);
    resolved.forEach((r, i) => {
      const km = distances[i];
      if (typeof km === 'number' && isFinite(km)) {
        r.roadKm = Math.round(km * 100) / 100;
        r.approx = false;
      } else {
        // ORS couldn't route to this point (no nearby road in OSM).
        r.roadKm = Math.round(haversineKm(ORIGIN, r) * DEFAULT_ROAD_FACTOR * 100) / 100;
        r.approx = true;
        approximated++;
        console.warn(`  no route to ${r.name} — using approximation`);
      }
    });
    console.log(
      `\nRouted ${resolved.length - approximated}/${resolved.length} areas; ` +
        `${approximated} approximated.`,
    );
    const straightVsRoad = resolved
      .filter((r) => !r.approx)
      .map((r) => r.roadKm / Math.max(haversineKm(ORIGIN, r), 0.01))
      .filter((n) => isFinite(n) && n > 0);
    if (straightVsRoad.length) {
      const avg =
        straightVsRoad.reduce((a, b) => a + b, 0) / straightVsRoad.length;
      console.log(`Actual road:straight ratio averages ${avg.toFixed(2)}x ` +
        `(the old flat assumption was ${DEFAULT_ROAD_FACTOR}x).`);
    }
  }

  const body = resolved
    .map(
      (r) =>
        `  { name: ${JSON.stringify(r.name)}, lat: ${r.lat}, lng: ${r.lng}, ` +
        `roadKm: ${r.roadKm}${r.approx ? ', approx: true' : ''} },`,
    )
    .join('\n');

  const out = `/**
 * Ibadan areas with coordinates and driving distance from Bodija Market.
 * Generated by scripts/build-ibadan-areas.js — do not hand-edit, rerun instead.
 *
 * Coordinates come from OpenStreetMap; roadKm is real driving distance from
 * the OpenRouteService Matrix API. Both are resolved at build time because the
 * area list is fixed, so these values are constants — the running app makes no
 * geocoding or routing calls to price a known area.
 *
 * Delivery fees are computed from roadKm, so these are money-critical numbers.
 *
 * Data (c) OpenStreetMap contributors, ODbL 1.0 — https://osm.org/copyright
 * Routing (c) openrouteservice.org by HeiGIT | OpenStreetMap contributors
 */
export interface IbadanArea {
  name: string;
  lat: number;
  lng: number;
  /** Driving km from Bodija Market. */
  roadKm: number;
  /** True when routing was unavailable and this is a straight-line estimate. */
  approx?: boolean;
}

export const IBADAN_AREA_COORDS: IbadanArea[] = [
${body}
];
`;

  const dest = path.join(__dirname, '..', 'src', 'delivery', 'ibadan-areas.data.ts');
  fs.writeFileSync(dest, out, 'utf8');
  console.log(`\nWrote ${resolved.length} areas to ${dest}`);
})();
