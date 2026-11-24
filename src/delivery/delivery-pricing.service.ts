import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AddressValidationService } from './address-validation.service';
import { matchIbadanArea } from './ibadan-areas.util';
import { OrsClient } from './ors.client';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus, Prisma } from '@prisma/client';

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
      originLat: this.config.get<number>('delivery.originLat') ?? 7.4503374,
      originLng: this.config.get<number>('delivery.originLng') ?? 3.907946,
      originName:
        this.config.get<string>('delivery.originName') ?? 'UI Second Gate',
      roadFactor: this.config.get<number>('delivery.roadFactor') ?? 1.3,
      flatFee: this.config.get<number>('delivery.flatFeeNaira') ?? 1300,
      flatKm: this.config.get<number>('delivery.flatKm') ?? 4,
      baseFee: this.config.get<number>('delivery.baseFeeNaira') ?? 700,
      perKm: this.config.get<number>('delivery.perKmNaira') ?? 190,
      maxFee: this.config.get<number>('delivery.maxFeeNaira') ?? 0,
      roundTo: this.config.get<number>('delivery.roundToNaira') ?? 50,
      fallbackFee: this.config.get<number>('delivery.fallbackFeeNaira') ?? 1300,
    };
  }

  /**
   * Launch delivery discount for this customer's next order, or null.
   * Applies inside the promo window to their first `maxOrders` orders placed
   * since it started (website and WhatsApp), not counting cancelled ones.
   */
  async launchDiscountFor(
    customerId: string,
    now: Date = new Date(),
  ): Promise<{ percent: number; orderNumber: number; maxOrders: number } | null> {
    const percent = this.config.get<number>('delivery.launchPromo.percent') ?? 0;
    const maxOrders = this.config.get<number>('delivery.launchPromo.maxOrders') ?? 0;
    const start = new Date(this.config.get<string>('delivery.launchPromo.start') ?? '');
    const end = new Date(this.config.get<string>('delivery.launchPromo.end') ?? '');
    if (!(percent > 0) || !(maxOrders > 0)) return null;
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    if (now < start || now >= end) return null;

    const used = await this.prisma.order.count({
      where: {
        customerId,
        createdAt: { gte: start },
        status: { not: OrderStatus.cancelled },
      },
    });
    if (used >= maxOrders) return null;
    return { percent, orderNumber: used + 1, maxOrders };
  }

  /** Delivery fee after a percentage discount, to the nearest naira. */
  discountedFee(fee: number, percent: number): number {
    return Math.max(0, Math.round((fee * (100 - percent)) / 100));
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

  /**
   * Owner's formula: a flat fee up to flatKm; beyond that
   * baseFee + perKm × the whole distance, rounded to the nearest roundTo,
   * capped at maxFee only when one is set (0 = no cap).
   * E.g. 3 km → 1,300; 8.1 km → 700 + 190 × 8.1 = 2,239 → 2,250.
   */
  feeForDistanceKm(distanceKm: number): number {
    const { flatFee, flatKm, baseFee, perKm, maxFee, roundTo } = this.rates;
    if (distanceKm <= flatKm) return flatFee;
    const raw = baseFee + distanceKm * perKm;
    const rounded = roundTo > 0 ? Math.round(raw / roundTo) * roundTo : Math.round(raw);
    return maxFee > 0 ? Math.min(rounded, maxFee) : rounded;
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

    // The precomputed roadKm values were measured from the OLD origin (Bodija
    // Market), so they no longer apply. Measure from the current origin, the
    // same way a map pin is priced when road routing is unavailable.
    const distanceKm = this.distanceFromOriginKm(match.area.lat, match.area.lng);
    return {
      fee: this.feeForDistanceKm(distanceKm),
      distanceKm,
      lat: match.area.lat,
      lng: match.area.lng,
      formattedAddress: address,
      neighborhood: match.area.name,
      estimated: true,
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

  /**
   * Pin-first pricing: real road distance from the origin (UI Second Gate) to the customer's pin.
   * This is the only path web + WhatsApp should use for billing.
   */
  async quoteForCoords(
    lat: number,
    lng: number,
    formattedAddress = '',
  ): Promise<DeliveryQuote> {
    if (!OrsClient.isInIbadan(lat, lng)) {
      return {
        fee: 0,
        distanceKm: null,
        lat,
        lng,
        formattedAddress,
        estimated: false,
        serviceable: false,
      };
    }

    const { originLat, originLng, roadFactor } = this.rates;
    const routed = await this.ors.drivingDistanceKm(
      { lat: originLat, lng: originLng },
      { lat, lng },
    );

    const distanceKm =
      routed != null
        ? Math.round(routed * 100) / 100
        : Math.round(
            this.haversineKm(originLat, originLng, lat, lng) * roadFactor * 100,
          ) / 100;

    // Hard cap so a pin on the edge of the city bounds can't produce a
    // runaway fee (or an impossible ride) even when ORS returns a long path.
    const maxKm = this.config.get<number>('delivery.maxKm') ?? 35;
    if (distanceKm > maxKm) {
      return {
        fee: 0,
        distanceKm,
        lat,
        lng,
        formattedAddress,
        estimated: routed == null,
        serviceable: false,
      };
    }

    return {
      fee: this.feeForDistanceKm(distanceKm),
      distanceKm,
      lat,
      lng,
      formattedAddress,
      estimated: routed == null,
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
