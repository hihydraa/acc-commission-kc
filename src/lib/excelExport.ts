import ExcelJS from "exceljs";
import type { BranchConfig } from "@/branches/types";
import type { TransactionCalcResult } from "./calc/commissionEngine";

/**
 * Emits the workbook using live Excel formulas (VLOOKUP/IFS/IFERROR/
 * SUMPRODUCT) — not JS-precomputed values — matching the structure of the
 * user's own approved reference workbook for ST_8.69 (verified cell-by-cell
 * against it: sheet names "รถ NN"/"เทรลเลอร์ NN", a one-row-per-customer
 * Master sheet with รหัสลูกค้า/เซลล์/ระยะทาง(กม.)/Tag/ชื่อลูกค้า/ที่มา columns
 * in that order, the roster check inlined into the T formula rather than a
 * separate Master lookup column, and no "เข้าเกณฑ์ปริมาณ" helper column — the
 * qty/round-1000 test is inlined wherever it's needed instead).
 */

export interface ExportTransactionRow {
  truckLabel: string;
  /** the row this transaction will occupy in its truck sheet (header is row
   *  1) — precomputed in the pipeline so หักหนี้ค้างชำระ can reference the
   *  exact source cell instead of duplicating values */
  excelRow: number;
  docNo: string;
  baseDocNo: string;
  docDate: string; // dd/mm/yy as printed
  customerCode: string;
  customerName: string;
  productCode: string;
  qty: number;
  saleValue: number;
  cost: number;
  saleType: "cash" | "credit" | "overdue" | null;
  distanceKm: number | null;
  freightForcedZero: boolean;
  /** the raw tag text resolved from Master, for the cached H-column display
   *  value — distinct from freightForcedZero, which is just "does this zero
   *  the freight rate" (true for either tag value) */
  masterTag: "1สาย1สู้" | "ทางผ่าน" | "";
  masterFound: boolean;
  meterAnnotation: string | null;
  salesperson: string | null;
  /** commission actually attributed to the still-unpaid portion of the bill
   *  — set once matched against AR (step 4); a fully-unpaid bill has
   *  outstandingFraction 1 so this equals the row's full commission, but a
   *  PARTIALLY paid bill (AR's own billAmount > outstanding) scales this
   *  down proportionally rather than deducting the whole line */
  outstandingAmount: number | null;
  /** the liters this row's outstandingAmount corresponds to (qty × outstandingFraction) */
  outstandingQty: number | null;
  /** outstanding ÷ billAmount from the AR report, clamped to [0,1] — 1 for a
   *  fully unpaid bill, less for a partial payment */
  outstandingFraction: number | null;
  arOutstandingReference: number | null;
  calc: TransactionCalcResult;
}

export interface MasterSheetRow {
  customerCode: string;
  customerName: string;
  salesperson: string;
  distanceKm: number | null;
  tag: "1สาย1สู้" | "ทางผ่าน" | "";
  sourceText: string;
}

/** Per-sheet qty threshold + freight rule — one truck/department sheet is
 *  always internally uniform (a whole file belongs to one truck or one
 *  department), so this is resolved once per sheet rather than per row. */
export interface SheetScope {
  minQtyLiters: number;
  requireExactMultiple: boolean;
  qtyMultipleOf: number;
  fixedFreightRate: number | null;
}

export interface BuildWorkbookInput {
  branch: BranchConfig;
  truckLabels: string[];
  truckScopes: Map<string, SheetScope>;
  rows: ExportTransactionRow[];
  masterRows: MasterSheetRow[];
  debtQtyTotal: number;
  standingNotes: string[];
  warnings: string[];
}

const PRODUCT_NAME_BY_CODE: Record<string, string> = {
  DS: "ดีเซล B7",
  DS2: "ดีเซล-2",
  DSB20: "ดีเซลบี20",
  G91: "แก๊สโซฮอล์ 91",
  G95: "แก๊สโซฮอล์ 95",
  // กระนวน กรอกหลังปั๊ม's own SKU codes for the same fuel types (see
  // kranuan.ts's fuelProductCodes comment) — same display name as their
  // non-KN counterpart, just a different underlying SKU code.
  DSKN: "ดีเซล-2",
  G91KN: "แก๊สโซฮอล์ 91",
  G95KN: "แก๊สโซฮอล์ 95",
  B20KN: "ดีเซลบี20",
};

function productLabel(code: string): string {
  return PRODUCT_NAME_BY_CODE[code] ?? code;
}

/** A branch can be a hybrid (สามทอง: flat rules for regular trucks + a
 *  departments entry for กรอกหลังปั๊ม) — these two pieces are independent,
 *  not mutually exclusive, so both must be described when both are present
 *  or a summary line would silently omit the regular-truck rule entirely.
 *  The flat-only phrasing matches the approved reference workbook's own
 *  wording exactly — a branch with no departments at all (a plain flat
 *  model) produces the identical string it always did. The reference uses
 *  "L" in the ค่าคอมรวม header but "ลิตร" in the ใบปะหน้า note for the same
 *  rule — an inconsistency in the approved file itself, not a typo to
 *  "fix" — so the unit word is a parameter, not hardcoded. */
function qtyRuleDescription(branch: BranchConfig, unit: "L" | "ลิตร"): string {
  const parts: string[] = [];
  if (branch.minQtyLiters !== undefined) {
    parts.push(`>=${branch.minQtyLiters.toLocaleString()}${unit}${branch.requireExactMultiple ? " และลงท้ายพันพอดี" : ""}`);
  }
  if (branch.departments) {
    parts.push(...branch.departments.map((d) => `${d.label} >=${d.minQtyLiters.toLocaleString()}${unit}`));
  }
  return parts.join(" | ");
}

// Passes the date through exactly as the source PDF prints it
// (dd/mm/yy, 2-digit Buddhist year) — matches the approved reference
// workbook's own display ("19/08/69", not "19/08/2569"); expanding to a
// 4-digit year was a later, unrequested change that drifted from that
// approved format.
function toThaiDateDisplay(ddmmyy: string): string {
  return ddmmyy;
}

/**
 * exceljs has no formula engine, so a formula cell it writes carries no
 * cached value — many non-Excel viewers (and Excel itself set to manual
 * calculation) then render it as blank until something explicitly
 * recalculates the sheet. Since the pipeline already computes every one of
 * these values independently in JS (this IS the "independent calculation"
 * cross-check the SKILL asks for), attach that value as the formula's
 * cached `result` so every cell shows a correct number immediately on
 * open — the formula itself stays live underneath for anyone who edits
 * Master and wants Excel to recalculate for real.
 *
 * An empty-string result is the one exception — real Excel opening a very
 * large กระนวน B3 export (thousands of qty-qualifying rows once the
 * per-line threshold was removed) threw "we found a problem with some
 * content" and offered to repair it, traced to thousands of `t="str"`
 * cells caching an empty `<v></v>`. That pattern round-trips fine through
 * exceljs's own reader and other lenient viewers, so it went unnoticed
 * until a real file this large actually got opened in Excel itself.
 * Omitting `result` entirely for "" sidesteps the question of whether
 * that's spec-legal — `workbook.calcProperties.fullCalcOnLoad = true` is
 * already set, so Excel recomputes the formula the instant it opens
 * either way.
 */
function fv(formula: string, result: number | string): { formula: string; result?: number | string } {
  return result === "" ? { formula } : { formula, result };
}

function saleTypeLabel(t: "cash" | "credit" | "overdue" | null): string {
  if (t === "cash") return "ขายสด";
  if (t === "credit") return "ขายเชื่อ";
  if (t === "overdue") return "ลูกหนี้ค้างชำระ";
  return "ตรวจสอบ";
}

function safeSheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || "Sheet";
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${base.slice(0, 28)}_${n}`;
    n++;
  }
  used.add(candidate);
  return candidate;
}

const BLOCK_SENTINEL = "ต้องตรวจสอบระยะทาง(M)";

/**
 * scope.fixedFreightRate overrides the distance-table lookup entirely (e.g.
 * กระนวน B3's fixed 0.10) — still a live formula so the 1สาย1สู้ tag keeps
 * working. Otherwise, on a missing/out-of-range distance:
 *  - "defaultZero" (สามทอง's approved template behavior): fall through to 0.
 *  - "block" (กระนวน's confirmed v2 spec): surface the BLOCK_SENTINEL text
 *    instead of guessing — IFERROR/text-propagation carries that sentinel
 *    through N/O/P/Q automatically (any arithmetic on text errors out, and
 *    every downstream cell here is already wrapped in IFERROR(...,"")).
 */
function freightFormula(r: number, scope: SheetScope, freightMissingBehavior: "defaultZero" | "block"): string {
  if (scope.fixedFreightRate !== null) {
    return `IF(H${r}="1สาย1สู้",0,${scope.fixedFreightRate})`;
  }
  const missingFallback = freightMissingBehavior === "block" ? `"${BLOCK_SENTINEL}"` : "0";
  return (
    `IF(H${r}="1สาย1สู้",0,IF(G${r}="",${missingFallback},IFERROR(_xlfn.IFS(` +
    `AND(G${r}>=20,G${r}<=59),0.15,AND(G${r}>=60,G${r}<=69),0.17,` +
    `AND(G${r}>=70,G${r}<=79),0.19,AND(G${r}>=80,G${r}<=89),0.2,` +
    `AND(G${r}>=90,G${r}<=99),0.22,AND(G${r}>=100,G${r}<=109),0.24,` +
    `AND(G${r}>=110,G${r}<=129),0.28,AND(G${r}>=130,G${r}<=139),0.3,` +
    `AND(G${r}>=140,G${r}<=159),0.32,AND(G${r}>=160,G${r}<=169),0.34,` +
    `AND(G${r}>=170,G${r}<=179),0.35,AND(G${r}>=180,G${r}<=189),0.36,` +
    `AND(G${r}>=190,G${r}<=199),0.38,AND(G${r}>=200,G${r}<=209),0.39` +
    `),${missingFallback})))`
  );
}

function commissionFormula(r: number, branch: BranchConfig, scope: SheetScope): string {
  const rosterCheck = branch.salespersonRoster.map((name) => `S${r}<>"${name}"`).join(",");
  const penalty = branch.penaltyNegativeQEnabled ? `-I${r}*${branch.ratePerLiter}` : "0";
  const tier = (label: string, threshold: number) =>
    `IF(R${r}="${label}",IF(Q${r}>=${threshold},I${r}*${branch.ratePerLiter},IF(Q${r}>=0,0,${penalty}))`;
  const qtyGate = scope.requireExactMultiple
    ? `OR(I${r}<${scope.minQtyLiters},MOD(I${r},${scope.qtyMultipleOf})<>0)`
    : `I${r}<${scope.minQtyLiters}`;
  const base =
    `IFERROR(IF(OR(I${r}="",R${r}=""),0,` +
    `IF(${qtyGate},0,` +
    `IF(AND(${rosterCheck}),0,` +
    `${tier("ขายสด", branch.thresholds.cash)},` +
    `${tier("ขายเชื่อ", branch.thresholds.credit)},` +
    `${tier("ลูกหนี้ค้างชำระ", branch.thresholds.overdue)},` +
    `"ตรวจสอบประเภท(R)")))))),0)`;
  // The M-column block check only matters for a "block" branch (กระนวน) —
  // สามทอง's M never produces that sentinel (freightMissingBehavior:
  // "defaultZero"), so wrapping its formula in a check that can never
  // trigger would just be needless noise next to the approved reference
  // workbook's own (shorter) formula text.
  return branch.freightMissingBehavior === "block" ? `IF(M${r}="${BLOCK_SENTINEL}","${BLOCK_SENTINEL}",${base})` : base;
}

const HIGHLIGHT_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
const EXCLUDE_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4CCCC" } };

/**
 * Matches the user's own approved template (คำนวณค่าคอม_ST_8.69_3.xlsx,
 * inspected cell-by-cell with exceljs) exactly: dark-blue table headers with
 * white bold text and a thin grey grid over every cell, light-blue highlight
 * on each sheet's grand-total row(s). numFmt is deliberately left at
 * "General" everywhere — the template itself uses General throughout, never
 * a comma/currency format.
 */
const THIN_GREY = { style: "thin" as const, color: { argb: "FFBBBBBB" } };
const CELL_BORDER: Partial<ExcelJS.Borders> = { top: THIN_GREY, bottom: THIN_GREY, left: THIN_GREY, right: THIN_GREY };
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, size: 10, color: { argb: "FFFFFFFF" }, name: "FreeSans" };
const HEADER_ALIGNMENT: Partial<ExcelJS.Alignment> = { horizontal: "center", vertical: "middle", wrapText: true };
const HEADER_ROW_HEIGHT = 23;
const TOTAL_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" } };
const TOTAL_FONT: Partial<ExcelJS.Font> = { bold: true, size: 10, name: "FreeSans" };

/** Styles a header row in place: dark-blue fill, white bold text, centered
 *  wrap, thin grey border — `colCount` because a freshly-added header row's
 *  own cell count already matches its header array, but a later-styled row
 *  (added via getRow(n) before any addRow) needs the column count spelled
 *  out explicitly. */
function styleHeaderRow(row: ExcelJS.Row, colCount: number) {
  row.height = HEADER_ROW_HEIGHT;
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
    cell.alignment = HEADER_ALIGNMENT;
    cell.border = CELL_BORDER;
  }
}

/** Thin grey border on every cell of a data row, including ones with no
 *  value — the template's grid covers the full table width, not just
 *  populated cells (an empty cell still shows its grid line). */
function styleDataRowBorders(row: ExcelJS.Row, colCount: number) {
  for (let c = 1; c <= colCount; c++) row.getCell(c).border = CELL_BORDER;
}

function styleTotalRow(row: ExcelJS.Row, colCount: number) {
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    cell.font = TOTAL_FONT;
    cell.fill = TOTAL_FILL;
    cell.border = CELL_BORDER;
  }
}

export async function buildCommissionWorkbook(input: BuildWorkbookInput): Promise<ArrayBuffer> {
  const { branch } = input;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "marketing-commission-calc";
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  const usedSheetNames = new Set<string>();

  // ---------- Master ----------
  const MASTER_HEADER = ["รหัสลูกค้า", "เซลล์", "ระยะทาง(กม.)", "Tag", "ชื่อลูกค้า", "ที่มา"];
  const masterSheet = workbook.addWorksheet(safeSheetName("Master", usedSheetNames));
  masterSheet.addRow(MASTER_HEADER);
  styleHeaderRow(masterSheet.getRow(1), MASTER_HEADER.length);
  for (const m of input.masterRows) {
    // Exclusion is channel-scoped now (branch-flat vs per-department — see
    // DepartmentConfig.excludedCustomers), so `masterRows` itself already
    // carries the right salesperson label for whichever list actually
    // matched; detect it from that instead of re-checking one specific
    // list here.
    const isExcluded = m.salesperson.startsWith("ตัดออก");
    const isUserConfirmed = m.sourceText.startsWith("ยืนยันจากผู้ใช้");
    const row = masterSheet.addRow([m.customerCode, m.salesperson, m.distanceKm, m.tag, m.customerName, m.sourceText]);
    styleDataRowBorders(row, MASTER_HEADER.length);
    if (isExcluded) row.eachCell((c) => (c.fill = EXCLUDE_FILL));
    else if (isUserConfirmed) row.eachCell((c) => (c.fill = HIGHLIGHT_FILL));
  }
  [14, 26, 12, 12, 32, 50].forEach((w, i) => (masterSheet.getColumn(i + 1).width = w));

  // ---------- per-truck sheets ----------
  const TRUCK_HEADER = [
    "ลำดับ", "วันที่", "เลขที่เอกสาร", "รหัสลูกค้า", "ชื่อลูกค้า", "สินค้า", "ระยะทาง(กม.)", "Tag",
    "ปริมาณขายสุทธิ(ลิตร)", "มูลค่าขาย", "ต้นทุนขายสุทธิ", "กำไรขั้นต้น", "ค่าขนส่ง/ลิตร", "ค่าขนส่งรวม",
    "ต้นทุนรวม", "กำไรหลังหักขนส่ง", "กำไรต่อลิตร", "ประเภท", "เซลล์", "ค่าคอม", "หมายเหตุ",
  ];
  const truckSheetNameByLabel = new Map<string, string>();
  const truckLastRow = new Map<string, number>();

  for (const truckLabel of input.truckLabels) {
    const sheetName = safeSheetName(truckLabel, usedSheetNames);
    truckSheetNameByLabel.set(truckLabel, sheetName);
    const sheet = workbook.addWorksheet(sheetName);
    sheet.addRow(TRUCK_HEADER);
    styleHeaderRow(sheet.getRow(1), TRUCK_HEADER.length);

    const scope = input.truckScopes.get(truckLabel) ?? {
      minQtyLiters: branch.minQtyLiters ?? 0,
      requireExactMultiple: branch.requireExactMultiple ?? false,
      qtyMultipleOf: branch.qtyMultipleOf ?? 1000,
      fixedFreightRate: null,
    };

    const deptRows = input.rows.filter((r) => r.truckLabel === truckLabel);
    deptRows.forEach((r, idx) => {
      const excelRow = idx + 2;
      const noteParts = [...r.calc.flags];
      if (r.calc.blockedReason) noteParts.push(r.calc.blockedReason);
      if (r.meterAnnotation) noteParts.push(`หมายเหตุจากไฟล์ขาย: "${r.meterAnnotation}" — ต้องยืนยันกับผู้ใช้ว่านับเป็นยอดเซลล์จริงหรือไม่`);
      if (r.outstandingAmount !== null) noteParts.push(`หักหนี้ค้างชำระ ฿${r.outstandingAmount.toLocaleString()} — พบในรายงานลูกหนี้ ณ ${branch.arAsOfLabel}`);

      const gVal = r.distanceKm ?? "";
      const hVal = r.masterTag || "";
      const sVal = r.salesperson ?? "ตรวจสอบเซลล์";
      const mVal = r.calc.blocked ? BLOCK_SENTINEL : r.calc.freightRate!;

      sheet.addRow([
        idx + 1,
        toThaiDateDisplay(r.docDate),
        r.docNo,
        r.customerCode,
        r.customerName,
        productLabel(r.productCode),
        fv(`IFERROR(VLOOKUP(D${excelRow},Master!$A:$D,3,FALSE()),"")`, gVal),
        fv(`IFERROR(VLOOKUP(D${excelRow},Master!$A:$D,4,FALSE()),"")`, hVal),
        r.qty,
        r.saleValue,
        r.cost,
        fv(`IFERROR(J${excelRow}-K${excelRow},"")`, r.calc.grossProfit),
        fv(freightFormula(excelRow, scope, branch.freightMissingBehavior), mVal),
        fv(`IFERROR(M${excelRow}*I${excelRow},"")`, r.calc.freightTotal ?? ""),
        fv(`IFERROR(N${excelRow}+K${excelRow},"")`, r.calc.totalCost ?? ""),
        fv(`IFERROR(J${excelRow}-O${excelRow},"")`, r.calc.profitAfterFreight ?? ""),
        fv(`IFERROR(P${excelRow}/I${excelRow},"")`, r.calc.profitPerLiter ?? ""),
        fv(`IF(LEFT(C${excelRow},1)="H","ขายสด",IF(LEFT(C${excelRow},1)="I","ขายเชื่อ","ตรวจสอบ"))`, saleTypeLabel(r.saleType)),
        fv(`IFERROR(VLOOKUP(D${excelRow},Master!$A:$D,2,FALSE()),"ตรวจสอบเซลล์")`, sVal),
        fv(commissionFormula(excelRow, branch, scope), r.calc.commission),
        noteParts.join("; "),
      ]);
      styleDataRowBorders(sheet.getRow(excelRow), TRUCK_HEADER.length);
      if (r.calc.blocked) sheet.getRow(excelRow).eachCell((c) => (c.fill = EXCLUDE_FILL));
    });

    const lastDataRow = deptRows.length + 1;
    truckLastRow.set(truckLabel, lastDataRow);
    if (deptRows.length > 0) {
      const totalRow = lastDataRow + 2;
      const qualifyingRow = lastDataRow + 3;
      const qtyRange = `I2:I${lastDataRow}`;
      const qualifyCond = scope.requireExactMultiple
        ? `(${qtyRange}>=${scope.minQtyLiters})*(MOD(${qtyRange},${scope.qtyMultipleOf})=0)`
        : `(${qtyRange}>=${scope.minQtyLiters})`;
      const totalQty = deptRows.reduce((s, r) => s + r.qty, 0);
      const totalComm = deptRows.reduce((s, r) => s + r.calc.commissionNumeric, 0);
      const qualifyingQty = deptRows.filter((r) => r.calc.qualifiesByQty).reduce((s, r) => s + r.qty, 0);
      sheet.getRow(totalRow).getCell(5).value = "รวมทั้งชีท";
      sheet.getRow(totalRow).getCell(9).value = fv(`SUM(${qtyRange})`, totalQty);
      sheet.getRow(totalRow).getCell(20).value = fv(`SUM(T2:T${lastDataRow})`, totalComm);
      sheet.getRow(qualifyingRow).getCell(5).value = "รวมเฉพาะรายการที่เข้าเกณฑ์ค่าคอม";
      sheet.getRow(qualifyingRow).getCell(9).value = fv(`SUMPRODUCT(${qualifyCond}*${qtyRange})`, qualifyingQty);
      sheet.getRow(qualifyingRow).getCell(20).value = fv(`SUM(T2:T${lastDataRow})`, totalComm);
      styleTotalRow(sheet.getRow(totalRow), TRUCK_HEADER.length);
      styleTotalRow(sheet.getRow(qualifyingRow), TRUCK_HEADER.length);
    }

    [6, 10, 16, 12, 26, 14, 10, 10, 14, 12, 12, 12, 10, 12, 12, 14, 10, 10, 10, 10, 42].forEach((w, i) => (sheet.getColumn(i + 1).width = w));
  }

  // Sheet objects are created here, in this order, purely to fix the tab
  // order to match the approved reference workbook (ค่าคอมรวม before
  // หักหนี้ค้างชำระ) — each sheet's own cells are still filled in below in
  // whichever order is convenient; ExcelJS's tab order follows
  // addWorksheet() call order, not when cells get populated afterward.
  const summarySheet = workbook.addWorksheet(safeSheetName("ค่าคอมรวม", usedSheetNames));
  const debtSheet = workbook.addWorksheet(safeSheetName("หักหนี้ค้างชำระ", usedSheetNames));

  // ---------- หักหนี้ค้างชำระ ----------
  debtSheet.mergeCells(1, 1, 1, 9);
  debtSheet.getCell("A1").value =
    branch.debtDeductionMode === "auto"
      ? `ลูกหนี้ ณ ${branch.arAsOfLabel} ที่ยังไม่จ่ายชำระ ตรงกับรายการที่เข้าเกณฑ์ค่าคอมเดือน ${branch.periodLabel} (ทุกชนิดน้ำมันที่เข้าเกณฑ์) — บิลที่จ่ายมาบางส่วนแล้ว คิดเฉพาะสัดส่วนที่ยังค้างเท่านั้น ไม่ใช่เต็มบิล`
      : `ลูกหนี้ ณ ${branch.arAsOfLabel} ที่ยังไม่จ่ายชำระ ตรงกับรายการที่เข้าเกณฑ์ค่าคอมเดือน ${branch.periodLabel} — รายการนี้เป็น "การแจ้งเตือน" เท่านั้น ยังไม่ได้หักออกจากค่าคอมสุทธิ (ดูชีทค่าคอมรวม คอลัมน์ "หนี้ค้างที่ต้องพิจารณา" ที่ตั้งต้น 0) บัญชีต้องพิจารณาหักเอง 50%/100% ตาม policy ข้อ 6-7`;
  debtSheet.getRow(1).font = { bold: true, size: 13 };
  const DEBT_HEADER = [
    "รหัสลูกค้า",
    "ชื่อลูกค้า",
    "เอกสาร#",
    "วันที่",
    "ลิตรที่ค้าง (เฉพาะส่วนที่ยังไม่จ่าย)",
    "เซลล์",
    branch.debtDeductionMode === "auto" ? "ค่าคอมที่หัก (เฉพาะส่วนที่ยังค้าง)" : "ค่าคอมของส่วนที่ยังค้าง (บาท) — อ้างอิงเท่านั้น",
    `ยอดคงค้าง (บาท) ตามรายงานลูกหนี้ ${branch.arAsOfLabel}`,
    "สถานะการจ่าย",
  ];
  debtSheet.addRow(DEBT_HEADER);
  styleHeaderRow(debtSheet.getRow(2), DEBT_HEADER.length);
  const debtRows = input.rows.filter((r) => (r.outstandingAmount ?? 0) > 0);
  for (const r of debtRows) {
    const s = truckSheetNameByLabel.get(r.truckLabel)!;
    const isPartial = (r.outstandingFraction ?? 1) < 0.999;
    // Liters/commission here are the OUTSTANDING PORTION only (qty/commission
    // × outstandingFraction) — a partially-paid bill (AR's own billAmount >
    // outstanding, confirmed against real data) must not deduct the whole
    // line's commission, only the still-unpaid share. That's a derived
    // number this workbook has no single live cell for, so it's written as
    // a plain value rather than a cross-sheet formula like the other
    // columns here.
    debtSheet.addRow([
      fv(`'${s}'!D${r.excelRow}`, r.customerCode),
      fv(`'${s}'!E${r.excelRow}`, r.customerName),
      fv(`'${s}'!C${r.excelRow}`, r.docNo),
      fv(`'${s}'!B${r.excelRow}`, toThaiDateDisplay(r.docDate)),
      r.outstandingQty ?? r.qty,
      fv(`'${s}'!S${r.excelRow}`, r.salesperson ?? "ตรวจสอบเซลล์"),
      r.outstandingAmount,
      r.arOutstandingReference,
      isPartial ? `จ่ายบางส่วนแล้ว — คิดเฉพาะส่วนที่ยังค้าง (${((r.outstandingFraction ?? 1) * 100).toFixed(1)}% ของบิล)` : "ค้างเต็มบิล",
    ]);
    styleDataRowBorders(debtSheet.lastRow!, DEBT_HEADER.length);
  }
  const debtDataLast = debtRows.length + 2;
  const debtInformationalTotal = debtRows.reduce((s, r) => s + (r.outstandingAmount ?? 0), 0);
  if (debtRows.length > 0) {
    debtSheet.addRow([]);
    debtSheet.getCell(`A${debtDataLast + 2}`).value = branch.debtDeductionMode === "auto" ? "รวมลิตรที่ต้องหัก" : "รวมลิตรที่เกี่ยวข้อง";
    debtSheet.getCell(`B${debtDataLast + 2}`).value = fv(`SUM(E3:E${debtDataLast})`, input.debtQtyTotal);
    debtSheet.getCell(`A${debtDataLast + 3}`).value = branch.debtDeductionMode === "auto" ? "รวมค่าคอมที่ต้องหัก" : "รวมค่าคอมของรายการที่ต้องพิจารณา (อ้างอิงเท่านั้น — ยังไม่ได้หัก)";
    debtSheet.getCell(`B${debtDataLast + 3}`).value = fv(`SUM(G3:G${debtDataLast})`, debtInformationalTotal);
    styleTotalRow(debtSheet.getRow(debtDataLast + 2), 2);
    styleTotalRow(debtSheet.getRow(debtDataLast + 3), 2);
    const noteStart = debtDataLast + 5;
    debtSheet.getCell(`A${noteStart}`).value = "หมายเหตุ:";
    debtSheet.getCell(`A${noteStart + 1}`).value =
      `- วิธีจับคู่: เลขที่เอกสารของรายการที่เข้าเกณฑ์ค่าคอมเดือน ${branch.periodLabel} กับเอกสารที่ยังคงค้างในรายงานลูกหนี้คงค้างแบบละเอียด ณ วันที่ ${branch.arAsOfLabel}`;
    debtSheet.getCell(`A${noteStart + 2}`).value = `- พบ ${debtRows.length} รายการที่ตรงกัน:`;
    debtRows.forEach((r, i) => {
      debtSheet.getCell(`A${noteStart + 3 + i}`).value =
        `    ${i + 1}) ${r.customerCode} ${r.customerName} เอกสาร ${r.docNo} (${productLabel(r.productCode)} ${r.qty.toLocaleString()} ลิตร) ยอดคงค้าง ${(r.arOutstandingReference ?? 0).toLocaleString()} บาท`;
    });
    if (branch.debtDeductionMode === "auto") {
      debtSheet.getCell(`A${noteStart + 3 + debtRows.length}`).value =
        "- ค่าคอมของแต่ละรายการคำนวณจากสูตรเดียวกับชีทรถ (ตามลิตรจริงของรายการนั้น) ไม่ได้หักเป็นยอดเงินคงค้างตรงๆ — ยอดนี้ถูกหักออกจากค่าคอมสุทธิของเซลล์แล้ว (ดูชีทค่าคอมรวม)";
    } else {
      debtSheet.getCell(`A${noteStart + 3 + debtRows.length}`).value =
        "- รายการข้างต้นเป็นการแจ้งเตือนเท่านั้น — ยังไม่ได้หักออกจากค่าคอมสุทธิ (ชีทค่าคอมรวมตั้งค่าคอลัมน์นี้ไว้ที่ 0) บัญชีต้องพิจารณาหักเอง 50% ถ้ายังไม่จ่าย หรือ 100% ถ้าตกลงผ่อนตามตารางที่กำหนด ตาม policy ข้อ 6-7 แล้วกรอกยอดหักเข้าชีทค่าคอมรวมด้วยมือ";
    }
  } else {
    debtSheet.addRow(["ไม่พบรายการค้างชำระที่ตรงกับรายการเข้าเกณฑ์เดือนนี้"]);
  }
  [13, 30, 15, 10, 22, 10, 20, 26].forEach((w, i) => (debtSheet.getColumn(i + 1).width = w));

  // ---------- ค่าคอมรวม ----------
  const qtyColumnLabel = `จำนวนลิตร (รวมรายการที่เข้าเกณฑ์ ${qtyRuleDescription(branch, "L")} ทุกชนิดน้ำมัน)`;
  const debtColumnLabel =
    branch.debtDeductionMode === "auto"
      ? "หักค่าคอมจากหนี้ค้างชำระ"
      : "หนี้ค้างที่ต้องพิจารณา (บาท) — บัญชีปรับเอง ตั้งต้น 0";
  const SUMMARY_HEADER = ["เซลล์", qtyColumnLabel, "ค่าคอมมิชชั่นรวม (ก่อนหักหนี้)", debtColumnLabel, "ค่าคอมสุทธิ"];
  summarySheet.addRow(SUMMARY_HEADER);
  styleHeaderRow(summarySheet.getRow(1), SUMMARY_HEADER.length);
  const perSalesperson = branch.salespersonRoster.map((name) => {
    const rows = input.rows.filter((r) => r.salesperson === name);
    const liters = rows.filter((r) => r.calc.qualifiesByQty).reduce((s, r) => s + r.qty, 0);
    const gross = rows.reduce((s, r) => s + r.calc.commissionNumeric, 0);
    const flaggedDebt = debtRows.filter((r) => r.salesperson === name).reduce((s, r) => s + (r.outstandingAmount ?? 0), 0);
    // "auto" (สามทอง): matched debt is actually netted out of ค่าคอมสุทธิ.
    // "flagOnly" (กระนวน): the full amount is only LISTED for accounting's
    // own manual 50%/100% review (policy §6-7) — the applied deduction that
    // feeds into ค่าคอมสุทธิ stays 0, matching the branch's own approved
    // reference workbook exactly (its ค่าคอมรวม sheet's debt column is a
    // literal 0, not a formula, precisely so accounting can safely
    // overwrite it by hand without a live formula clobbering their edit).
    const debt = branch.debtDeductionMode === "auto" ? flaggedDebt : 0;
    return { name, liters, gross, debt, flaggedDebt, net: gross - debt };
  });
  branch.salespersonRoster.forEach((name, i) => {
    const r = i + 2;
    const agg = perSalesperson[i];
    const qtyTerms = input.truckLabels.map((label) => {
      const s = truckSheetNameByLabel.get(label)!;
      const last = truckLastRow.get(label) ?? 1;
      const sc = input.truckScopes.get(label) ?? { minQtyLiters: branch.minQtyLiters ?? 0, requireExactMultiple: branch.requireExactMultiple ?? false, qtyMultipleOf: branch.qtyMultipleOf ?? 1000, fixedFreightRate: null };
      const qtyCond = sc.requireExactMultiple
        ? `('${s}'!$I$2:$I$${last}>=${sc.minQtyLiters})*(MOD('${s}'!$I$2:$I$${last},${sc.qtyMultipleOf})=0)`
        : `('${s}'!$I$2:$I$${last}>=${sc.minQtyLiters})`;
      return `SUMPRODUCT(('${s}'!$S$2:$S$${last}=$A${r})*${qtyCond}*'${s}'!$I$2:$I$${last})`;
    });
    const commTerms = input.truckLabels.map((label) => {
      const s = truckSheetNameByLabel.get(label)!;
      const last = truckLastRow.get(label) ?? 1;
      return `SUMIF('${s}'!$S$2:$S$${last},$A${r},'${s}'!$T$2:$T$${last})`;
    });
    const debtCell =
      branch.debtDeductionMode === "auto"
        ? fv(`SUMIF(หักหนี้ค้างชำระ!$F:$F,$A${r},หักหนี้ค้างชำระ!$G:$G)`, agg.debt)
        : 0; // literal, not a formula — see comment on `perSalesperson` above
    summarySheet.addRow([name, fv(qtyTerms.join("+"), agg.liters), fv(commTerms.join("+"), agg.gross), debtCell, fv(`C${r}-D${r}`, agg.net)]);
    styleDataRowBorders(summarySheet.lastRow!, SUMMARY_HEADER.length);
  });
  const grandRow = branch.salespersonRoster.length + 2;
  summarySheet.getRow(grandRow).getCell(1).value = "รวมทั้งหมด";
  const grandTotals = {
    liters: perSalesperson.reduce((s, a) => s + a.liters, 0),
    gross: perSalesperson.reduce((s, a) => s + a.gross, 0),
    debt: perSalesperson.reduce((s, a) => s + a.debt, 0),
    net: perSalesperson.reduce((s, a) => s + a.net, 0),
  };
  (["B", "C", "D", "E"] as const).forEach((col, i) => {
    const val = [grandTotals.liters, grandTotals.gross, grandTotals.debt, grandTotals.net][i];
    summarySheet.getCell(`${col}${grandRow}`).value = fv(`SUM(${col}2:${col}${grandRow - 1})`, val);
  });
  styleTotalRow(summarySheet.getRow(grandRow), SUMMARY_HEADER.length);
  [14, 46, 26, 26, 18].forEach((w, i) => (summarySheet.getColumn(i + 1).width = w));

  // ---------- ใบปะหน้า ----------
  const coverSheet = workbook.addWorksheet(safeSheetName("ใบปะหน้า", usedSheetNames));
  coverSheet.mergeCells(1, 1, 1, branch.teamSplit.roles.length + 2);
  coverSheet.getCell("A1").value = `สรุปค่าคอมมิชชั่นฝ่ายการตลาด สาขา${branch.label} - เดือน ${branch.periodLabel} (${branch.periodLabelThai})`;
  coverSheet.getRow(1).font = { bold: true, size: 13 };
  // Every exclusion list that could apply anywhere in this branch — the
  // flat/regular-truck one plus every department's own (see
  // DepartmentConfig.excludedCustomers) — just for this one summary line;
  // the actual per-row exclusion check elsewhere is properly channel-scoped.
  const allExcludedCustomers = [...branch.excludedCustomers, ...(branch.departments?.flatMap((d) => d.excludedCustomers) ?? [])];
  coverSheet.mergeCells(3, 1, 3, branch.teamSplit.roles.length + 2);
  coverSheet.getCell("A3").value =
    `หมายเหตุ: อัตราแบ่ง ${branch.teamSplit.roles.map((r) => `${r.label} ${(r.percent * 100).toFixed(0)}%`).join(" / ")} | เข้าเกณฑ์ =${[...new Set(branch.fuelProductCodes.map(productLabel))].join("+")} ที่ ${qtyRuleDescription(branch, "ลิตร")} | ไม่รวมลูกค้า${allExcludedCustomers.map((e) => ` ${e.customerName} (${e.reason})`).join(", ")}`;

  const splitHeaderRow = 5;
  const coverColCount = branch.teamSplit.roles.length + 2;
  const colLetterForRoleIdx = (i: number) => String.fromCharCode("C".charCodeAt(0) + i);
  coverSheet.getRow(splitHeaderRow).values = ["เจ้าของยอด (เซลล์)", "ค่าคอมสุทธิ (บาท)", ...branch.teamSplit.roles.map((r) => `${r.label} ${(r.percent * 100).toFixed(0)}%`)];
  styleHeaderRow(coverSheet.getRow(splitHeaderRow), coverColCount);
  const roleTotalsByCol = new Map<number, number>(); // 1-indexed column -> sum, for the รวม row
  branch.salespersonRoster.forEach((name, i) => {
    const srcRow = i + 2; // ค่าคอมรวม row for this salesperson
    const outRow = splitHeaderRow + 1 + i;
    const net = perSalesperson[i].net;
    const cells: (string | number | { formula: string; result?: number | string })[] = [name, fv(`ค่าคอมรวม!E${srcRow}`, net)];
    roleTotalsByCol.set(2, (roleTotalsByCol.get(2) ?? 0) + net);

    const shares: number[] = [];
    let fixedSum = 0;
    branch.teamSplit.roles.forEach((role) => {
      if (role.isRemainder) return;
      const amt = Math.round(net * role.percent * 100) / 100;
      shares.push(amt);
      fixedSum += amt;
    });
    let fixedIdx = 0;
    branch.teamSplit.roles.forEach((role, roleIdx) => {
      const col = roleIdx + 3; // C, D, E, ...
      if (role.isRemainder) {
        const remainder = Math.round((net - fixedSum) * 100) / 100;
        const otherCols = branch.teamSplit.roles
          .map((_, j) => j)
          .filter((j) => j !== roleIdx)
          .map((j) => colLetterForRoleIdx(j) + outRow);
        cells.push(fv(`$B${outRow}${otherCols.length ? "-" + otherCols.join("-") : ""}`, remainder));
        roleTotalsByCol.set(col, (roleTotalsByCol.get(col) ?? 0) + remainder);
      } else {
        const amt = shares[fixedIdx++];
        cells.push(fv(`ROUND($B${outRow}*${role.percent},2)`, amt));
        roleTotalsByCol.set(col, (roleTotalsByCol.get(col) ?? 0) + amt);
      }
    });
    coverSheet.addRow(cells);
    styleDataRowBorders(coverSheet.lastRow!, coverColCount);
  });
  const totalRow = splitHeaderRow + 1 + branch.salespersonRoster.length;
  const totalCells: (string | { formula: string; result?: number | string })[] = ["รวม"];
  for (let c = 2; c <= branch.teamSplit.roles.length + 2; c++) {
    const col = String.fromCharCode("A".charCodeAt(0) + c - 1);
    totalCells.push(fv(`SUM(${col}${splitHeaderRow + 1}:${col}${totalRow - 1})`, roleTotalsByCol.get(c) ?? 0));
  }
  coverSheet.getRow(totalRow).values = totalCells;
  styleTotalRow(coverSheet.getRow(totalRow), coverColCount);
  coverSheet.columns.forEach((c) => (c.width = 20));
  coverSheet.getColumn(1).width = 16;
  coverSheet.getColumn(2).width = 16;

  // ---------- หมายเหตุ ----------
  const notesSheet = workbook.addWorksheet(safeSheetName("หมายเหตุ", usedSheetNames));
  let nr = 1;
  const addTitle = (text: string) => {
    notesSheet.getCell(`A${nr}`).value = text;
    notesSheet.getRow(nr).font = { bold: true, size: 13, name: "FreeSans" };
    nr += 2;
  };
  const addLine = (text: string) => {
    notesSheet.getCell(`A${nr}`).value = text;
    nr++;
  };
  /** A numbered section header (e.g. "1) ขอบเขตข้อมูลที่ใช้") — bold like a
   *  title but without addTitle's extra blank line, since the section's own
   *  content follows immediately underneath it. */
  const addSectionHeader = (text: string) => {
    notesSheet.getCell(`A${nr}`).value = text;
    notesSheet.getRow(nr).font = { bold: true, size: 10 };
    nr++;
  };
  const blank = () => {
    nr++;
  };

  notesSheet.mergeCells(1, 1, 1, 2);
  addTitle(`หมายเหตุและข้อสมมติฐานในการคำนวณค่าคอม ${branch.id.toUpperCase()} เดือน ${branch.periodLabel}`);

  addSectionHeader("1) ขอบเขตข้อมูลที่ใช้");
  addLine(`- ไฟล์ยอดขายรายรถ: ${input.truckLabels.join(", ")} (ทั้งหมดในโฟลเดอร์ ${branch.dataFolderLabel})`);
  addLine(`- ไฟล์ระยะทาง/เซลล์: '${branch.masterFileLabel}'`);
  addLine(`- ไฟล์ลูกหนี้คงค้าง: รายงานลูกหนี้คงค้างแบบละเอียด ณ ${branch.arAsOfLabel}`);
  blank();

  addSectionHeader("2) เกณฑ์การกรองรายการที่เข้าเกณฑ์ค่าคอม");
  addLine(`- รวมน้ำมันใสทุกชนิด: ${[...new Set(branch.fuelProductCodes.map(productLabel))].join(", ")}`);
  if (branch.minQtyLiters !== undefined) {
    addLine(
      `- รถทั่วไป: ปริมาณขายสุทธิต้อง >= ${branch.minQtyLiters.toLocaleString()} ลิตร ต่อ 1 เอกสาร${branch.requireExactMultiple ? ` 'และ' ต้องลงท้ายพันพอดี (หาร ${(branch.qtyMultipleOf ?? 0).toLocaleString()} ลงตัว) — เช่น 2,000/3,000/4,000 เข้าเกณฑ์ แต่ 2,500 ไม่เข้าเกณฑ์เลยทั้งบิล` : ""}`
    );
  }
  if (branch.departments) {
    addLine("- แยกตามแผนก (จัดประเภทจาก \"เลือกแผนก\" ในไฟล์ ไม่ใช่ชื่อไฟล์) ปริมาณขายสุทธิต้อง >= เกณฑ์ขั้นต่ำของแผนกนั้น ต่อ 1 เอกสาร (ไม่มีเงื่อนไขต้องลงท้ายพันพอดี):");
    for (const d of branch.departments) {
      addLine(`    ${d.label} (${d.code}): >= ${d.minQtyLiters.toLocaleString()} ลิตร${d.fixedFreightRate !== null ? ` · ค่าขนส่ง/ลิตร คงที่ ${d.fixedFreightRate} บาท` : ""}${d.fixedSalesperson ? ` · เซลล์คงที่ "${d.fixedSalesperson}"` : ""}`);
    }
  }
  addLine("- ชีทรถแต่ละคันแสดงทุกแถวของทุกชนิดสินค้า (รวมแถวที่ไม่เข้าเกณฑ์ไว้เพื่อการตรวจสอบ) — คอลัมน์ 'ค่าคอม' เป็น 0 อัตโนมัติถ้าไม่เข้าเกณฑ์");
  addLine("- ไม่ได้ตรวจการรวมบิลย่อยที่ต่ำกว่าเกณฑ์ของลูกค้ารายเดียวกันในวันเดียวกัน หากพบควรให้ผู้ใช้ยืนยันก่อนรวมบิล");
  blank();

  addSectionHeader("3) ลูกค้าที่ตัดออกจากค่าคอมการตลาด");
  // Exclusion is channel-scoped (branch-flat for รถทั่วไป vs each
  // department's own list — see DepartmentConfig.excludedCustomers), so
  // each entry is labeled with which channel it applies to rather than
  // implying a single branch-wide list.
  const scopedExclusions = [
    ...branch.excludedCustomers.map((e) => ({ ...e, scope: "รถทั่วไป" })),
    ...(branch.departments?.flatMap((d) => d.excludedCustomers.map((e) => ({ ...e, scope: d.label }))) ?? []),
  ];
  if (scopedExclusions.length === 0) addLine("- ไม่มี");
  for (const e of scopedExclusions) {
    addLine(`- [${e.scope}] ${e.customerCode} ${e.customerName} — ${e.reason} จึงตัดออกทั้งหมด (ยืนยันจากผู้ใช้ ${branch.confirmDateLabel})`);
  }
  const meterAnnotated = [...new Map(input.rows.filter((r) => r.meterAnnotation && r.calc.qualifiesByQty).map((r) => [r.customerCode, r])).values()];
  for (const r of meterAnnotated) {
    addLine(
      `- ${r.customerCode} ${r.customerName} มีข้อความ '${r.meterAnnotation}' กำกับในรายงานยอดขาย แต่ผู้ใช้ยืนยันว่านับเป็นค่าคอมเซลล์จริง จึงนับรวมค่าคอมตามปกติ`
    );
  }
  addLine("- หากพบลูกค้ารถมิเตอร์รายอื่นปะปนอยู่ในรายงานยอดขายสาขา ควรตรวจสอบและตัดออกในลักษณะเดียวกัน");
  blank();

  addSectionHeader("4) ประเภท (ขายสด/ขายเชื่อ)");
  addLine("- ใช้กฎ: เลขที่เอกสารขึ้นต้นด้วย H = ขายสด, ขึ้นต้นด้วย I = ขายเชื่อ (ไม่ใช่ 100% แน่นอน — ควรสุ่มตรวจกับระบบบัญชีเป็นระยะ)");
  addLine(
    `- เกณฑ์กำไรต่อลิตร (ขายสด>=${(branch.thresholds.cash * 100).toFixed(0)}สต./ลิตร, ขายเชื่อ>=${(branch.thresholds.credit * 100).toFixed(0)}สต./ลิตร, ค้างชำระ>=${(branch.thresholds.overdue * 100).toFixed(0)}สต./ลิตร, อัตรา ${(branch.ratePerLiter * 100).toFixed(0)}สต./ลิตร) ใช้เกณฑ์เดียวกันทุกชนิดน้ำมัน`
  );
  blank();

  addSectionHeader("5) ค่าขนส่ง/ระยะทาง");
  addLine(`- ระยะทาง(กม.) และเซลล์ต่อรหัสลูกค้า อ้างอิงจากไฟล์ '${branch.masterFileLabel}'`);
  if (branch.masterOverrides.length > 0) {
    addLine(
      `- ลูกค้าที่ไม่มีในไฟล์ ${branch.masterOverrides.length} ราย ได้รับข้อมูลจากผู้ใช้โดยตรง (ทำเครื่องหมายสีเหลืองในชีท Master): ` +
        branch.masterOverrides
          .map((o) => `${o.customerCode}(${o.distanceKm ?? "ทางผ่าน"}กม./${o.salesperson}${o.reuseFromCustomerCode ? ` - อิงจาก ${o.reuseFromCustomerCode}` : ""})`)
          .join(", ")
    );
  }
  addLine("- ลูกค้าที่มีแท็ก '1สาย1สู้' หรือ 'ทางผ่าน' (ระยะทางว่าง) ใช้ค่าขนส่ง/ลิตร = 0");
  const missingBehaviorNote =
    branch.freightMissingBehavior === "block"
      ? "ค่าขนส่งจะขึ้น 'ต้องตรวจสอบระยะทาง(M)' แทนการเดา — ต้องกรอกระยะทางหรือยืนยันแท็กก่อนแถวนั้นจึงจะคำนวณค่าคอมได้"
      : "ค่าขนส่งถูกตั้งเป็น 0 โดยดีฟอลต์ — ต้องยืนยันระยะทาง/เซลล์จริงก่อนส่งมอบ";
  const noMasterCodes = [...new Set(input.rows.filter((r) => r.calc.qualifiesByQty && !r.masterFound).map((r) => r.customerCode))];
  addLine(
    noMasterCodes.length === 0
      ? "- ทุกลูกค้าที่เข้าเกณฑ์รอบนี้มีข้อมูล master ครบแล้ว"
      : `- ⚠ ลูกค้าที่เข้าเกณฑ์แต่ไม่พบในไฟล์ master เลยรอบนี้ (${missingBehaviorNote}): ${noMasterCodes.join(", ")}`
  );
  const blockedRows = input.rows.filter((r) => r.calc.blocked);
  if (blockedRows.length > 0) {
    addLine(
      `- ⚠ ${blockedRows.length} แถวถูก BLOCK (ไม่คำนวณค่าคอม จนกว่าจะแก้ไข) เพราะไม่มีระยะทางหรือระยะทางเกิน 209 กม.: ` +
        blockedRows.map((r) => `${r.customerCode} เอกสาร ${r.docNo}`).join(", ")
    );
  }
  blank();

  addSectionHeader(branch.debtDeductionMode === "auto" ? "6) การหักค่าคอมจากหนี้ที่ยังเก็บไม่ได้" : "6) หนี้ค้างที่ต้องพิจารณา (ยังไม่ได้หักอัตโนมัติ)");
  if (input.debtQtyTotal === 0) {
    addLine(`- จับคู่เลขที่เอกสารของรายการที่เข้าเกณฑ์ค่าคอมเดือนนี้ กับเอกสารที่ยังค้างชำระในรายงานลูกหนี้ ณ ${branch.arAsOfLabel} — ไม่พบรายการที่ตรงกันในรอบนี้`);
  } else if (branch.debtDeductionMode === "auto") {
    addLine(
      `- จับคู่เลขที่เอกสารของรายการที่เข้าเกณฑ์ค่าคอมเดือนนี้ กับเอกสารที่ยังค้างชำระในรายงานลูกหนี้ ณ ${branch.arAsOfLabel} — พบรายการตรงกัน รวม ฿${debtInformationalTotal.toLocaleString()} (ดูชีท 'หักหนี้ค้างชำระ') หักค่าคอมเฉพาะรายการนั้นตามลิตรจริง`
    );
  } else {
    addLine(
      `- จับคู่เลขที่เอกสารของรายการที่เข้าเกณฑ์ค่าคอมเดือนนี้ กับเอกสารที่ยังค้างชำระในรายงานลูกหนี้ ณ ${branch.arAsOfLabel} — พบรายการตรงกัน รวม ฿${debtInformationalTotal.toLocaleString()} (ดูชีท 'หักหนี้ค้างชำระ') แต่ตาม policy ข้อ 6-7 การหัก 50%/100% เป็นดุลยพินิจของบัญชี ไม่ใช่สูตรอัตโนมัติ — ยอดนี้ **ยังไม่ได้หัก** ออกจากค่าคอมสุทธิ (คอลัมน์ 'หนี้ค้างที่ต้องพิจารณา' ในชีทค่าคอมรวมตั้งไว้ที่ 0 ให้บัญชีกรอกเองหลังพิจารณา)`
    );
  }
  blank();

  addSectionHeader("7) บรรทัดสรุปในแต่ละชีทรถ");
  addLine("- ท้ายชีทของรถแต่ละคัน มี 2 บรรทัดสรุป: 'รวมทั้งชีท' และ 'รวมเฉพาะรายการที่เข้าเกณฑ์ค่าคอม' — ยอดค่าคอมรวมของทุกชีทรถบวกกันต้องเท่ากับยอด 'ค่าคอมมิชชั่นรวม (ก่อนหักหนี้)' ในชีท ค่าคอมรวม ถ้าไม่ตรงกันคือบั๊ก ต้องตามหาก่อนส่งมอบ");
  blank();

  const sentinelRows = input.rows.filter((r) => r.calc.commission === "ตรวจสอบประเภท(R)");
  addSectionHeader("8) เรื่องที่ยังไม่ได้คำนวณอัตโนมัติ / ควรตรวจสอบเพิ่มเติม");
  for (const note of input.standingNotes) addLine(`- ${note}`);
  addLine(
    sentinelRows.length === 0
      ? "- ไม่มีรายการที่ตรวจสอบประเภท(R) ไม่ได้ในรอบนี้"
      : `- ⚠ รายการที่ตรวจสอบประเภท(R) ไม่ได้ (เลขที่เอกสารไม่ขึ้นต้นด้วย H/I): ${sentinelRows.map((r) => `${r.customerCode} เอกสาร ${r.docNo}`).join(", ")}`
  );
  addLine("- ควรตรวจสอบกับฝ่ายบัญชีว่ายังมีลูกค้ารถมิเตอร์รายอื่น หรือรายการที่มีข้อความแทรก (เช่น 'มิเตอร์ XX') ปะปนอยู่ในรายงานยอดขายสาขาหรือไม่ และอัปเดตไฟล์ master ให้ครบสำหรับเดือนถัดไป");
  blank();

  if (input.warnings.length > 0) {
    addSectionHeader("9) คำเตือนจากระบบ (parsing/checksum)");
    for (const w of input.warnings.slice(0, 30)) addLine(`- ${w}`);
    if (input.warnings.length > 30) addLine(`- ... และอีก ${input.warnings.length - 30} รายการ`);
  }

  notesSheet.getColumn(1).width = 140;
  notesSheet.eachRow((row) => row.eachCell((c) => (c.alignment = { wrapText: true, vertical: "top" })));

  const buf = await workbook.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}
