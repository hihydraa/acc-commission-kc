import Decimal from "decimal.js";
import { extractPdfText } from "./parser/pdfExtract";
import { fixThaiText } from "./parser/thaiPuaFix";
import { parseSalesReportText } from "./parser/salesReport";
import { parseArReportText } from "./parser/arReport";
import { calculateTransaction, type SaleType, type TransactionCalcResult } from "./calc/commissionEngine";
import { SHARED_THRESHOLDS, SHARED_RATE_PER_LITER, SHARED_PENALTY_NEGATIVE_Q_ENABLED, SHARED_DOC_PREFIX_TO_SALE_TYPE, DELIVERY_ROUTE_RULE, PUMP_FILL_RULE, type ChannelRule } from "./calc/channelRules";
import type { BranchConfig } from "@/branches/types";
import { buildCommissionWorkbook, type ExportTransactionRow, type MasterSheetRow, type SheetScope, type PeriodInfo } from "./excelExport";

export interface InputFile {
  filename: string;
  buffer: Buffer;
}

/**
 * Which of the 3 upload slots a file was dropped into — this alone decides
 * its rule set and sheet-label style now (2026-09-18: no more inferring the
 * channel from a filename pattern or an in-file "เลือกแผนก" header; the
 * header is still read by the parser and cross-checked against the chosen
 * channel as a validation-only warning, see below).
 */
export type ChannelKey = "meterTruck" | "trailer" | "pumpFill";

export interface ChannelInput {
  channel: ChannelKey;
  files: InputFile[];
}

const CHANNEL_RULE: Record<ChannelKey, ChannelRule> = {
  meterTruck: DELIVERY_ROUTE_RULE,
  trailer: DELIVERY_ROUTE_RULE,
  pumpFill: PUMP_FILL_RULE,
};

/**
 * Looks up one customer's confirmed master data. Backed by
 * `src/lib/googleSheets.ts` once Google service-account credentials exist;
 * until then, callers pass a stub that always returns null (see
 * `NullMasterLookup` below) so every qualifying customer is surfaced on the
 * confirmation page for manual entry — never silently guessed.
 */
export interface MasterLookup {
  get(customerCode: string): ResolvedMasterEntry | null;
}

export interface ResolvedMasterEntry {
  customerName: string;
  distanceKm: number | null;
  salesperson: string;
  tag: "1สาย1สู้" | "ทางผ่าน" | "";
}

export const NULL_MASTER_LOOKUP: MasterLookup = { get: () => null };

/** "55.pdf" -> "รถ 55", "70.pdf" -> "เทรลเลอร์ 70" — the label prefix now
 *  comes from which channel slot the file was dropped into, not from
 *  filename text like "เทรลเลอร์เบอร์..." (still tolerated harmlessly since
 *  only the leading number is extracted). */
function truckLabelForChannel(filename: string, channel: ChannelKey): string {
  const stem = filename.replace(/\.pdf$/i, "");
  const numMatch = stem.match(/\d+/);
  const num = numMatch ? numMatch[0] : "?";
  if (channel === "trailer") return `เทรลเลอร์ ${num}`;
  if (channel === "pumpFill") return "กรอกหลังปั๊ม";
  return `รถ ${num}`;
}

interface MasterEntry {
  customerName: string;
  distanceKm: number | null;
  /** for a normal customer this is a roster name; for an excluded customer
   *  it's a descriptive non-roster label (e.g. "รถมิเตอร์ (ไม่คิดค่าคอมการตลาด)")
   *  so the T-column formula's roster check naturally zeroes it without any
   *  separate exclusion mechanism */
  salesperson: string;
  tag: "1สาย1สู้" | "ทางผ่าน" | "";
  sourceText: string;
}

export interface PipelineResult {
  workbook: ArrayBuffer;
  warnings: string[];
  rows: ExportTransactionRow[];
  summary: {
    truckCount: number;
    qualifyingTransactionCount: number;
    qualifyingCustomerCount: number;
    qualifyingLiters: number;
    grossCommission: number;
    debtDeduction: number;
    netCommission: number;
    matchedDebtFlagged: number;
  };
}

export interface QualifyingCustomerPreview {
  customerCode: string;
  customerName: string;
  truckLabels: string[];
  /** null when this customer code has no row in the master lookup at all —
   *  the confirmation page must collect one before /api/calculate can run */
  resolved: ResolvedMasterEntry | null;
}

/**
 * Phase 1 of the confirm-before-calculate flow: parse every uploaded file,
 * keep only rows that pass the (universal, channel-based) qty rule, and
 * look each customer up in the branch's master data — WITHOUT running the
 * commission calc or building a workbook yet. The confirmation page
 * (src/app/confirm) renders this list for the user to review/edit; the
 * edited result is then sent to `runCommissionPipeline` (re-parsing the
 * same files, this time with a MasterLookup built from the confirmed data)
 * to actually produce the Excel.
 */
export async function previewQualifyingCustomers(
  branch: BranchConfig,
  channelInputs: ChannelInput[],
  masterLookup: MasterLookup = NULL_MASTER_LOOKUP
): Promise<{ customers: QualifyingCustomerPreview[]; warnings: string[] }> {
  const warnings: string[] = [];
  const fuelSet = new Set(branch.fuelProductCodes);
  const seen = new Map<string, QualifyingCustomerPreview>();

  for (const group of channelInputs) {
    const rule = CHANNEL_RULE[group.channel];
    for (const file of group.files) {
      const rawText = await extractPdfText(file.buffer);
      const { fixed: text } = fixThaiText(rawText);
      const parsed = parseSalesReportText(text);
      const truckLabel = truckLabelForChannel(file.filename, group.channel);
      warnings.push(...parsed.warnings.map((w) => `[${truckLabel}] ${w}`));

      for (const line of parsed.lines) {
        if (line.customerCode === "-") continue;
        const isExcluded = branch.excludedCustomers.some((e) => e.customerCode === line.customerCode);
        if (isExcluded) continue;
        const qualifiesByProduct = fuelSet.has(line.productCode);
        const qualifiesByQty = line.qty >= rule.minQtyLiters && (!rule.requireExactMultiple || line.qty % rule.qtyMultipleOf === 0);
        if (!qualifiesByProduct || !qualifiesByQty) continue;
        // A branch with a fixed กรอกหลังปั๊ม เซลล์ (set at /settings) needs no
        // confirmation at all for this channel — every customer here is
        // already fully determined, so surfacing thousands of them on the
        // confirmation page would just be noise.
        if (group.channel === "pumpFill" && branch.pumpFillSalesperson) continue;

        const existing = seen.get(line.customerCode);
        if (existing) {
          if (!existing.truckLabels.includes(truckLabel)) existing.truckLabels.push(truckLabel);
          continue;
        }
        const resolved = masterLookup.get(line.customerCode);
        seen.set(line.customerCode, {
          customerCode: line.customerCode,
          customerName: resolved?.customerName || line.customerNameRaw || line.customerCode,
          truckLabels: [truckLabel],
          resolved,
        });
      }
    }
  }

  return { customers: [...seen.values()], warnings };
}

export async function runCommissionPipeline(
  branch: BranchConfig,
  channelInputs: ChannelInput[],
  arFile: InputFile,
  period: PeriodInfo,
  roster: string[],
  masterLookup: MasterLookup = NULL_MASTER_LOOKUP
): Promise<PipelineResult> {
  const warnings: string[] = [];

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

  // ---------- parse + calculate every sales file, grouped by channel ----------
  const exportRows: ExportTransactionRow[] = [];
  const truckLabels: string[] = [];
  const truckScopes = new Map<string, SheetScope>();
  const rosterSet = new Set(roster);
  const fuelSet = new Set(branch.fuelProductCodes);
  const customerNameByCode = new Map<string, string>();
  const masterByCode = new Map<string, MasterEntry>();
  const excludedEntriesSeen = new Map<string, MasterEntry>();

  const EXPECTED_HEADER_HINT: Record<ChannelKey, string[]> = {
    // validation-only — a mismatch just warns, never blocks (see below)
    meterTruck: [],
    trailer: [],
    pumpFill: ["B3", "B4", "กรอกหลังปั๊ม"],
  };

  for (const group of channelInputs) {
    const rule = CHANNEL_RULE[group.channel];
    for (const file of group.files) {
      const rawText = await extractPdfText(file.buffer);
      const { fixed: text, unresolved } = fixThaiText(rawText);
      if (unresolved.size > 0) {
        warnings.push(
          `[${file.filename}] พบรหัส Unicode ที่ยังไม่รู้จักแน่ชัด (${[...unresolved].join(", ")}) ในบางจุด — ชื่อลูกค้าที่มีรหัสเหล่านี้อาจยังมีตัวอักษรผิดเพี้ยน ควรตรวจด้วยตาก่อนส่งมอบ`
        );
      }
      const parsed = parseSalesReportText(text);
      const truckLabel = truckLabelForChannel(file.filename, group.channel);

      // Validation-only cross-check: the file's own "เลือกแผนก" header (if
      // any) against the channel the user chose to upload it into — a
      // mismatch just warns (a different company's sales system may not
      // print this header at all, or use a value this list doesn't know
      // about yet), it never decides classification any more.
      const hint = EXPECTED_HEADER_HINT[group.channel];
      if (group.channel === "pumpFill" && parsed.truckCode && !hint.includes(parsed.truckCode)) {
        warnings.push(`[${truckLabel}] ไฟล์นี้อัปโหลดเข้าช่อง "กรอกหลังปั๊ม" แต่หัวไฟล์ระบุ "เลือกแผนก" เป็น "${parsed.truckCode}" — ตรวจสอบว่าอัปโหลดถูกช่องหรือไม่`);
      }

      truckLabels.push(truckLabel);
      if (!truckScopes.has(truckLabel)) {
        truckScopes.set(truckLabel, { minQtyLiters: rule.minQtyLiters, requireExactMultiple: rule.requireExactMultiple, qtyMultipleOf: rule.qtyMultipleOf, fixedFreightRate: rule.fixedFreightRate });
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

      const unknownProductQty = new Map<string, number>();
      for (const line of parsed.lines) {
        if (!fuelSet.has(line.productCode)) unknownProductQty.set(line.productCode, (unknownProductQty.get(line.productCode) ?? 0) + line.qty);
      }
      if (unknownProductQty.size > 0) {
        const summary = [...unknownProductQty.entries()].map(([code, qty]) => `${code || "(ว่าง)"}=${qty.toLocaleString()}ล.`).join(", ");
        warnings.push(`[${truckLabel}] พบรหัสสินค้าที่ไม่อยู่ใน fuelProductCodes ของสาขานี้ (ไม่นับรวมค่าคอมเลย จนกว่าจะยืนยัน): ${summary}`);
      }

      let excelRow = 2;
      for (const line of parsed.lines) {
        if (line.customerCode === "-") continue;
        if (line.customerNameRaw && !customerNameByCode.has(line.customerCode)) {
          customerNameByCode.set(line.customerCode, line.customerNameRaw);
        }

        const docPrefix = line.docNo.charAt(0).toUpperCase();
        const saleType = (SHARED_DOC_PREFIX_TO_SALE_TYPE[docPrefix] ?? "unknown") as SaleType | "unknown";

        let master = masterByCode.get(line.customerCode);
        if (!master) {
          const resolved = masterLookup.get(line.customerCode);
          if (resolved) {
            master = { ...resolved, sourceText: `Google Sheet แท็บ '${branch.sheetTabName}'` };
          } else if (group.channel === "pumpFill" && branch.pumpFillSalesperson) {
            // See branches/types.ts's pumpFillSalesperson doc comment —
            // these customers never appear in master data at all, the whole
            // channel belongs to one เซลล์ (set at /settings).
            master = {
              customerName: customerNameByCode.get(line.customerCode) || line.customerNameRaw || line.customerCode,
              distanceKm: null,
              salesperson: branch.pumpFillSalesperson,
              tag: "",
              sourceText: `เซลล์ประจำกรอกหลังปั๊ม "${branch.pumpFillSalesperson}" (ตั้งค่าไว้ที่หน้า Settings) — ไม่มีในข้อมูล master`,
            };
          }
          if (master) masterByCode.set(line.customerCode, master);
        }

        const exclusion = branch.excludedCustomers.find((e) => e.customerCode === line.customerCode) ?? null;
        if (exclusion && !excludedEntriesSeen.has(line.customerCode)) {
          excludedEntriesSeen.set(line.customerCode, {
            customerName: `${exclusion.customerName} (ตัดออก)`,
            distanceKm: null,
            salesperson: `ตัดออก - ไม่คิดค่าคอมการตลาด (${exclusion.reason})`,
            tag: "",
            sourceText: `${exclusion.reason} - ไม่นับค่าคอมการตลาด`,
          });
        }

        const distanceKm = exclusion ? null : master?.distanceKm ?? null;
        const salesperson = exclusion ? `ตัดออก - ไม่คิดค่าคอมการตลาด (${exclusion.reason})` : master?.salesperson ?? null;
        const freightForcedZero = !exclusion && (master?.tag === "1สาย1สู้" || master?.tag === "ทางผ่าน");
        const masterFound = exclusion !== null || master !== undefined;

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
            thresholds: SHARED_THRESHOLDS,
            ratePerLiter: SHARED_RATE_PER_LITER,
            penaltyNegativeQEnabled: SHARED_PENALTY_NEGATIVE_Q_ENABLED,
          },
          {
            fuelProductCodes: fuelSet,
            minQtyLiters: scope.minQtyLiters,
            requireExactMultiple: scope.requireExactMultiple,
            qtyMultipleOf: scope.qtyMultipleOf,
            salespersonRoster: rosterSet,
          }
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
          outstandingQty: null,
          outstandingFraction: null,
          arOutstandingReference: null,
          calc,
        });
      }
    }
  }

  // ---------- debt-deduction match (always applied — see excelExport.ts) ----------
  let matchedDebtTotal = 0;
  const debtMatches: ExportTransactionRow[] = [];
  for (const row of exportRows) {
    if (row.calc.commissionNumeric <= 0) continue;
    const matches = arByBaseDoc.get(row.baseDocNo);
    if (!matches || matches.length === 0) continue;
    const totalBillAmount = matches.reduce((s, m) => s + m.billAmount, 0);
    const totalOutstanding = matches.reduce((s, m) => s + m.outstanding, 0);
    const outstandingFraction = totalBillAmount > 0 ? Math.min(1, Math.max(0, totalOutstanding / totalBillAmount)) : 1;
    row.outstandingFraction = outstandingFraction;
    row.outstandingQty = new Decimal(row.qty).times(outstandingFraction).toDecimalPlaces(2).toNumber();
    row.outstandingAmount = new Decimal(row.calc.commissionNumeric).times(outstandingFraction).toDecimalPlaces(2).toNumber();
    row.arOutstandingReference = totalOutstanding;
    matchedDebtTotal += row.outstandingAmount;
    debtMatches.push(row);
  }
  if (debtMatches.length === 0) {
    warnings.push("[หักหนี้] ไม่พบรายการที่ต้องหักหนี้ค้างชำระในรอบนี้");
  }

  // ---------- summary ----------
  const qtyQualifyingRows = exportRows.filter((r) => r.calc.qualifiesByQty);
  const earningRows = qtyQualifyingRows.filter((r) => r.salesperson && rosterSet.has(r.salesperson));
  const grossCommission = exportRows.reduce((s, r) => s + r.calc.commissionNumeric, 0);

  for (const r of qtyQualifyingRows) {
    for (const f of r.calc.flags) {
      if (f.includes("ไม่อยู่ในตารางค่าขนส่ง") || f.includes("ไม่พบลูกค้านี้ใน")) {
        warnings.push(`[${r.truckLabel}] ${r.customerCode} เอกสาร ${r.docNo}: ${f}`);
      }
    }
    if (r.calc.blocked) {
      warnings.push(`[${r.truckLabel}] ${r.customerCode} เอกสาร ${r.docNo}: ${r.calc.blockedReason} — ยังไม่นับค่าคอมแถวนี้จนกว่าจะแก้ไข`);
    }
  }

  const combinedMasterEntries = new Map<string, MasterEntry>([...masterByCode, ...excludedEntriesSeen]);
  const excludedCodes = new Set(excludedEntriesSeen.keys());
  const masterRows: MasterSheetRow[] = [...combinedMasterEntries.entries()].map(([customerCode, e]) => ({
    customerCode,
    customerName: excludedCodes.has(customerCode) ? e.customerName : customerNameByCode.get(customerCode) || e.customerName || customerCode,
    salesperson: e.salesperson,
    distanceKm: e.distanceKm,
    tag: e.tag,
    sourceText: e.sourceText,
  }));

  const workbook = await buildCommissionWorkbook({
    branch,
    period,
    roster,
    truckLabels,
    truckScopes,
    rows: exportRows,
    masterRows,
    debtQtyTotal: debtMatches.reduce((s, r) => s + (r.outstandingQty ?? 0), 0),
    standingNotes: branch.standingNotes,
    warnings,
  });

  return {
    workbook,
    warnings,
    rows: exportRows,
    summary: {
      truckCount: channelInputs.reduce((s, g) => s + g.files.length, 0),
      qualifyingTransactionCount: qtyQualifyingRows.length,
      qualifyingCustomerCount: new Set(qtyQualifyingRows.map((r) => r.customerCode)).size,
      qualifyingLiters: earningRows.reduce((s, r) => s + r.qty, 0),
      grossCommission,
      debtDeduction: matchedDebtTotal,
      netCommission: grossCommission - matchedDebtTotal,
      matchedDebtFlagged: matchedDebtTotal,
    },
  };
}
