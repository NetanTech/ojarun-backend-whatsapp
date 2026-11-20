import { ConfigService } from '@nestjs/config';

/**
 * Service ("shopper") fee rule: a fixed amount per band of cart value.
 *
 * Default bands (owner's breakdown): up to ₦15,099 → ₦1,500,
 * ₦15,100–₦30,099 → ₦3,000, ₦30,100–₦45,099 → ₦4,500, and so on with no cap.
 * `edge` is the ₦100 offset that makes each band start at 15,100 / 30,100…
 */
export type ServiceFeeRule = {
  /** Naira charged per band. */
  perBand: number;
  /** Width of each band in naira. */
  bandSize: number;
  /** Bands start this many naira after each multiple of bandSize. */
  edge: number;
};

export function serviceFeeRuleFrom(config: ConfigService): ServiceFeeRule {
  return {
    perBand: config.get<number>('fees.serviceFeePerBandNaira') ?? 1500,
    bandSize: config.get<number>('fees.serviceFeeBandNaira') ?? 15000,
    edge: config.get<number>('fees.serviceFeeBandEdgeNaira') ?? 100,
  };
}

/**
 * Fee for an items subtotal (before promo discounts). Always at least one band.
 * Examples with the defaults: 15,000 → 1,500; 15,100 → 3,000;
 * 63,000 → 7,500; 138,000 → 15,000.
 */
export function serviceFeeFor(subtotal: number, rule: ServiceFeeRule): number {
  if (!Number.isFinite(subtotal) || subtotal <= 0) return rule.perBand;
  const bands = Math.max(1, Math.floor((subtotal - rule.edge) / rule.bandSize) + 1);
  return bands * rule.perBand;
}
