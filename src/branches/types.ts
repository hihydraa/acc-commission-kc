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
  /** set when this row's distance/เซลล์ was copied from another customer's
   *  confirmed master row rather than given directly (SKILL: "ใช้เส้นทาง/
   *  ระยะทางเดียวกับ [an existing master entry]" — must still be recorded as
   *  its own row with a "ที่มา" note explaining the reuse, never a silent
   *  alias) */
  reuseFromCustomerCode?: string;
}

export interface ExcludedCustomer {
  customerCode: string;
  customerName: string;
  reason: string; // e.g. "รถมิเตอร์ — ATA ปิโตรเลียม"
}

/**
 * A branch whose sales files self-identify a "เลือกแผนก" (department) code in
 * their header — e.g. กระนวน's A7/B7/68/B3 — needs its own qty threshold and
 * freight rule PER DEPARTMENT rather than one flat branch-wide rule (สามทอง's
 * model). Set `BranchConfig.departments` for this case instead of the flat
 * minQtyLiters/requireExactMultiple/qtyMultipleOf fields; the pipeline reads
 * `parseSalesReportText()`'s already-extracted `truckCode` (the "เลือกแผนก"
 * value) to pick the matching entry per uploaded file.
 */
export interface DepartmentConfig {
  code: string; // e.g. 'A7', 'B7', '68', 'B3' — matches the "เลือกแผนก" header value
  label: string; // e.g. "เบอร์60" — used as the sheet name
  docPrefixes: string[]; // e.g. ['HDA','IDA'] — validation only, warns on a mismatched upload
  minQtyLiters: number;
  requireExactMultiple: boolean;
  qtyMultipleOf: number;
  /** null = use the branch's freightTiers table; a number overrides the
   *  table entirely with a fixed ค่าขนส่ง/ลิตร (e.g. กระนวน B3's 0.10) */
  fixedFreightRate: number | null;
  /** null = resolve เซลล์ per customer via the master file, as usual. A name
   *  means every transaction in this department belongs to that one เซลล์
   *  regardless of customer — confirmed for กระนวน B3 (กรอกหลังปั๊ม) directly
   *  with the user: that department's customers (filled at the pump, not on
   *  a delivery route) never appear in the distance/เซลล์ master file at
   *  all, and the whole department is one เซลล์'s alone (ยืนยันจากผู้ใช้). */
  fixedSalesperson: string | null;
  /** customers excluded from THIS department only — separate from
   *  BranchConfig.excludedCustomers (the flat/filename-classified scope),
   *  because the same branch can have a customer excluded in one channel
   *  but not another. Confirmed with the user (14 ก.ย.69): สามทอง's
   *  ST57039 (ATA ปิโตรเลียม) is excluded from the regular-truck scope
   *  specifically (a มิเตอร์-truck driver's customer, unrelated to
   *  กรอกหลังปั๊ม) — a single shared branch-wide list would have wrongly
   *  implied it applied to กรอกหลังปั๊ม too, or mislabeled the section as
   *  "กรอกหลังปั๊ม-only" when it wasn't. */
  excludedCustomers: ExcludedCustomer[];
}

export interface BranchConfig {
  id: string;
  label: string; // e.g. "สามทอง/โลจิสติกส์"
  companyName: string; // e.g. "หจก.สามทองบริการ"

  /** Period this config's masterOverrides/exclusions were confirmed for —
   *  e.g. periodLabel "8/69", periodLabelThai "ส.ค. 2569". A future month
   *  needs its own re-confirmation (SKILL: never reuse without asking), so
   *  these are descriptive labels for the หมายเหตุ/Master sheets, not a
   *  guarantee the override data still applies next month. */
  periodLabel: string;
  periodLabelThai: string;
  dataFolderLabel: string; // e.g. "ST_8.69" — the source-file folder name, for the หมายเหตุ sheet
  masterFileLabel: string; // e.g. "ระยะทาง และ พนักงานขาย.pdf"
  arAsOfLabel: string; // e.g. "7 ก.ย.69" — the debtor report's as-of date, as printed
  confirmDateLabel: string; // e.g. "10 ก.ย.69" — when the user confirmed the overrides/exclusions below

  /** normalized product codes counted as "น้ำมันใส" for this branch, e.g. DS/G91/G95 */
  fuelProductCodes: string[];
  /** Flat single-scope model (สามทอง). Omit all three and set `departments`
   *  instead for a branch classified by "เลือกแผนก" (กระนวน). */
  minQtyLiters?: number;
  requireExactMultiple?: boolean;
  qtyMultipleOf?: number;
  /** per-department qty threshold + freight override, keyed by the sales
   *  file's own "เลือกแผนก" header value — see DepartmentConfig. */
  departments?: DepartmentConfig[];

  /** first letter of the sales document number -> ประเภท, e.g. {H: cash, I: credit} */
  docPrefixToSaleType: Record<string, SaleType>;

  thresholds: { cash: number; credit: number; overdue: number };
  ratePerLiter: number;
  penaltyNegativeQEnabled: boolean;

  freightTiers: FreightTier[];
  /** How a matched outstanding-debt bill affects a เซลล์'s ค่าคอมสุทธิ.
   *  "auto" (สามทอง's approved template + ST_8.69 reference, confirmed
   *  nonzero ฿180 deduction that month) subtracts the matched bill's full
   *  commission automatically. "flagOnly" (กระนวน's own approved reference
   *  workbook, its หมายเหตุ sheet item 5: "คำนวณเต็มจำนวนไปก่อนแล้วทำ
   *  เครื่องหมายเตือนบัญชี... ตั้งค่าเริ่มต้น = 0") computes and lists the
   *  matched bills for visibility only — the deduction actually applied
   *  stays 0, because that branch's policy items 6-7 (cut to 50% if still
   *  unpaid past credit term, full 100% if the customer commits to a
   *  payment schedule) is accounting's own manual judgment call, not a
   *  formula. Never assume one branch's mode for the other. */
  debtDeductionMode: "auto" | "flagOnly";
  /** what M (ค่าขนส่ง/ลิตร) should do when a qualifying row's distance is
   *  missing from Master or falls outside freightTiers, and no fixed rate
   *  applies. "defaultZero" (สามทอง's approved template behavior) computes
   *  M=0 and just flags it for review; "block" (กระนวน's confirmed v2 spec —
   *  a stricter rule found necessary for that branch after v1 silently
   *  defaulting to 0 was found to overpay commission) refuses to compute a
   *  number at all until the row is resolved. Branch-specific — never
   *  assume one applies to the other. */
  freightMissingBehavior: "defaultZero" | "block";

  /** the branch's recognized marketing เซลล์ — anyone else the master file
   *  resolves to gets their commission forced to 0 */
  salespersonRoster: string[];

  /** customers excluded from the branch's FLAT/filename-classified scope
   *  (regular trucks) — a department (DepartmentConfig.excludedCustomers)
   *  has its own separate list, since exclusion can genuinely differ by
   *  channel within the same branch (see that field's comment). For a
   *  fully department-based branch (กระนวน — no flat scope at all) this
   *  stays an empty array; it's never used. */
  excludedCustomers: ExcludedCustomer[];
  masterOverrides: MasterOverrideRow[];

  teamSplit: TeamSplitConfig;

  /** freeform policy caveats always surfaced in the หมายเหตุ sheet, e.g. the
   *  negative-Q penalty disclaimer and the manual 50%/100% overdue-debt
   *  pay-reduction rule from the Incentive policy that this tool does NOT
   *  automate (see marketing-commission-calc/references/incentive-policy-mapping.md) */
  standingNotes: string[];
}
