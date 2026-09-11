import { extractPdfText } from "./parser/pdfExtract";
import { parseSalesReportText } from "./parser/salesReport";
import { parseArReportText } from "./parser/arReport";
import { parseDistanceMasterText } from "./parser/distanceMaster";
import { ocrCustomerNamesFromMasterPdf } from "./parser/ocrNames";
import { calculateTransaction, type SaleType, type TransactionCalcResult } from "./calc/commissionEngine";
import type { BranchConfig, DepartmentConfig } from "@/branches/types";
import { buildCommissionWorkbook, type ExportTransactionRow, type MasterSheetRow, type SheetScope } from "./excelExport";

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
    /** the amount actually netted out of netCommission — 0 for a
     *  "flagOnly" branch even when matchedDebtFlagged is nonzero */
    debtDeduction: number;
    netCommission: number;
    /** the full amount of matched outstanding-debt bills found, regardless
     *  of whether debtDeductionMode actually applies it — surfaced so a
     *  "flagOnly" branch's UI can still show accounting that review is
     *  needed even though debtDeduction/netCommission above show 0 */
    matchedDebtFlagged: number;
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
      customerName: `${ex.customerName} (ตัดออก)`,
      distanceKm: null,
      salesperson: `ตัดออก - ไม่คิดค่าคอมการตลาด (${ex.reason})`,
      tag: "",
      sourceText: `${ex.reason} - ไม่นับค่าคอมการตลาด (ยืนยันจากผู้ใช้ ${branch.confirmDateLabel})`,
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
  // The master PDF's own embedded text layer is missing Thai tone
  // marks/vowels for customer names (a defect in the source file's font
  // encoding, not in how it's parsed — verified by rendering the page and
  // comparing against the visually-correct glyphs). OCR-ing that render
  // recovers the real name; scoped to just this one small, single-page file
  // — doing the same for every multi-hundred-row sales report would be far
  // too slow for a request/response API and far riskier (a misread digit in
  // a quantity directly corrupts the commission math, unlike a misread
  // letter in a display-only name).
  let ocrNamesByCode = new Map<string, string>();
  if (masterFile) {
    const masterText = await extractPdfText(masterFile.buffer);
    const parsedMaster = parseDistanceMasterText(masterText, branch.salespersonRoster);
    warnings.push(...parsedMaster.warnings.map((w) => `[master] ${w}`));
    masterFileRows = parsedMaster.rows;

    const ocrResult = await ocrCustomerNamesFromMasterPdf(masterFile.buffer);
    warnings.push(...ocrResult.warnings);
    ocrNamesByCode = ocrResult.namesByCode;
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
  const truckScopes = new Map<string, SheetScope>();
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
    const text = await extractPdfText(file.buffer);
    const parsed = parseSalesReportText(text);

    // Branches with `departments` (e.g. กระนวน) are classified by the sales
    // file's own "เลือกแผนก" header value (already extracted by the parser as
    // `truckCode`) rather than by filename — a department's qty threshold
    // and freight rule genuinely differ from another's (§2.1), so guessing
    // wrong here would silently apply the wrong money rule to a whole file.
    let department: DepartmentConfig | null = null;
    let truckLabel: string;
    if (branch.departments) {
      department = branch.departments.find((d) => d.code === parsed.truckCode) ?? null;
      if (!department) {
        warnings.push(
          `[${file.filename}] ไม่พบ 'เลือกแผนก' ที่ตรงกับแผนกที่ตั้งค่าไว้ (พบค่า: ${parsed.truckCode ?? "ไม่พบเลย"}) — ข้ามไฟล์นี้ทั้งหมด เพราะไม่ทราบเกณฑ์ปริมาณ/ค่าขนส่งที่ถูกต้อง ต้องตรวจสอบไฟล์และตั้งค่าแผนกให้ตรงก่อน`
        );
        continue;
      }
      truckLabel = department.label;
      if (!department.docPrefixes.some((p) => parsed.lines.some((l) => l.docNo.toUpperCase().startsWith(p)))) {
        warnings.push(`[${truckLabel}] เอกสารในไฟล์นี้ไม่ขึ้นต้นด้วย prefix ที่คาดไว้ (${department.docPrefixes.join("/")}) — ตรวจสอบว่าอัปโหลดไฟล์ถูกแผนกหรือไม่`);
      }
    } else {
      truckLabel = normalizeTruckLabel(file.filename);
    }
    truckLabels.push(truckLabel);
    if (!truckScopes.has(truckLabel)) {
      truckScopes.set(
        truckLabel,
        department
          ? { minQtyLiters: department.minQtyLiters, requireExactMultiple: department.requireExactMultiple, qtyMultipleOf: department.qtyMultipleOf, fixedFreightRate: department.fixedFreightRate }
          : { minQtyLiters: branch.minQtyLiters!, requireExactMultiple: branch.requireExactMultiple!, qtyMultipleOf: branch.qtyMultipleOf!, fixedFreightRate: null }
      );
    }
    const scope = truckScopes.get(truckLabel)!;

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

      let master = masterByCode.get(line.customerCode) ?? null;
      // A department whose whole roster is one fixed เซลล์ (กระนวน B3) never
      // needs a master row at all — its customers aren't on a delivery
      // route. Still synthesize one Master-sheet row per such customer (the
      // first time it's seen) so the sheet's own VLOOKUP formula resolves
      // "อ้อม" too, instead of only the JS-cached value knowing it — keeps
      // the live formula and the cached result in agreement.
      if (!master && department?.fixedSalesperson) {
        master = {
          customerName: customerNameByCode.get(line.customerCode) || line.customerNameRaw || line.customerCode,
          distanceKm: null,
          salesperson: department.fixedSalesperson,
          tag: "",
          sourceText: `แผนก ${department.label} (${department.code}) เป็นของเซลล์ "${department.fixedSalesperson}" คนเดียวทั้งแผนก (ยืนยันจากผู้ใช้ ${branch.confirmDateLabel}) — ไม่มีในไฟล์ master`,
        };
        masterByCode.set(line.customerCode, master);
      }
      const distanceKm = master?.distanceKm ?? null;
      const salesperson = master?.salesperson ?? null;
      const freightForcedZero = master?.tag === "1สาย1สู้" || master?.tag === "ทางผ่าน";
      const masterFound = master !== null;

      const calc: TransactionCalcResult = calculateTransaction(
        {
          id: `${truckLabel}:${line.sourceLineNo}`,
          productCode: line.productCode,
          qty: line.qty,
          saleValue: line.saleValue,
          cost: line.cost,
          customerCode: line.customerCode,
          distanceKm,
          fixedFreightRate: scope.fixedFreightRate,
          freightForcedZero,
          masterFound,
          saleType,
          salesperson,
        },
        {
          thresholds: branch.thresholds,
          ratePerLiter: branch.ratePerLiter,
          penaltyNegativeQEnabled: branch.penaltyNegativeQEnabled,
          freightMissingBehavior: branch.freightMissingBehavior,
        },
        {
          fuelProductCodes: fuelSet,
          minQtyLiters: scope.minQtyLiters,
          requireExactMultiple: scope.requireExactMultiple,
          qtyMultipleOf: scope.qtyMultipleOf,
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
        masterTag: master?.tag ?? "",
        masterFound,
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
  //
  // matchedDebtTotal is the full amount FOUND (always computed, always
  // shown in the "หักหนี้ค้างชำระ" sheet for visibility) — whether it is
  // actually netted out of ค่าคอมสุทธิ depends on branch.debtDeductionMode:
  // "auto" (สามทอง, confirmed against its own approved ฿180 reference
  // figure) subtracts it for real; "flagOnly" (กระนวน, confirmed in its own
  // approved reference workbook's หมายเหตุ item 5 — "คำนวณเต็มจำนวนไปก่อน
  // แล้วทำเครื่องหมายเตือนบัญชี... ตั้งค่าเริ่มต้น = 0") lists it for
  // accounting's own manual 50%/100% policy judgment (§6-7) and leaves the
  // applied deduction at 0. Never assume one branch's mode for the other.
  let matchedDebtTotal = 0;
  const debtMatches: ExportTransactionRow[] = [];
  for (const row of exportRows) {
    if (row.calc.commissionNumeric <= 0) continue;
    const matches = arByBaseDoc.get(row.baseDocNo);
    if (!matches || matches.length === 0) continue;
    row.outstandingAmount = row.calc.commissionNumeric;
    row.arOutstandingReference = matches.reduce((s, m) => s + m.outstanding, 0);
    matchedDebtTotal += row.outstandingAmount;
    debtMatches.push(row);
  }
  if (debtMatches.length === 0) {
    warnings.push("[หักหนี้] ไม่พบรายการที่ต้องหักหนี้ค้างชำระในรอบนี้");
  } else if (branch.debtDeductionMode === "flagOnly") {
    warnings.push(
      `[หักหนี้] พบ ${debtMatches.length} รายการค้างชำระ รวม ฿${matchedDebtTotal.toLocaleString()} — แจ้งเตือนเท่านั้น ยังไม่ได้หักออกจากค่าคอมสุทธิ บัญชีต้องพิจารณาหักเอง 50%/100% ตาม policy ข้อ 6-7 แล้วกรอกยอดหักด้วยมือในชีทค่าคอมรวม`
    );
  }
  const appliedDebtDeductionTotal = branch.debtDeductionMode === "auto" ? matchedDebtTotal : 0;

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
    if (r.calc.blocked) {
      warnings.push(`[${r.truckLabel}] ${r.customerCode} เอกสาร ${r.docNo}: ${r.calc.blockedReason} — ยังไม่นับค่าคอมแถวนี้จนกว่าจะแก้ไข`);
    }
  }

  const excludedCodes = new Set(branch.excludedCustomers.map((ex) => ex.customerCode));
  const overrideCodes = new Set(branch.masterOverrides.map((ov) => ov.customerCode));
  const masterRows: MasterSheetRow[] = [...masterByCode.entries()].map(([customerCode, e]) => ({
    customerCode,
    // Priority for the Master sheet's display name:
    //  - excluded customers keep their crafted exclusion label as-is.
    //  - masterOverrides customers keep the name typed directly into the
    //    branch config — that's already a manually-verified correct name
    //    (see samthong.ts), so it must win over the sales-report-derived
    //    name, which has the exact same font-encoding defect as the master
    //    file (just not OCR-corrected, since OCR only runs against the
    //    master PDF — see ocrNames.ts).
    //  - everyone else (master-file-sourced) prefers the OCR'd name (most
    //    reliable for Thai tone marks/vowels) over the sales-report name,
    //    over the raw uncorrected master-file text, over the bare code.
    customerName:
      excludedCodes.has(customerCode) || overrideCodes.has(customerCode)
        ? e.customerName
        : ocrNamesByCode.get(customerCode) || customerNameByCode.get(customerCode) || e.customerName || customerCode,
    salesperson: e.salesperson,
    distanceKm: e.distanceKm,
    tag: e.tag,
    sourceText: e.sourceText,
  }));

  const workbook = await buildCommissionWorkbook({
    branch,
    truckLabels,
    truckScopes,
    rows: exportRows,
    masterRows,
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
      debtDeduction: appliedDebtDeductionTotal,
      netCommission: grossCommission - appliedDebtDeductionTotal,
      matchedDebtFlagged: matchedDebtTotal,
    },
  };
}
