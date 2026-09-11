import { extractPdfText } from "./parser/pdfExtract";
import { parseSalesReportText } from "./parser/salesReport";
import { parseArReportText } from "./parser/arReport";
import { parseDistanceMasterText } from "./parser/distanceMaster";
import { calculateTransaction, type SaleType, type TransactionCalcResult } from "./calc/commissionEngine";
import type { BranchConfig } from "@/branches/types";
import { buildCommissionWorkbook, type ExportTransactionRow } from "./excelExport";

export interface InputFile {
  filename: string;
  buffer: Buffer;
}

export interface PipelineResult {
  workbook: ArrayBuffer;
  warnings: string[];
  /** every parsed+calculated transaction row, for debugging/audit — the API
   *  route decides how much of this (if any) to forward to the client */
  rows: ExportTransactionRow[];
  summary: {
    truckCount: number;
    qualifyingTransactionCount: number;
    qualifyingCustomerCount: number;
    qualifyingLiters: number;
    grossCommission: number;
    debtDeduction: number;
    netCommission: number;
  };
}

function truckLabelFromFilename(filename: string): string {
  // Real filenames look like "เบอร์ 55_ST_8.69.pdf" / "เทรลเลอร์เบอร์ 73_ST_8.69.pdf" —
  // keep everything up to the first "_" as the human label, fall back to the
  // full stem if there's no underscore.
  const stem = filename.replace(/\.pdf$/i, "");
  const cut = stem.indexOf("_");
  return (cut > 0 ? stem.slice(0, cut) : stem).trim();
}

interface MasterEntry {
  productCode: string | null; // null = customer-level entry (excluded customer, or a masterOverride not tied to one product)
  distanceKm: number | null;
  salesperson: string | null;
  tag: "1สาย1สู้" | "ทางผ่าน" | "";
  source: string;
}

/**
 * Resolve a customer+product against the parsed master rows. Prefers an
 * exact product match (a customer can have different distances per product
 * — e.g. KCL680317: G91 and DS both at 53 km, but that's not guaranteed in
 * general); falls back to ANY other row for that customer per the SKILL's
 * own reuse rule ("if a customer has multiple master rows for different
 * products with the same distance, reuse that distance for other products
 * — distance is about the delivery location, not the product"). Excluded
 * customers are stored with productCode=null so they match regardless of
 * product.
 */
function resolveMaster(masterByCode: Map<string, MasterEntry[]>, customerCode: string, productCode: string): MasterEntry | null {
  const entries = masterByCode.get(customerCode);
  if (!entries || entries.length === 0) return null;
  return entries.find((e) => e.productCode === productCode) ?? entries.find((e) => e.productCode === null) ?? entries[0];
}

export async function runCommissionPipeline(
  branch: BranchConfig,
  salesFiles: InputFile[],
  arFile: InputFile,
  masterFile: InputFile | null
): Promise<PipelineResult> {
  const warnings: string[] = [];

  // ---------- parse master (distance + เซลล์) ----------
  // key: customer code, value: every row seen for that customer (one per
  // product it can differ by). Excluded customers (branch.excludedCustomers)
  // take priority over anything in the uploaded file — their เซลล์ is forced
  // to "-" so the roster check in the workbook zeroes them out no matter
  // what a master PDF happens to say. Then the uploaded file's own rows
  // (this month's ground truth). Then branch.masterOverrides fills any
  // remaining gap (a prior month's user-confirmed distance for a customer
  // still missing from the file) — only for customers the file didn't
  // already cover at all.
  const masterByCode = new Map<string, MasterEntry[]>();
  for (const ex of branch.excludedCustomers) {
    masterByCode.set(ex.customerCode, [{ productCode: null, distanceKm: null, salesperson: "-", tag: "", source: `ตัดออก — ${ex.reason}` }]);
  }
  if (masterFile) {
    const masterText = await extractPdfText(masterFile.buffer);
    const parsedMaster = parseDistanceMasterText(masterText, branch.salespersonRoster);
    warnings.push(...parsedMaster.warnings.map((w) => `[master] ${w}`));
    for (const row of parsedMaster.rows) {
      if (branch.excludedCustomers.some((e) => e.customerCode === row.customerCode)) continue; // exclusion override wins
      const list = masterByCode.get(row.customerCode) ?? [];
      list.push({ productCode: row.productCode, distanceKm: row.distanceKm, salesperson: row.salesperson, tag: row.tag, source: `ไฟล์ master (${masterFile.filename})` });
      masterByCode.set(row.customerCode, list);
    }
  } else {
    warnings.push("[master] ไม่ได้แนบไฟล์ master ระยะทาง/เซลล์ — จะใช้เฉพาะข้อมูลที่ยืนยันไว้ล่วงหน้าใน config สาขา (masterOverrides) เท่านั้น");
  }
  for (const ov of branch.masterOverrides) {
    if (masterByCode.has(ov.customerCode)) continue; // file (or exclusion) already covers this customer
    masterByCode.set(ov.customerCode, [{ productCode: ov.productCode ?? null, distanceKm: ov.distanceKm, salesperson: ov.salesperson, tag: ov.tag ?? "", source: ov.source }]);
  }

  // ---------- parse AR (outstanding debt) ----------
  const arText = await extractPdfText(arFile.buffer);
  const parsedAr = parseArReportText(arText);
  warnings.push(...parsedAr.warnings.map((w) => `[AR] ${w}`));
  const arByBaseDoc = new Map<string, typeof parsedAr.rows>();
  for (const row of parsedAr.rows) {
    const list = arByBaseDoc.get(row.baseDocNo) ?? [];
    list.push(row);
    arByBaseDoc.set(row.baseDocNo, list);
  }

  // ---------- parse + calculate every sales file ----------
  const exportRows: ExportTransactionRow[] = [];
  const truckLabels: string[] = [];
  const rosterSet = new Set(branch.salespersonRoster);
  const fuelSet = new Set(branch.fuelProductCodes);

  for (const file of salesFiles) {
    const truckLabel = truckLabelFromFilename(file.filename);
    truckLabels.push(truckLabel);
    const text = await extractPdfText(file.buffer);
    const parsed = parseSalesReportText(text);
    warnings.push(...parsed.warnings.map((w) => `[${truckLabel}] ${w}`));

    if (parsed.grandTotal) {
      const computedQty = parsed.lines.reduce((s, l) => s + l.qty, 0);
      const computedValue = parsed.lines.reduce((s, l) => s + l.saleValue, 0);
      if (Math.abs(computedQty - parsed.grandTotal.qtyTotal) > 0.5) {
        warnings.push(
          `[${truckLabel}] checksum ปริมาณไม่ตรง: รวมจากรายการ ${computedQty.toLocaleString()} ลิตร แต่ไฟล์ระบุ ${parsed.grandTotal.qtyTotal.toLocaleString()} ลิตร — ตรวจสอบว่า parse ครบทุกแถวหรือไม่`
        );
      }
      if (Math.abs(computedValue - parsed.grandTotal.valueTotal) > 5) {
        warnings.push(
          `[${truckLabel}] checksum มูลค่าไม่ตรง: รวมจากรายการ ${computedValue.toLocaleString()} บาท แต่ไฟล์ระบุ ${parsed.grandTotal.valueTotal.toLocaleString()} บาท`
        );
      }
    }

    for (const line of parsed.lines) {
      const docPrefix = line.docNo.charAt(0).toUpperCase();
      const saleType = (branch.docPrefixToSaleType[docPrefix] ?? "unknown") as SaleType | "unknown";

      const master = resolveMaster(masterByCode, line.customerCode, line.productCode);
      const distanceKm = master?.distanceKm ?? null;
      const salesperson = master?.salesperson ?? null;
      const freightForcedZero = master?.tag === "1สาย1สู้" || master?.tag === "ทางผ่าน";

      const calc: TransactionCalcResult = calculateTransaction(
        {
          id: `${truckLabel}:${line.sourceLineNo}`,
          productCode: line.productCode,
          qty: line.qty,
          saleValue: line.saleValue,
          cost: line.cost,
          customerCode: line.customerCode,
          distanceKm,
          freightForcedZero,
          masterFound: master !== null,
          saleType,
          salesperson,
        },
        { thresholds: branch.thresholds, ratePerLiter: branch.ratePerLiter, penaltyNegativeQEnabled: branch.penaltyNegativeQEnabled },
        {
          fuelProductCodes: fuelSet,
          minQtyLiters: branch.minQtyLiters,
          requireExactMultiple: branch.requireExactMultiple,
          qtyMultipleOf: branch.qtyMultipleOf,
          salespersonRoster: rosterSet,
        },
        branch.freightTiers
      );

      exportRows.push({
        truckLabel,
        docNo: line.docNo,
        baseDocNo: line.baseDocNo,
        docDate: line.date,
        customerCode: line.customerCode,
        customerName: line.customerNameRaw,
        productCode: line.productCode,
        qty: line.qty,
        saleValue: line.saleValue,
        cost: line.cost,
        saleType: saleType === "unknown" ? null : saleType,
        distanceKm,
        freightForcedZero,
        masterSource: master?.source ?? null,
        meterAnnotation: line.meterAnnotation,
        salesperson,
        outstandingAmount: null,
        arOutstandingReference: null,
        calc,
      });
    }
  }

  // ---------- debt-deduction match ----------
  // SKILL §4: only rows that themselves qualify with a POSITIVE computed
  // commission are candidates — never the AR balance itself, never a
  // sibling invoice that isn't itself matched.
  let debtDeductionTotal = 0;
  const debtMatches: ExportTransactionRow[] = [];
  for (const row of exportRows) {
    if (row.calc.commissionNumeric <= 0) continue;
    const matches = arByBaseDoc.get(row.baseDocNo);
    if (!matches || matches.length === 0) continue;
    row.outstandingAmount = row.calc.commissionNumeric;
    row.arOutstandingReference = matches.reduce((s, m) => s + m.outstanding, 0);
    debtDeductionTotal += row.outstandingAmount;
    debtMatches.push(row);
  }
  if (debtMatches.length === 0) {
    warnings.push("[หักหนี้] ไม่พบรายการที่ต้องหักหนี้ค้างชำระในรอบนี้");
  }

  // ---------- summary ----------
  // The SKILL uses two different scopes side by side in its own reference
  // numbers ("รายการเข้าเกณฑ์ 55 รายการ จาก 22 ลูกค้า รวม 154,000 ลิตร"):
  //  - transaction/customer COUNT = every row that passed the product +
  //    qty/round-1000 gate (step 1), BEFORE the step-1b customer exclusion —
  //    matches column V (เข้าเกณฑ์ปริมาณ) in the workbook, independent of
  //    whether a เซลล์ ever resolves.
  //  - liters/ค่าคอม = the same set MINUS excluded customers (ST57039 has
  //    qty-qualifying rows but contributes 0 liters/commission once
  //    excluded) — matches the workbook's roster-gated T (ค่าคอม) column.
  // Verified against the ST_8.69 reference: qtyQualifyingRows below comes to
  // exactly 55/22, and earningRows' liters/commission come to exactly
  // 154,000 ลิตร / ฿4,500.
  const qtyQualifyingRows = exportRows.filter((r) => r.calc.qualifiesByQty);
  const earningRows = qtyQualifyingRows.filter((r) => r.salesperson && rosterSet.has(r.salesperson));
  const grossCommission = exportRows.reduce((s, r) => s + r.calc.commissionNumeric, 0);

  for (const r of qtyQualifyingRows) {
    for (const f of r.calc.flags) {
      if (f.includes("ไม่อยู่ในตารางค่าขนส่ง") || f.includes("ไม่พบลูกค้านี้ในไฟล์ master")) {
        warnings.push(`[${r.truckLabel}] ${r.customerCode} เอกสาร ${r.docNo}: ${f}`);
      }
    }
  }

  const workbook = await buildCommissionWorkbook({
    branch,
    truckLabels,
    rows: exportRows,
    debtDeductionTotal,
    standingNotes: branch.standingNotes,
    warnings,
  });

  return {
    workbook,
    warnings,
    rows: exportRows,
    summary: {
      truckCount: salesFiles.length,
      qualifyingTransactionCount: qtyQualifyingRows.length,
      qualifyingCustomerCount: new Set(qtyQualifyingRows.map((r) => r.customerCode)).size,
      qualifyingLiters: earningRows.reduce((s, r) => s + r.qty, 0),
      grossCommission,
      debtDeduction: debtDeductionTotal,
      netCommission: grossCommission - debtDeductionTotal,
    },
  };
}
