import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AddressValidationService } from './address-validation.service';
import { matchIbadanArea } from './ibadan-areas.util';
import { OrsClient } from './ors.client';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

export interface DeliveryQuote {
  /** Naira amount to add to the order total. */
  fee: number;
  /** Road-adjusted km from the origin market, or null if not geocoded. */
  distanceKm: number | null;
  lat: number | null;
  lng: number | null;
  /** Best available display form of the address. */
  formattedAddress: string;
  neighborhood?: string;
  /** True when we could not geocode and fell back to the flat fee. */
  estimated: boolean;
  /** False when the address resolves outside the delivery area. */
  serviceable: boolean;
}

const EARTH_RADIUS_KM = 6371;

@Injectable()
export class DeliveryPricingService {
  private readonly logger = new Logger(DeliveryPricingService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly addressValidation: AddressValidationService,
    private readonly ors: OrsClient,
    private readonly prisma: PrismaService,
  ) {}

  /** Cache key: case and punctuation shouldn't create duplicate lookups. */
  private normalizeAddress(address: string): string {
    return address.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  private get rates() {
    return {
      originLat: this.config.get<number>('delivery.originLat') ?? 7.4359015,
      originLng: this.config.get<number>('delivery.originLng') ?? 3.9157404,
      originName:
        this.config.get<string>('delivery.originName') ?? 'Bodija Market',
      roadFactor: this.config.get<number>('delivery.roadFactor') ?? 1.3,
      baseFee: this.config.get<number>('delivery.baseFeeNaira') ?? 700,
      baseKm: this.config.get<number>('delivery.baseKm') ?? 3,
      perKm: this.config.get<number>('delivery.perKmNaira') ?? 150,
      maxFee: this.config.get<number>('delivery.maxFeeNaira') ?? 3000,
      roundTo: this.config.get<number>('delivery.roundToNaira') ?? 50,
      fallbackFee: this.config.get<number>('delivery.fallbackFeeNaira') ?? 700,
    };
  }

  get originName(): string {
    return this.rates.originName;
  }

  /**
   * Great-circle distance in km. Multiplied by a road factor by the caller —
   * streets never run in a straight line, so raw crow-flight under-charges.
   */
  private haversineKm(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /** Base fare covers the first baseKm; every km past that bills at perKm. */
  feeForDistanceKm(distanceKm: number): number {
    const { baseFee, baseKm, perKm, maxFee, roundTo } = this.rates;
    const billableKm = Math.max(0, distanceKm - baseKm);
    const raw = baseFee + billableKm * perKm;
    const rounded = Math.ceil(raw / roundTo) * roundTo;
    return Math.min(rounded, maxFee);
  }

  /** Road-adjusted distance from the origin market to a coordinate. */
  distanceFromOriginKm(lat: number, lng: number): number {
    const { originLat, originLng, roadFactor } = this.rates;
    const straight = this.haversineKm(originLat, originLng, lat, lng);
    return Math.round(straight * roadFactor * 100) / 100;
  }

  /** Quote from the area/landmark named in the address, if we recognise one. */
  quoteForNamedArea(address: string): DeliveryQuote | null {
    const match = matchIbadanArea(address);
    if (!match) return null;

    // roadKm is real driving distance precomputed at build time; only fall back
    // to the straight-line estimate if an entry somehow lacks it.
    const distanceKm =
      match.area.roadKm ??
      this.distanceFromOriginKm(match.area.lat, match.area.lng);
    return {
      fee: this.feeForDistanceKm(distanceKm),
      distanceKm,
      lat: match.area.lat,
      lng: match.area.lng,
      formattedAddress: address,
      neighborhood: match.area.name,
      estimated: false,
      serviceable: true,
    };
  }

  /**
   * Geocodes an unrecognised address and routes it for real driving distance.
   *
   * Returns null unless both steps genuinely succeed. OrsClient already
   * rejects city-centroid fallbacks and out-of-Ibadan hits, so reaching here
   * with a coordinate means it's a real, specific place.
   */
  private async quoteByLiveLookup(
    address: string,
  ): Promise<DeliveryQuote | null> {
    const hit = await this.ors.geocode(address);
    if (!hit) return null;

    const { originLat, originLng, roadFactor } = this.rates;
    const routed = await this.ors.drivingDistanceKm(
      { lat: originLat, lng: originLng },
      { lat: hit.lat, lng: hit.lng },
    );

    // If routing is unavailable we still have a trustworthy coordinate, so
    // approximate rather than throwing the lookup away.
    const distanceKm =
      routed != null
        ? Math.round(routed * 100) / 100
        : Math.round(
            this.haversineKm(originLat, originLng, hit.lat, hit.lng) *
              roadFactor *
              100,
          ) / 100;

    this.logger.log(
      `Priced "${address}" via live lookup → "${hit.label}" (${hit.layer}) — ` +
        `${distanceKm}km${routed == null ? ' (approximated, routing unavailable)' : ''}`,
    );

    return {
      fee: this.feeForDistanceKm(distanceKm),
      distanceKm,
      lat: hit.lat,
      lng: hit.lng,
      formattedAddress: hit.label,
      estimated: routed == null,
      serviceable: true,
    };
  }

  /** Best-effort cache write; a failure here must never break checkout. */
  private async cacheResult(
    normalized: string,
    rawAddress: string,
    quote: DeliveryQuote,
    source: string,
  ): Promise<void> {
    if (quote.lat == null || quote.lng == null || quote.distanceKm == null) {
      return;
    }
    try {
      await this.prisma.geocodeCache.upsert({
        where: { normalized },
        create: {
          normalized,
          rawAddress,
          lat: quote.lat,
          lng: quote.lng,
          label: quote.formattedAddress,
          distanceKm: new Prisma.Decimal(quote.distanceKm.toFixed(2)),
          source,
        },
        update: {},
      });
    } catch (err) {
      this.logger.warn(`Geocode cache write failed: ${(err as Error).message}`);
    }
  }

  /** Quote directly from coordinates we already hold. */
  quoteForCoords(lat: number, lng: number, formattedAddress = ''): DeliveryQuote {
    const distanceKm = this.distanceFromOriginKm(lat, lng);
    return {
      fee: this.feeForDistanceKm(distanceKm),
      distanceKm,
      lat,
      lng,
      formattedAddress,
      estimated: false,
      serviceable: true,
    };
  }

  /**
   * Geocode a free-text address and price the delivery from it.
   *
   * Never throws and never blocks checkout: if Google is unreachable or the
   * address is too vague to geocode, the flat fallback fee is charged and the
   * quote is marked `estimated` so the customer can be told it may be adjusted.
   */
  async quoteForAddress(address: string): Promise<DeliveryQuote> {
    const { fallbackFee } = this.rates;

    const fallback = (
      serviceable: boolean,
      formatted = address,
      neighborhood?: string,
    ): DeliveryQuote => ({
      fee: fallbackFee,
      distanceKm: null,
      lat: null,
      lng: null,
      formattedAddress: formatted,
      neighborhood,
      estimated: true,
      serviceable,
    });

    if (!address || !address.trim()) return fallback(false);

    // 1. Cache. Addresses repeat heavily, so this is the common path.
    const normalized = this.normalizeAddress(address);
    try {
      const cached = await this.prisma.geocodeCache.findUnique({
        where: { normalized },
      });
      if (cached) {
        const distanceKm = Number(cached.distanceKm);
        return {
          fee: this.feeForDistanceKm(distanceKm),
          distanceKm,
          lat: cached.lat,
          lng: cached.lng,
          formattedAddress: cached.label || address,
          estimated: false,
          serviceable: true,
        };
      }
    } catch (err) {
      this.logger.warn(`Geocode cache read failed: ${(err as Error).message}`);
    }

    // 2. Named-area match: instant, free, and built from verified coordinates
    // with real routed distances. Best for the landmark-style addresses
    // customers actually send.
    const named = this.quoteForNamedArea(address);
    if (named) {
      this.logger.log(
        `Priced "${address}" via area "${named.neighborhood}" — ${named.distanceKm}km, ₦${named.fee}`,
      );
      await this.cacheResult(normalized, address, named, 'area');
      return named;
    }

    // 3. Live lookup for anything we don't recognise: geocode, then route.
    const live = await this.quoteByLiveLookup(address);
    if (live) {
      await this.cacheResult(normalized, address, live, 'ors');
      return live;
    }

    let validated: Awaited<
      ReturnType<AddressValidationService['validateAddress']>
    > = null;
    try {
      validated = await this.addressValidation.validateAddress(address);
    } catch (err) {
      this.logger.error(
        `Address validation threw while quoting "${address}"`,
        err as Error,
      );
      return fallback(true);
    }

    if (!validated) return fallback(false);
    if (!validated.isInIbadan) {
      return fallback(false, validated.formatted, validated.neighborhood);
    }

    // The keyless/offline fallback path returns 0,0 — no coordinates means no
    // distance, so charge the flat fee rather than pricing off the Gulf of Guinea.
    if (!validated.lat || !validated.lng) {
      this.logger.warn(
        `No coordinates for "${address}" — charging fallback delivery fee`,
      );
      return fallback(true, validated.formatted, validated.neighborhood);
    }

    const distanceKm = this.distanceFromOriginKm(validated.lat, validated.lng);

    return {
      fee: this.feeForDistanceKm(distanceKm),
      distanceKm,
      lat: validated.lat,
      lng: validated.lng,
      formattedAddress: validated.formatted,
      neighborhood: validated.neighborhood,
      estimated: false,
      serviceable: true,
    };
  }

  /** One-line summary for receipts and WhatsApp messages. */
  describe(quote: DeliveryQuote): string {
    if (quote.estimated || quote.distanceKm === null) {
      return `₦${quote.fee.toLocaleString('en-NG')} (estimated)`;
    }
    return `₦${quote.fee.toLocaleString('en-NG')} (${quote.distanceKm.toFixed(1)}km from ${this.originName})`;
  }
}
