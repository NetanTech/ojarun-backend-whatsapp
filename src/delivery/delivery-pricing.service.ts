import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AddressValidationService } from './address-validation.service';
import { matchIbadanArea } from './ibadan-areas.util';

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
  ) {}

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

    const distanceKm = this.distanceFromOriginKm(
      match.area.lat,
      match.area.lng,
    );
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

    // Named-area match first: it's free, instant, needs no API key, and for
    // landmark-style addresses it beats asking a geocoder to parse the street.
    const named = this.quoteForNamedArea(address);
    if (named) {
      this.logger.log(
        `Priced "${address}" via area "${named.neighborhood}" — ${named.distanceKm}km, ₦${named.fee}`,
      );
      return named;
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
