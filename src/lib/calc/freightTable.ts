/**
 * Freight (ค่าขนส่ง) lookup by distance. Distances outside the table (or a
 * fractional distance falling between two integer tier boundaries) must
 * BLOCK the row for manual review — never silently default to 0, which
 * would overstate profit-per-liter and overpay commission. The
 * marketing-commission-calc SKILL's own reference table (formulas.md) is
 * used as the default for สาขาสามทอง; other branches may need their own.
 */

export interface FreightTier {
  minKm: number;
  maxKm: number;
  rate: number;
}

export const DEFAULT_FREIGHT_TIERS: FreightTier[] = [
  { minKm: 0, maxKm: 19, rate: 0 },
  { minKm: 20, maxKm: 59, rate: 0.15 },
  { minKm: 60, maxKm: 69, rate: 0.17 },
  { minKm: 70, maxKm: 79, rate: 0.19 },
  { minKm: 80, maxKm: 89, rate: 0.2 },
  { minKm: 90, maxKm: 99, rate: 0.22 },
  { minKm: 100, maxKm: 109, rate: 0.24 },
  { minKm: 110, maxKm: 129, rate: 0.28 },
  { minKm: 130, maxKm: 139, rate: 0.3 },
  { minKm: 140, maxKm: 159, rate: 0.32 },
  { minKm: 160, maxKm: 169, rate: 0.34 },
  { minKm: 170, maxKm: 179, rate: 0.35 },
  { minKm: 180, maxKm: 189, rate: 0.36 },
  { minKm: 190, maxKm: 199, rate: 0.38 },
  { minKm: 200, maxKm: 209, rate: 0.39 },
];

export const FREIGHT_BLOCK = "BLOCK" as const;

export function lookupFreightRate(
  distanceKm: number,
  tiers: FreightTier[] = DEFAULT_FREIGHT_TIERS
): number | typeof FREIGHT_BLOCK {
  if (distanceKm < 0) return FREIGHT_BLOCK;
  for (const tier of tiers) {
    if (distanceKm >= tier.minKm && distanceKm <= tier.maxKm) return tier.rate;
  }
  return FREIGHT_BLOCK;
}
