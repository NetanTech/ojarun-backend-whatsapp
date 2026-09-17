import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as https from 'https';

export interface OrsGeocodeHit {
  lat: number;
  lng: number;
  label: string;
  layer: string;
  confidence: number;
}

/**
 * Anything outside this is not an Ibadan delivery. Pelias will happily return
 * a same-named town in another state (searching "Apata, Ibadan" returns an
 * Apata ~70km north with match_type "exact"), so a bounds check is mandatory
 * even for high-confidence hits.
 */
const IBADAN_BOUNDS = { south: 7.15, north: 7.65, west: 3.7, east: 4.1 };

/**
 * Pelias never says "not found". When it can't resolve a query it returns the
 * enclosing city with match_type "fallback" — the query "total nonsense place
 * zzzz" and the query "Soka" both come back as the centre of Ibadan. Treating
 * those as real would price every unresolvable address as city-centre, so
 * fallback matches are rejected outright.
 */
const UNTRUSTWORTHY_MATCH_TYPES = new Set(['fallback']);

/**
 * Generic address furniture. These carry no location meaning, but a geocoder
 * will happily match on them: "House 14, Ologuneru road" returned a venue
 * called "DG house" 9km away because it matched the word "house". Comparing
 * only the meaningful words catches that.
 */
const ADDRESS_STOPWORDS = new Set([
  'house', 'street', 'road', 'close', 'avenue', 'estate', 'lane', 'way',
  'junction', 'roundabout', 'bus', 'stop', 'block', 'flat', 'plot', 'apartment',
  'opposite', 'behind', 'beside', 'near', 'off', 'the', 'and', 'for',
  'ibadan', 'oyo', 'nigeria', 'state', 'express', 'expressway', 'area',
]);

const significantTokens = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !ADDRESS_STOPWORDS.has(t) && !/^\d+$/.test(t)),
  );

/** City/region-level layers are too coarse to price a delivery from. */
const COARSE_LAYERS = new Set([
  'locality',
  'region',
  'country',
  'county',
  'macroregion',
  'localadmin',
]);

@Injectable()
export class OrsClient {
  private readonly logger = new Logger(OrsClient.name);

  private readonly http: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    // Local SSL inspection / corporate MITM breaks cert verification the same
    // way it does for Meta and Cloudinary. Same opt-out as those clients:
    // non-production only, never in prod unless explicitly forced.
    const tlsInsecure =
      this.config.get<boolean>('ors.tlsInsecure') === true ||
      (this.config.get<string>('env') ?? 'development') !== 'production';

    this.http = axios.create({
      timeout: 12_000,
      ...(tlsInsecure
        ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) }
        : {}),
    });
  }

  get isConfigured(): boolean {
    return !!this.config.get<string>('ors.apiKey');
  }

  private get apiKey(): string {
    return this.config.get<string>('ors.apiKey') ?? '';
  }

  private get baseUrls(): string[] {
    return (
      this.config.get<string[]>('ors.baseUrls') ?? [
        'https://api.openrouteservice.org',
      ]
    );
  }

  static isInIbadan(lat: number, lng: number): boolean {
    return (
      lat >= IBADAN_BOUNDS.south &&
      lat <= IBADAN_BOUNDS.north &&
      lng >= IBADAN_BOUNDS.west &&
      lng <= IBADAN_BOUNDS.east
    );
  }

  /**
   * Resolves an address to a coordinate, or null when it can't be trusted.
   *
   * Returns null rather than a best guess: a wrong coordinate produces a wrong
   * delivery fee, which is worse than falling back to a known-safe path.
   */
  async geocode(address: string): Promise<OrsGeocodeHit | null> {
    if (!this.isConfigured || !address?.trim()) return null;

    for (const base of this.baseUrls) {
      try {
        const res = await this.http.get(`${base}/geocode/search`, {
          params: {
            api_key: this.apiKey,
            text: address,
            'boundary.country': 'NG',
            // Bias toward Ibadan so same-named places elsewhere rank lower.
            'focus.point.lat': 7.3775,
            'focus.point.lon': 3.947,
            size: 1,
          },
          timeout: 12_000,
        });

        const feature = res.data?.features?.[0];
        if (!feature) return null;

        const props = feature.properties ?? {};
        const [lng, lat] = feature.geometry?.coordinates ?? [];
        if (typeof lat !== 'number' || typeof lng !== 'number') return null;

        if (UNTRUSTWORTHY_MATCH_TYPES.has(props.match_type)) {
          this.logger.debug(
            `Geocode for "${address}" was a ${props.match_type} to "${props.label}" — rejected`,
          );
          return null;
        }
        if (COARSE_LAYERS.has(props.layer)) {
          this.logger.debug(
            `Geocode for "${address}" resolved only to ${props.layer} "${props.label}" — too coarse`,
          );
          return null;
        }
        if (!OrsClient.isInIbadan(lat, lng)) {
          this.logger.debug(
            `Geocode for "${address}" landed outside Ibadan (${lat}, ${lng}) — rejected`,
          );
          return null;
        }

        // The result must actually relate to what was asked for. When the
        // query has no meaningful words left (e.g. "Oyo road"), there's
        // nothing to compare, so fall back to trusting an exact match only.
        const wanted = significantTokens(address);
        const got = significantTokens(props.label ?? '');
        if (wanted.size > 0) {
          const shared = [...wanted].some((t) => got.has(t));
          if (!shared) {
            this.logger.debug(
              `Geocode for "${address}" returned unrelated "${props.label}" — rejected`,
            );
            return null;
          }
        } else if (props.match_type !== 'exact') {
          return null;
        }

        return {
          lat,
          lng,
          label: props.label ?? address,
          layer: props.layer ?? 'unknown',
          confidence: props.confidence ?? 0,
        };
      } catch (err) {
        this.logger.warn(
          `ORS geocode via ${base} failed: ${(err as Error).message}`,
        );
      }
    }
    return null;
  }

  /**
   * Real driving distance in km between two points, or null if ORS can't
   * route it (no mapped road nearby, quota exhausted, service down).
   */
  async drivingDistanceKm(
    from: { lat: number; lng: number },
    to: { lat: number; lng: number },
  ): Promise<number | null> {
    if (!this.isConfigured) return null;

    for (const base of this.baseUrls) {
      try {
        const res = await this.http.post(
          `${base}/v2/matrix/driving-car`,
          {
            // ORS takes [lng, lat] — the reverse of the usual order.
            locations: [
              [from.lng, from.lat],
              [to.lng, to.lat],
            ],
            sources: [0],
            destinations: [1],
            metrics: ['distance'],
            units: 'km',
          },
          {
            headers: {
              Authorization: this.apiKey,
              'Content-Type': 'application/json',
            },
            timeout: 12_000,
          },
        );

        const km = res.data?.distances?.[0]?.[0];
        if (typeof km === 'number' && isFinite(km)) return km;
        return null;
      } catch (err) {
        this.logger.warn(
          `ORS matrix via ${base} failed: ${(err as Error).message}`,
        );
      }
    }
    return null;
  }
}
