import { extractPdfText } from "./parser/pdfExtract";
import { parseSalesReportText } from "./parser/salesReport";
import { parseArReportText } from "./parser/arReport";
import { parseDistanceMasterText } from "./parser/distanceMaster";
import { calculateTransaction, type SaleType, type TransactionCalcResult } from "./calc/commissionEngine";
import type { BranchConfig } from "@/branches/types";
import { buildCommissionWorkbook, type ExportTransactionRow, type MasterSheetRow } from "./excelExport";

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

/**
 * "เบอร์ 55_ST_8.69.pdf" -> "รถ 55", "เทรลเลอร์เบอร์ 73_ST_8.69.pdf" -> "เทรลเลอร์
 * 73" — matches the sheet-naming convention used in the approved ST_8.69
 * reference workbook (verified against the user's own reference file).
 */
function normalizeTruckLabel(filename: string): string {
  const stem = filename.replace(/\.pdf$/i, "");
  const numMatch = stem.match(/\d+/);
  const num = numMatch ? numMatch[0] : "?";
  return stem.includes("เทรลเลอร์") ? `เทรลเลอร์ ${num}` : `รถ ${num}`;
}

interface MasterEntry {
  customerName: string;
  distanceKm: number | null;
  /** for a normal customer this is a roster name; for an excluded customer
   *  it's a descriptive non-roster label (e.g. "รถมิเตอร์ (ไม่คิดค่าคอมการตลาด)")
   *  so the T-column formula's roster check naturally zeroes it without any
   *  separate exclusion mechanism — mirrors the approved reference file. */
  salesperson: string;
  tag: "1สาย1สู้" | "ทางผ่าน" | "";
  sourceText: string;
}

function buildMasterEntries(
  branch: BranchConfig,
  masterFileRows: { customerCode: string; customerName: string; distanceKm: number | null; salesperson: string | null; tag: "1สาย1สู้" | "ทางผ่าน" | "" }[],
  masterFilename: string | null
): Map<string, MasterEntry> {
  const byCode = new Map<string, MasterEntry>();

  // 1. excluded customers take priority over anything else — their เซลล์
  // cell is set to a plainly non-roster descriptive label so the workbook's
  // roster check zeroes their commission no matter what any master file
  // says, matching the approved reference's own convention.
  for (const ex of branch.excludedCustomers) {
    byCode.set(ex.customerCode, {
      customerName: `${ex.customerName} (ลูกค้ารถมิเตอร์)`,
      distanceKm: null,
      salesperson: "รถมิเตอร์ (ไม่คิดค่าคอมการตลาด)",
      tag: "",
      sourceText: `ลูกค้าของพนักงานขับรถมิเตอร์ - ไม่นับค่าคอมการตลาด (ยืนยันจากผู้ใช้ ${branch.confirmDateLabel})`,
    });
  }

  // 2. the uploaded master file's own rows — one row per customer code,
  // first occurrence wins if the source PDF lists the same customer more
  // than once for different products (their distance is normally identical
  // per the SKILL's own reuse rule; a genuine conflict is rare enough that
  // picking the first-listed row is a reasonable default over blocking).
  for (const row of masterFileRows) {
    if (byCode.has(row.customerCode)) continue;
    byCode.set(row.customerCode, {
      customerName: row.customerName,
      distanceKm: row.distanceKm,
      salesperson: row.salesperson ?? "",
      tag: row.tag,
      sourceText: masterFilename ? `ไฟล์ '${branch.masterFileLabel}' (${branch.dataFolderLabel})` : "",
    });
  }

  // 3. branch.masterOverrides fills any customer still missing entirely.
  for (const ov of branch.masterOverrides) {
    if (byCode.has(ov.customerCode)) continue;
    const sourceText = ov.reuseFromCustomerCode
      ? `ยืนยันจากผู้ใช้ (${branch.confirmDateLabel}) - ใช้ระยะทาง/เซลล์เดียวกับ ${ov.reuseFromCustomerCode}`
      : `ยืนยันจากผู้ใช้ (${branch.confirmDateLabel}) - ไม่มีในไฟล์ master`;
    byCode.set(ov.customerCode, {
      customerName: ov.customerName,
      distanceKm: ov.distanceKm,
      salesperson: ov.salesperson,
      tag: ov.tag ?? "",
      sourceText,
    });
  }

  return byCode;
}

export async function runCommissionPipeline(
  branch: BranchConfig,
  salesFiles: InputFile[],
  arFile: InputFile,
  masterFile: InputFile | null
): Promise<PipelineResult> {
  const warnings: string[] = [];

  // ---------- parse master (distance + เซลล์) ----------
  let masterFileRows: Awaited<ReturnType<typeof parseDistanceMasterText>>["rows"] = [];
  if (masterFile) {
    const masterText = await extractPdfText(masterFile.buffer);
    const parsedMaster = parseDistanceMasterText(masterText, branch.salespersonRoster);
    warnings.push(...parsedMaster.warnings.map((w) => `[master] ${w}`));
    masterFileRows = parsedMaster.rows;
  } else {
    warnings.push("[master] ไม่ได้แนบไฟล์ master ระยะทาง/เซลล์ — จะใช้เฉพาะข้อมูลที่ยืนยันไว้ล่วงหน้าใน config สาขา (masterOverrides) เท่านั้น");
  }
  const masterByCode = buildMasterEntries(branch, masterFileRows, masterFile?.filename ?? null);

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
  // The sales-report parser's customer-header extraction is simple and
  // reliable (a header line is just "<name> /<code>"); the distance-master
  // PDF's own name text is not (it's reconstructed from a narrow, jumbled
  // multi-column table with no reliable separators — see distanceMaster.ts).
  // So the sales reports are the authoritative source for ชื่อลูกค้า in the
  // Master sheet too, not the master file's own (unreliable) name guess.
  const customerNameByCode = new Map<string, string>();

  for (const file of salesFiles) {
    const truckLabel = normalizeTruckLabel(file.filename);
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

    let excelRow = 2; // row 1 is the header; only non-walk-in rows get a row here
    for (const line of parsed.lines) {
      // A "-" customer code means a walk-in/pump-side cash sale with no
      // customer record at all — it can never resolve a เซลล์ or earn
      // commission, and the approved reference workbook leaves these out of
      // the sheet entirely rather than listing them as an audit row.
      if (line.customerCode === "-") continue;
      if (line.customerNameRaw && !customerNameByCode.has(line.customerCode)) {
        customerNameByCode.set(line.customerCode, line.customerNameRaw);
      }

      const docPrefix = line.docNo.charAt(0).toUpperCase();
      const saleType = (branch.docPrefixToSaleType[docPrefix] ?? "unknown") as SaleType | "unknown";

      const master = masterByCode.get(line.customerCode) ?? null;
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
        excelRow: excelRow++,
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
        masterFound: master !== null,
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
  //    qty/round-1000 gate (step 1), BEFORE the step-1b customer exclusion.
  //  - liters/ค่าคอม = the same set MINUS excluded customers (ST57039 has
  //    qty-qualifying rows but contributes 0 liters/commission once
  //    excluded).
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

  const excludedCodes = new Set(branch.excludedCustomers.map((ex) => ex.customerCode));
  const masterRows: MasterSheetRow[] = [...masterByCode.entries()].map(([customerCode, e]) => ({
    customerCode,
    customerName: excludedCodes.has(customerCode) ? e.customerName : customerNameByCode.get(customerCode) || e.customerName || customerCode,
    salesperson: e.salesperson,
    distanceKm: e.distanceKm,
    tag: e.tag,
    sourceText: e.sourceText,
  }));

  const workbook = await buildCommissionWorkbook({
    branch,
    truckLabels,
    rows: exportRows,
    masterRows,
    debtDeductionTotal,
    debtQtyTotal: debtMatches.reduce((s, r) => s + r.qty, 0),
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
