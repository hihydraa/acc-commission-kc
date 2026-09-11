import type { SaleType } from "@/lib/calc/commissionEngine";
import type { FreightTier } from "@/lib/calc/freightTable";
import type { TeamSplitConfig } from "@/lib/calc/teamSplit";

/**
 * Everything the marketing-commission-calc pipeline needs that is SPECIFIC
 * to one branch/BU. The pipeline logic (parse -> filter -> classify ->
 * compute -> debt-match -> aggregate -> team-split -> workbook) is shared
 * across every branch; only the numbers below differ, and every field here
 * must be reconfirmed with the user for a branch this hasn't been built for
 * yet — never copy สามทอง's values onto a new branch (SKILL.md §"Data-
 * completeness gate" item 6).
 */
export interface MasterOverrideRow {
  customerCode: string;
  customerName: string;
  productCode?: string | null;
  distanceKm: number | null;
  salesperson: string;
  tag?: "1สาย1สู้" | "ทางผ่าน" | "";
  /** why this row isn't in the master PDF and who confirmed it, e.g.
   *  "ผู้ใช้ยืนยันทางแชท 2569-09-11 — ใช้เส้นทางเดียวกับ ST579612" */
  source: string;
}

export interface ExcludedCustomer {
  customerCode: string;
  customerName: string;
  reason: string; // e.g. "รถมิเตอร์ — ATA ปิโตรเลียม"
}

export interface BranchConfig {
  id: string;
  label: string; // e.g. "สามทอง/โลจิสติกส์"
  companyName: string; // e.g. "หจก.สามทองบริการ"

  /** normalized product codes counted as "น้ำมันใส" for this branch, e.g. DS/G91/G95 */
  fuelProductCodes: string[];
  minQtyLiters: number;
  requireExactMultiple: boolean;
  qtyMultipleOf: number;

  /** first letter of the sales document number -> ประเภท, e.g. {H: cash, I: credit} */
  docPrefixToSaleType: Record<string, SaleType>;

  thresholds: { cash: number; credit: number; overdue: number };
  ratePerLiter: number;
  penaltyNegativeQEnabled: boolean;

  freightTiers: FreightTier[];

  /** the branch's recognized marketing เซลล์ — anyone else the master file
   *  resolves to gets their commission forced to 0 */
  salespersonRoster: string[];

  excludedCustomers: ExcludedCustomer[];
  masterOverrides: MasterOverrideRow[];

  teamSplit: TeamSplitConfig;

  /** freeform policy caveats always surfaced in the หมายเหตุ sheet, e.g. the
   *  negative-Q penalty disclaimer and the manual 50%/100% overdue-debt
   *  pay-reduction rule from the Incentive policy that this tool does NOT
   *  automate (see marketing-commission-calc/references/incentive-policy-mapping.md) */
  standingNotes: string[];
}
