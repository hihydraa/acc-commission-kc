import Decimal from "decimal.js";
import { DEFAULT_FREIGHT_TIERS, FREIGHT_BLOCK, lookupFreightRate, type FreightTier } from "./freightTable";

export type SaleType = "cash" | "credit" | "overdue";

/**
 * Mirrors — deliberately, cell for cell — the live Excel formulas baked
 * into Template_คำนวณค่าคอมการตลาด.xlsx (see excelExport.ts, which emits
 * those exact formula strings into the delivered workbook). This module is
 * the "independent calculation" the marketing-commission-calc SKILL asks
 * for before delivering a file ("ควรเช็คผลลัพธ์ที่คำนวณใหม่เทียบกับการคำนวณ
 * อิสระ") — so it must reproduce the SAME edge-case behavior as those
 * formulas, not a stricter one, or the cross-check is comparing two
 * different specs instead of verifying one.
 *
 * M (ค่าขนส่ง/ลิตร) ALWAYS blocks when it can't be resolved — a missing
 * distance, a distance outside the freight table, and no fixed rate/tag-zero
 * override all leave the row unresolved rather than silently defaulting to
 * 0 (สามทอง's old per-branch behavior, dropped 2026-09-18: a guessed M=0
 * understates ค่าขนส่ง and overpays commission, exactly the bug กระนวน's v2
 * spec found). The confirmation page (src/app/confirm) is what resolves
 * these before final calculation runs, for every branch — so nothing ever
 * reaches this function still needing a guess.
 */
export interface EligibilityConfig {
  fuelProductCodes: Set<string>;
  minQtyLiters: number;
  requireExactMultiple: boolean;
  qtyMultipleOf: number;
  /** the branch's recognized เซลล์ roster (Master!H in the template) — a
   *  resolved salesperson NOT in this set forces commission to 0, matching
   *  the template's `COUNTIF(Master!$H$2:$H$50,S)=0` check */
  salespersonRoster: Set<string>;
}

export interface CommissionThresholds {
  cash: number;
  credit: number;
  overdue: number;
}

export interface CommissionConfig {
  thresholds: CommissionThresholds;
  ratePerLiter: number;
  /** NOT written in the company's Incentive policy — see
   *  references/incentive-policy-mapping.md — always surface this to the
   *  user even though it defaults on (matched every real transaction seen
   *  so far). */
  penaltyNegativeQEnabled: boolean;
}

export interface TransactionInput {
  id: string;
  productCode: string;
  qty: number;
  saleValue: number;
  cost: number;
  customerCode: string;
  distanceKm: number | null;
  /** null = look up ค่าขนส่ง/ลิตร from the freight table as usual; a number
   *  overrides the table entirely (e.g. กระนวน B3's fixed 0.10) */
  fixedFreightRate: number | null;
  /** the "1สาย1สู้" tag, or "ทางผ่าน" / no master row at all — every one of
   *  these zeroes the freight rate per the template's M formula */
  freightForcedZero: boolean;
  /** true if this customer/product had ANY row in Master at all (file or
   *  config override) — false means the template's VLOOKUP would return ""
   *  and silently fall through to M=0; surfaced as a flag, not a block */
  masterFound: boolean;
  saleType: SaleType | "unknown";
  /** the เซลล์ resolved via the Master sheet for this customer, if any */
  salesperson: string | null;
}

export interface TransactionCalcResult {
  /** true once product/qty/round-multiple scope (column V, "เข้าเกณฑ์ปริมาณ") passes */
  qualifiesByQty: boolean;
  flags: string[];
  /** true when freightMissingBehavior="block" and M genuinely can't be
   *  computed (missing/out-of-range distance, no fixed rate, not tag-zeroed)
   *  — L/N/O/P/Q/commission are all null in this case, the row still needs a
   *  human to supply a distance or confirm 1สาย1สู้/ทางผ่าน before it counts
   *  toward any total. */
  blocked: boolean;
  blockedReason: string | null;
  grossProfit: number; // L
  freightRate: number | null; // M — null only when blocked
  freightTotal: number | null; // N
  totalCost: number | null; // O
  profitAfterFreight: number | null; // P
  profitPerLiter: number | null; // Q
  /** T — a number, OR a literal sentinel string when ประเภท can't be
   *  resolved or the row is blocked (SUM() in Excel silently skips text, so
   *  this stays visible in the cell without breaking downstream totals) */
  commission: number | "ตรวจสอบประเภท(R)" | "ต้องตรวจสอบระยะทาง(M)";
  /** commission as a plain number for aggregation (0 for any sentinel) */
  commissionNumeric: number;
}

function passesQtyRule(qty: number, config: EligibilityConfig): boolean {
  if (qty < config.minQtyLiters) return false;
  if (config.requireExactMultiple && qty % config.qtyMultipleOf !== 0) return false;
  return true;
}

export function calculateTransaction(
  tx: TransactionInput,
  config: CommissionConfig,
  eligibility: EligibilityConfig,
  freightTiers: FreightTier[] = DEFAULT_FREIGHT_TIERS
): TransactionCalcResult {
  const flags: string[] = [];
  if (!tx.masterFound) {
    flags.push("ไม่พบลูกค้านี้ในข้อมูล master เลย — ต้องเพิ่มระยะทาง/เซลล์ก่อนจึงจะคำนวณค่าคอมได้");
  }

  const qualifiesByQty = eligibility.fuelProductCodes.has(tx.productCode) && passesQtyRule(tx.qty, eligibility);

  let M: Decimal | null;
  let blocked = false;
  let blockedReason: string | null = null;
  if (tx.freightForcedZero) {
    M = new Decimal(0);
  } else if (tx.fixedFreightRate !== null) {
    M = new Decimal(tx.fixedFreightRate);
  } else if (tx.distanceKm === null) {
    M = null;
    blocked = true;
    blockedReason = "ไม่มีระยะทางในข้อมูล master — ต้องกรอกระยะทางหรือติ๊ก 1สาย1สู้/ทางผ่านก่อน";
  } else {
    const rate = lookupFreightRate(tx.distanceKm, freightTiers);
    if (rate === FREIGHT_BLOCK) {
      M = null;
      blocked = true;
      blockedReason = `ระยะทาง ${tx.distanceKm} กม. เกิน 209 กม. หรือไม่อยู่ในตารางค่าขนส่ง — ต้องระบุค่าขนส่ง/ลิตรเองก่อน`;
    } else {
      M = new Decimal(rate);
    }
  }

  if (blocked || M === null) {
    return {
      qualifiesByQty,
      flags,
      blocked: true,
      blockedReason,
      grossProfit: new Decimal(tx.saleValue).minus(tx.cost).toNumber(),
      freightRate: null,
      freightTotal: null,
      totalCost: null,
      profitAfterFreight: null,
      profitPerLiter: null,
      commission: "ต้องตรวจสอบระยะทาง(M)",
      commissionNumeric: 0,
    };
  }

  const L = new Decimal(tx.saleValue).minus(tx.cost);
  const N = M.times(tx.qty);
  const O = N.plus(tx.cost);
  const P = new Decimal(tx.saleValue).minus(O);
  const Q = tx.qty === 0 ? new Decimal(0) : P.div(tx.qty);

  // Mirrors the template's T formula exactly: OR(I="",R="") -> 0; then the
  // qty/multiple-of-1000 gate -> 0; then the roster COUNTIF gate -> 0; then
  // the per-ประเภท threshold tiers; ประเภท not one of the 3 known values ->
  // the "ตรวจสอบประเภท(R)" text sentinel (not silently 0 or 0.60-tier).
  let commission: number | "ตรวจสอบประเภท(R)";
  if (!qualifiesByQty) {
    commission = 0;
  } else if (tx.salesperson === null || !eligibility.salespersonRoster.has(tx.salesperson)) {
    commission = 0;
    if (tx.salesperson) flags.push(`เซลล์ "${tx.salesperson}" ไม่อยู่ใน roster ของสาขานี้ — บังคับค่าคอมเป็น 0`);
  } else if (tx.saleType === "unknown") {
    commission = "ตรวจสอบประเภท(R)";
  } else if (Q.isNegative()) {
    if (config.penaltyNegativeQEnabled) {
      commission = new Decimal(config.ratePerLiter).times(tx.qty).negated().toNumber();
      flags.push("Q ติดลบ — หัก 3 สต./ลิตร (แนวปฏิบัติภายใน ไม่ได้เขียนไว้ในประกาศ Incentive)");
    } else {
      commission = 0;
    }
  } else {
    const threshold = config.thresholds[tx.saleType];
    commission = Q.gte(threshold) ? new Decimal(config.ratePerLiter).times(tx.qty).toNumber() : 0;
  }

  return {
    qualifiesByQty,
    flags,
    blocked: false,
    blockedReason: null,
    grossProfit: L.toNumber(),
    freightRate: M.toNumber(),
    freightTotal: N.toNumber(),
    totalCost: O.toNumber(),
    profitAfterFreight: P.toNumber(),
    profitPerLiter: Q.toNumber(),
    commission,
    commissionNumeric: typeof commission === "number" ? commission : 0,
  };
}
