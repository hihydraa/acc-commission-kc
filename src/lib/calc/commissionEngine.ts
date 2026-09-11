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
 * Key template behavior worth calling out because it's more lenient than a
 * naive read of the SKILL text would suggest: the M (ค่าขนส่ง/ลิตร) formula
 * NEVER blocks — a missing distance, a distance outside the freight table,
 * or a customer entirely absent from Master all resolve to M=0 rather than
 * an error. That is safe ONLY because the pipeline is expected to have
 * already resolved every qualifying customer's distance/เซลล์ into the
 * Master sheet (asking the user for anything missing) before this workbook
 * is finalized — so this module still raises a `flags` entry for "no master
 * row at all" and "distance outside the table" so those gaps stay visible
 * to a reviewer, even though the number itself doesn't stop being computed.
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
  grossProfit: number; // L
  freightRate: number; // M — never null, template default is 0
  freightTotal: number; // N
  totalCost: number; // O
  profitAfterFreight: number; // P
  profitPerLiter: number; // Q
  /** T — a number, OR the literal template sentinel string when ประเภท
   *  can't be resolved (SUM() in Excel silently skips text, so this stays
   *  visible in the cell without breaking downstream totals) */
  commission: number | "ตรวจสอบประเภท(R)";
  /** commission as a plain number for aggregation (0 when it's the sentinel) */
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
  if (!tx.masterFound) flags.push("ไม่พบลูกค้านี้ในไฟล์ master เลย — VLOOKUP ระยะทาง/เซลล์ว่าง, M=0 โดยดีฟอลต์ (ต้องยืนยันระยะทาง/เซลล์กับผู้ใช้)");

  const L = new Decimal(tx.saleValue).minus(tx.cost);

  let M: Decimal;
  if (tx.freightForcedZero) {
    M = new Decimal(0);
  } else if (tx.distanceKm === null) {
    M = new Decimal(0);
  } else {
    const rate = lookupFreightRate(tx.distanceKm, freightTiers);
    if (rate === FREIGHT_BLOCK) {
      flags.push(`ระยะทาง ${tx.distanceKm} กม. ไม่อยู่ในตารางค่าขนส่ง — ใช้ M=0 โดยดีฟอลต์ (ต้องตรวจสอบ)`);
      M = new Decimal(0);
    } else {
      M = new Decimal(rate);
    }
  }

  const N = M.times(tx.qty);
  const O = N.plus(tx.cost);
  const P = new Decimal(tx.saleValue).minus(O);
  const Q = tx.qty === 0 ? new Decimal(0) : P.div(tx.qty);

  const qualifiesByQty = eligibility.fuelProductCodes.has(tx.productCode) && passesQtyRule(tx.qty, eligibility);

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
