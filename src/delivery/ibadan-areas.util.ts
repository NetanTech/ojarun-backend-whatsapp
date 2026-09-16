import { IBADAN_AREA_COORDS, IbadanArea } from './ibadan-areas.data';

/**
 * Resolves a free-text Ibadan address to coordinates by finding the area or
 * landmark named inside it.
 *
 * Customers here describe delivery by landmark ("Olorukemi street 5 near ui",
 * "behind Bodija market"), not by a geocodable street address. Matching the
 * recognised area is both more reliable and cheaper than asking a geocoder to
 * interpret the whole string.
 */

/** Common ways customers refer to places that aren't the OSM name. */
const ALIASES: Record<string, string> = {
  UI: 'University of Ibadan',
  'U.I': 'University of Ibadan',
  UNIBADAN: 'University of Ibadan',
  'UI GATE': 'University of Ibadan',
  UCH: 'University College Hospital',
  POLY: 'Poly Road',
  'IBADAN POLY': 'Poly Road',
  'THE POLYTECHNIC': 'Poly Road',
  MAPO: 'Mapo Hall',
  'COCOA HOUSE': 'Cocoa House',
  'LIBERTY STADIUM': 'Lekan Salami Stadium',
  ADAMASINGBA: 'Adamasingba',
  'RING RD': 'Ring Road',
  BASHORUN: 'Basorun',
  'IWO RD': 'Iwo Road',
  AGBOWO: 'Agbowo',
  SANGO: 'Sango',
  DUGBE: 'Dugbe',
};

const byName = new Map(
  IBADAN_AREA_COORDS.map((a) => [a.name.toUpperCase(), a]),
);

/**
 * Candidate terms, longest first. Order matters: "New Bodija" and "Bodija
 * Market" must be tested before plain "Bodija", or every one of them collapses
 * to the same wrong point.
 */
const CANDIDATES: Array<{ term: string; area: IbadanArea }> = [
  ...IBADAN_AREA_COORDS.map((a) => ({ term: a.name.toUpperCase(), area: a })),
  ...Object.entries(ALIASES).flatMap(([alias, target]) => {
    const area = byName.get(target.toUpperCase());
    return area ? [{ term: alias.toUpperCase(), area }] : [];
  }),
].sort((a, b) => b.term.length - a.term.length);

/** Collapse punctuation and runs of whitespace so matching is predictable. */
function normalize(text: string): string {
  return ` ${text.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()} `;
}

export interface AreaMatch {
  area: IbadanArea;
  /** The term that matched — the customer's word, not necessarily the OSM name. */
  matchedTerm: string;
}

/**
 * Finds the most specific area named in an address, or null if none is.
 * Matching is whole-word so "Gate" inside "Gateway" can't produce a false hit.
 */
export function matchIbadanArea(address: string): AreaMatch | null {
  if (!address) return null;
  const haystack = normalize(address);

  for (const { term, area } of CANDIDATES) {
    if (haystack.includes(` ${term} `)) {
      return { area, matchedTerm: term };
    }
  }
  return null;
}

/** Every area name we know, for prompts and admin display. */
export function knownAreaNames(): string[] {
  return IBADAN_AREA_COORDS.map((a) => a.name).sort();
}
