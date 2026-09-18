/**
 * Everything the marketing-commission-calc pipeline needs that is SPECIFIC
 * to one branch/BU. As of 2026-09-18 the pipeline logic AND the numeric
 * rules (qty threshold, freight handling, team-split %) are fully shared
 * across every branch — see `src/lib/calc/channelRules.ts`. What's left
 * here is only what's genuinely different per legal entity: its name, its
 * product SKU codes (confirmed to actually differ — e.g. มุกดาหาร's sales
 * system prints "DS-MUK"/"G95-MUK", not plain "DS"/"G95"), customers
 * excluded from marketing commission entirely, and freeform policy notes.
 * `salespersonRoster` is NOT listed here any more — it's derived at request
 * time from the branch's own Google Sheet tab (see src/lib/googleSheets.ts),
 * since a hardcoded array can't reflect staff moving between branches.
 */
export interface ExcludedCustomer {
  customerCode: string;
  customerName: string;
  reason: string; // e.g. "รถมิเตอร์ — ATA ปิโตรเลียม"
}

export interface BranchConfig {
  id: string;
  label: string; // e.g. "สามทอง/โลจิสติกส์"
  companyName: string; // e.g. "หจก.สามทองบริการ"

  /** name of this branch's tab in the Commission_Distance_Seller Google
   *  Sheet — e.g. "ST", "KN", "MUK", "VRN" */
  sheetTabName: string;

  /** normalized product codes counted as "น้ำมันใส" for this branch, e.g.
   *  DS/G91/G95 — confirmed to genuinely vary per branch's own sales-system
   *  SKU codes; never copy another branch's list without checking a real
   *  file (the pipeline's own "unrecognized product code" warning catches
   *  a wrong guess safely). */
  fuelProductCodes: string[];

  /** null = resolve เซลล์ per customer via the master data as usual (รถ
   *  มิเตอร์/เทรลเลอร์). A name means every "กรอกหลังปั๊ม" transaction belongs
   *  to that one เซลล์ regardless of customer — those customers are filled
   *  at the pump, not on a delivery route, so they never appear in the
   *  distance/เซลล์ master data at all (confirmed real for กระนวน's อ้อม).
   *  Editable at /settings (src/lib/settings.ts's BranchOverride), not
   *  hardcoded, so this can change without a redeploy. */
  pumpFillSalesperson: string | null;

  /** customers excluded from marketing commission entirely for this branch
   *  (e.g. a รถมิเตอร์-driver's own customer, a payment-method code
   *  mistakenly appearing as a customer) — applies across every channel;
   *  channel-scoped exclusion no longer exists now that สามทอง/กระนวน's
   *  department-vs-flat split is gone (channelRules.ts is universal). */
  excludedCustomers: ExcludedCustomer[];

  /** freeform policy caveats always surfaced in the หมายเหตุ sheet, e.g. the
   *  negative-Q penalty disclaimer and the manual 50%/100% overdue-debt
   *  pay-reduction rule from the Incentive policy that this tool does NOT
   *  automate (see marketing-commission-calc/references/incentive-policy-mapping.md) */
  standingNotes: string[];
}
