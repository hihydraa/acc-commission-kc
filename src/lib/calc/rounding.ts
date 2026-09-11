import Decimal from "decimal.js";

/** Round-half-up to 2 decimal places (บาท.สตางค์) — avoids JS float banker's
 *  rounding surprises (0.1+0.2 etc.) on money totals. */
export function roundHalfUp2(value: number | Decimal): number {
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}
