import ExcelJS from "exceljs";
import type { BranchConfig } from "@/branches/types";
import type { TransactionCalcResult } from "./calc/commissionEngine";

/**
 * Emits the workbook using the SAME live Excel formulas as
 * Template_คำนวณค่าคอมการตลาด.xlsx (verbatim, parametrized by row number and
 * the branch's own truck-sheet names) — not JS-precomputed values. This is
 * what the marketing-commission-calc SKILL requires ("สูตรทุกคอลัมน์เป็นสูตร
 * จริง (ไม่ใช่ค่าที่คำนวณมาแปะ) เพื่อให้ตรวจสอบ/รันซ้ำได้") and it means a
 * reviewer can fix a distance/เซลล์ in the Master sheet and everything
 * downstream recalculates in Excel itself, with no re-run of this tool
 * required. The JS commissionEngine result attached to each row is used
 * only to populate the "หมายเหตุ" column and the หมายเหตุ/summary sheets —
 * never written into the formula cells themselves.
 */

export interface ExportTransactionRow {
  truckLabel: string;
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
  masterSource: string | null;
  meterAnnotation: string | null;
  salesperson: string | null;
  outstandingAmount: number | null; // set once matched against AR (step 4)
  arOutstandingReference: number | null;
  calc: TransactionCalcResult;
}

export interface BuildWorkbookInput {
  branch: BranchConfig;
  truckLabels: string[];
  rows: ExportTransactionRow[];
  debtDeductionTotal: number;
  standingNotes: string[];
  warnings: string[];
}

const PRODUCT_NAME_BY_CODE: Record<string, string> = { DS: "ดีเซล B7", G91: "แก๊สโซฮอล์ 91", G95: "แก๊สโซฮอล์ 95" };

function productLabel(code: string): string {
  return PRODUCT_NAME_BY_CODE[code] ?? code;
}

function toThaiDateDisplay(ddmmyy: string): string {
  // input like "07/08/69" (Buddhist Era, 2-digit year) -> keep as-is; Excel
  // treats it as text here (the template's own sample rows are text dates
  // too, "01/08/2569"), so this is display-only, never used in a formula.
  const m = ddmmyy.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (!m) return ddmmyy;
  const yearBE = 2500 + parseInt(m[3], 10);
  return `${m[1]}/${m[2]}/${yearBE}`;
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

const HIGHLIGHT_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
const EXCLUDE_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4CCCC" } };

export async function buildCommissionWorkbook(input: BuildWorkbookInput): Promise<ArrayBuffer> {
  const { branch } = input;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "marketing-commission-calc";
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  const usedSheetNames = new Set<string>();

  // ---------- Master ----------
  const masterSheet = workbook.addWorksheet(safeSheetName("Master", usedSheetNames));
  masterSheet.addRow(["รหัสลูกค้า", "ชื่อลูกค้า", "เซลล์", "ระยะทาง(กม.)", "Tag", "ที่มา", "", "รายชื่อเซลล์ที่รับค่าคอม (สาขานี้)"]);
  masterSheet.getRow(1).font = { bold: true };

  const seenCustomers = new Map<
    string,
    { customerName: string; salesperson: string | null; distanceKm: number | null; tag: string; source: string; excluded: boolean }
  >();
  for (const r of input.rows) {
    if (!r.calc.qualifiesByQty) continue; // only customers with at least one qty-qualifying line, per SKILL
    if (seenCustomers.has(r.customerCode)) continue;
    const excludedEntry = branch.excludedCustomers.find((e) => e.customerCode === r.customerCode);
    seenCustomers.set(r.customerCode, {
      customerName: r.customerName || excludedEntry?.customerName || "",
      salesperson: excludedEntry ? "-" : r.salesperson,
      distanceKm: excludedEntry ? null : r.distanceKm,
      tag: excludedEntry ? "" : r.freightForcedZero ? (r.distanceKm === null ? "ทางผ่าน" : "1สาย1สู้") : "",
      source: excludedEntry ? `ตัดออก — ${excludedEntry.reason}` : r.masterSource ?? "⚠ ไม่พบในไฟล์ master — ต้องยืนยันระยะทาง/เซลล์กับผู้ใช้ก่อนส่งมอบ",
      excluded: !!excludedEntry,
    });
  }
  let masterRowIdx = 2;
  for (const [code, data] of seenCustomers) {
    const row = masterSheet.addRow([code, data.customerName, data.salesperson ?? "", data.distanceKm, data.tag, data.source]);
    if (data.excluded) row.eachCell((c) => (c.fill = EXCLUDE_FILL));
    else if (data.source.startsWith("ผู้ใช้ยืนยัน") || data.source.startsWith("⚠")) row.eachCell((c) => (c.fill = HIGHLIGHT_FILL));
    masterRowIdx++;
  }
  branch.salespersonRoster.forEach((name, i) => {
    masterSheet.getCell(`H${i + 2}`).value = name;
  });
  masterSheet.columns.forEach((c) => (c.width = 22));
  masterSheet.getColumn(2).width = 30;
  masterSheet.getColumn(6).width = 42;
  const masterLastRow = Math.max(masterRowIdx - 1, 2);

  // ---------- per-truck sheets ----------
  const TRUCK_HEADER = [
    "ลำดับ", "วันที่", "เลขที่เอกสาร", "รหัสลูกค้า", "ชื่อลูกค้า", "สินค้า", "ระยะทาง(กม.)", "Tag",
    "ปริมาณขายสุทธิ(ลิตร)", "มูลค่าขาย", "ต้นทุนขายสุทธิ", "กำไรขั้นต้น", "ค่าขนส่ง/ลิตร", "ค่าขนส่งรวม",
    "ต้นทุนรวม", "กำไรหลังหักขนส่ง", "กำไรต่อลิตร", "ประเภท", "เซลล์", "ค่าคอม", "หมายเหตุ", "เข้าเกณฑ์ปริมาณ(1/0)",
  ];
  const truckSheetNameByLabel = new Map<string, string>();

  for (const truckLabel of input.truckLabels) {
    const sheetName = safeSheetName(truckLabel, usedSheetNames);
    truckSheetNameByLabel.set(truckLabel, sheetName);
    const sheet = workbook.addWorksheet(sheetName);
    sheet.addRow(TRUCK_HEADER);
    sheet.getRow(1).font = { bold: true };

    const deptRows = input.rows.filter((r) => r.truckLabel === truckLabel);
    deptRows.forEach((r, idx) => {
      const excelRow = idx + 2;
      const noteParts = [...r.calc.flags];
      if (r.meterAnnotation) noteParts.push(`หมายเหตุจากไฟล์ขาย: "${r.meterAnnotation}" — ต้องยืนยันกับผู้ใช้ว่านับเป็นยอดเซลล์จริงหรือไม่ (ดูคู่มือ)`);
      if (r.outstandingAmount !== null) noteParts.push(`หักหนี้ค้างชำระ ฿${r.outstandingAmount.toLocaleString()} — พบในรายงานลูกหนี้ ณ วันที่ 7`);

      sheet.addRow([
        idx + 1,
        toThaiDateDisplay(r.docDate),
        r.docNo,
        r.customerCode,
        r.customerName,
        productLabel(r.productCode),
        { formula: `IFERROR(VLOOKUP(D${excelRow},Master!$A:$F,4,FALSE()),"")` },
        { formula: `IFERROR(VLOOKUP(D${excelRow},Master!$A:$F,5,FALSE()),"")` },
        r.qty,
        r.saleValue,
        r.cost,
        { formula: `IFERROR(J${excelRow}-K${excelRow},"")` },
        {
          formula:
            `IF(H${excelRow}="1สาย1สู้",0,IF(OR(G${excelRow}="",H${excelRow}="ทางผ่าน"),0,IFERROR(_xlfn.IFS(` +
            `AND(G${excelRow}>=20,G${excelRow}<=59),0.15,AND(G${excelRow}>=60,G${excelRow}<=69),0.17,` +
            `AND(G${excelRow}>=70,G${excelRow}<=79),0.19,AND(G${excelRow}>=80,G${excelRow}<=89),0.2,` +
            `AND(G${excelRow}>=90,G${excelRow}<=99),0.22,AND(G${excelRow}>=100,G${excelRow}<=109),0.24,` +
            `AND(G${excelRow}>=110,G${excelRow}<=129),0.28,AND(G${excelRow}>=130,G${excelRow}<=139),0.3,` +
            `AND(G${excelRow}>=140,G${excelRow}<=159),0.32,AND(G${excelRow}>=160,G${excelRow}<=169),0.34,` +
            `AND(G${excelRow}>=170,G${excelRow}<=179),0.35,AND(G${excelRow}>=180,G${excelRow}<=189),0.36,` +
            `AND(G${excelRow}>=190,G${excelRow}<=199),0.38,AND(G${excelRow}>=200,G${excelRow}<=209),0.39` +
            `),0)))`,
        },
        { formula: `IFERROR(M${excelRow}*I${excelRow},"")` },
        { formula: `IFERROR(N${excelRow}+K${excelRow},"")` },
        { formula: `IFERROR(J${excelRow}-O${excelRow},"")` },
        { formula: `IFERROR(P${excelRow}/I${excelRow},"")` },
        { formula: `IF(LEFT(C${excelRow},1)="H","ขายสด",IF(LEFT(C${excelRow},1)="I","ขายเชื่อ","ตรวจสอบประเภท(R)"))` },
        { formula: `IFERROR(VLOOKUP(D${excelRow},Master!$A:$F,3,FALSE()),"")` },
        {
          formula:
            `IFERROR(IF(OR(I${excelRow}="",R${excelRow}=""),0,` +
            `IF(OR(I${excelRow}<${branch.minQtyLiters},MOD(I${excelRow},${branch.qtyMultipleOf})<>0),0,` +
            `IF(COUNTIF(Master!$H$2:$H$${Math.max(masterLastRow, branch.salespersonRoster.length + 1)},S${excelRow})=0,0,` +
            `IF(R${excelRow}="ขายสด",IF(Q${excelRow}>=${branch.thresholds.cash},I${excelRow}*${branch.ratePerLiter},IF(Q${excelRow}>=0,0,${branch.penaltyNegativeQEnabled ? `-I${excelRow}*${branch.ratePerLiter}` : "0"})),` +
            `IF(R${excelRow}="ขายเชื่อ",IF(Q${excelRow}>=${branch.thresholds.credit},I${excelRow}*${branch.ratePerLiter},IF(Q${excelRow}>=0,0,${branch.penaltyNegativeQEnabled ? `-I${excelRow}*${branch.ratePerLiter}` : "0"})),` +
            `IF(R${excelRow}="ลูกหนี้ค้างชำระ",IF(Q${excelRow}>=${branch.thresholds.overdue},I${excelRow}*${branch.ratePerLiter},IF(Q${excelRow}>=0,0,${branch.penaltyNegativeQEnabled ? `-I${excelRow}*${branch.ratePerLiter}` : "0"})),` +
            `"ตรวจสอบประเภท(R)")))))),0)`,
        },
        noteParts.join("; "),
        { formula: `IF(AND(I${excelRow}<>"",I${excelRow}>=${branch.minQtyLiters},MOD(I${excelRow},${branch.qtyMultipleOf})=0),1,0)` },
      ]);
    });

    const lastRow = deptRows.length + 1;
    if (deptRows.length > 0) {
      const totalRow = lastRow + 2;
      const qualifyingRow = lastRow + 3;
      sheet.getRow(totalRow).getCell(5).value = "รวมทั้งชีท";
      sheet.getRow(totalRow).getCell(9).value = { formula: `SUM(I2:I${lastRow})` };
      sheet.getRow(totalRow).getCell(20).value = { formula: `SUM(T2:T${lastRow})` };
      sheet.getRow(qualifyingRow).getCell(5).value = "รวมเฉพาะรายการที่เข้าเกณฑ์ค่าคอม";
      sheet.getRow(qualifyingRow).getCell(9).value = { formula: `SUMIF(V2:V${lastRow},1,I2:I${lastRow})` };
      sheet.getRow(qualifyingRow).getCell(20).value = { formula: `SUM(T2:T${lastRow})` };
      sheet.getRow(totalRow).font = { bold: true };
      sheet.getRow(qualifyingRow).font = { bold: true };
    }

    sheet.columns.forEach((c) => (c.width = 15));
    sheet.getColumn(5).width = 26;
    sheet.getColumn(21).width = 40;
  }

  // ---------- หักหนี้ค้างชำระ ----------
  const debtSheet = workbook.addWorksheet(safeSheetName("หักหนี้ค้างชำระ", usedSheetNames));
  debtSheet.addRow(["รหัสลูกค้า", "ชื่อลูกค้า", "เอกสาร#", "วันที่", "ลิตรที่ต้องนำมาหักค่าคอม", "เซลล์", "ค่าคอมของรายการนี้ (หัก)", "ยอดคงค้างตามรายงานลูกหนี้ (อ้างอิงเท่านั้น)"]);
  debtSheet.getRow(1).font = { bold: true };
  const debtRows = input.rows.filter((r) => (r.outstandingAmount ?? 0) > 0);
  for (const r of debtRows) {
    debtSheet.addRow([r.customerCode, r.customerName, r.docNo, toThaiDateDisplay(r.docDate), r.qty, r.salesperson, r.outstandingAmount, r.arOutstandingReference]);
  }
  if (debtRows.length > 0) {
    const totalRow = debtRows.length + 2;
    debtSheet.getRow(totalRow).getCell(1).value = "รวม";
    debtSheet.getRow(totalRow).getCell(7).value = { formula: `SUM(G2:G${debtRows.length + 1})` };
    debtSheet.getRow(totalRow).font = { bold: true };
  } else {
    debtSheet.addRow(["ไม่พบรายการค้างชำระที่ตรงกับรายการเข้าเกณฑ์เดือนนี้"]);
  }
  debtSheet.columns.forEach((c) => (c.width = 20));
  debtSheet.getColumn(2).width = 28;

  // ---------- ค่าคอมรวม ----------
  const summarySheet = workbook.addWorksheet(safeSheetName("ค่าคอมรวม", usedSheetNames));
  summarySheet.addRow(["เซลล์", "ลิตรรวม (เข้าเกณฑ์)", "ค่าคอมมิชชั่นรวม (ก่อนหักหนี้)", "หักค่าคอมจากหนี้ค้างชำระ", "ค่าคอมสุทธิ"]);
  summarySheet.getRow(1).font = { bold: true };
  const truckSheetRefs = input.truckLabels.map((l) => `'${truckSheetNameByLabel.get(l)}'`);
  const salespersonRows: number[] = [];
  branch.salespersonRoster.forEach((name, i) => {
    const r = i + 2;
    salespersonRows.push(r);
    const qtyFormula = truckSheetRefs.map((s) => `SUMIFS(${s}!$I:$I,${s}!$S:$S,$A${r},${s}!$V:$V,1)`).join(" + ");
    const commFormula = truckSheetRefs.map((s) => `SUMIFS(${s}!$T:$T,${s}!$S:$S,$A${r})`).join(" + ");
    summarySheet.addRow([
      name,
      { formula: qtyFormula },
      { formula: commFormula },
      { formula: `SUMIF(หักหนี้ค้างชำระ!$F:$F,$A${r},หักหนี้ค้างชำระ!$G:$G)` },
      { formula: `C${r}-D${r}` },
    ]);
  });
  const grandRow = branch.salespersonRoster.length + 2;
  summarySheet.getRow(grandRow).getCell(1).value = "รวมทั้งหมด";
  ["B", "C", "D", "E"].forEach((col) => {
    summarySheet.getCell(`${col}${grandRow}`).value = { formula: `SUM(${col}2:${col}${grandRow - 1})` };
  });
  summarySheet.getRow(grandRow).font = { bold: true };
  summarySheet.addRow([]);
  summarySheet.addRow(["⚠ ก่อนส่งมอบไฟล์: เช็คว่า C" + grandRow + " เท่ากับผลรวมแถว 'รวมทั้งชีท' ของทุกชีทคันรถ — ถ้าไม่ตรงกันคือบั๊ก ต้องตามหาก่อนส่ง"]);
  summarySheet.columns.forEach((c) => (c.width = 24));

  // ---------- ใบปะหน้า ----------
  const coverSheet = workbook.addWorksheet(safeSheetName("ใบปะหน้า", usedSheetNames));
  coverSheet.addRow(["สัดส่วนแบ่งทีม (แก้ตามสาขา — ค่าเริ่มต้น = " + branch.label + ")", ""]);
  coverSheet.getRow(1).font = { bold: true };
  const roleRowByKey = new Map<string, number>();
  branch.teamSplit.roles.forEach((role, i) => {
    const r = i + 2;
    roleRowByKey.set(role.key, r);
    coverSheet.addRow([role.label, role.percent]); // remainder role's % here is informational only — see split table below
  });
  const sumRow = branch.teamSplit.roles.length + 2;
  coverSheet.getCell(`A${sumRow}`).value = "รวม % (ต้อง = 100%)";
  coverSheet.getCell(`B${sumRow}`).value = { formula: `SUM(B2:B${sumRow - 1})` };
  coverSheet.addRow([]);

  // Per-salesperson split table: column order matches branch.teamSplit.roles
  // exactly (เซลล์, สุทธิ, then one column per role in config order) so the
  // header row and the formula row can't drift apart. Fixed-percent roles
  // get ROUND(net*percent); the remainder role gets net minus every OTHER
  // role's own cell in the same row (SKILL: "เจ้าของยอดได้รับเศษที่เหลือ ไม่ใช่
  // round(net*60%)" — guarantees the row always sums to net exactly).
  const splitHeaderRow = sumRow + 2;
  const colLetterForRoleIdx = (i: number) => String.fromCharCode("C".charCodeAt(0) + i); // C, D, E, F...
  coverSheet.getRow(splitHeaderRow).values = ["เซลล์", "สุทธิ", ...branch.teamSplit.roles.map((r) => r.label)];
  coverSheet.getRow(splitHeaderRow).font = { bold: true };
  branch.salespersonRoster.forEach((name, i) => {
    const srcRow = salespersonRows[i];
    const outRow = splitHeaderRow + 1 + i;
    const cells: (string | number | { formula: string })[] = [name, { formula: `ค่าคอมรวม!E${srcRow}` }];
    branch.teamSplit.roles.forEach((role, roleIdx) => {
      if (role.isRemainder) {
        const otherCols = branch.teamSplit.roles
          .map((_, j) => j)
          .filter((j) => j !== roleIdx)
          .map((j) => colLetterForRoleIdx(j) + outRow);
        cells.push({ formula: `$B${outRow}${otherCols.length ? "-" + otherCols.join("-") : ""}` });
      } else {
        cells.push({ formula: `ROUND($B${outRow}*B${roleRowByKey.get(role.key)},2)` });
      }
    });
    coverSheet.addRow(cells);
  });
  coverSheet.columns.forEach((c) => (c.width = 22));

  // ---------- หมายเหตุ ----------
  const notesSheet = workbook.addWorksheet(safeSheetName("หมายเหตุ", usedSheetNames));
  notesSheet.addRow(["รายการ", "รายละเอียด"]);
  notesSheet.getRow(1).font = { bold: true };
  notesSheet.addRow(["เดือน/สาขา/BU ที่คำนวณ", `${branch.companyName} — สาขา${branch.label}`]);
  notesSheet.addRow(["ชนิดสินค้าที่นับเข้าเกณฑ์ค่าคอมรอบนี้", branch.fuelProductCodes.map(productLabel).join(", ")]);
  notesSheet.addRow(["เกณฑ์ปริมาณที่ใช้", `≥ ${branch.minQtyLiters.toLocaleString()} ลิตร${branch.requireExactMultiple ? ` และหารด้วย ${branch.qtyMultipleOf.toLocaleString()} ลงตัว` : ""}`]);
  notesSheet.addRow(["ลูกค้าที่ตัดออกและเหตุผล", branch.excludedCustomers.map((e) => `${e.customerCode} (${e.customerName}) — ${e.reason}`).join(" | ") || "ไม่มี"]);

  const meterAnnotated = input.rows.filter((r) => r.meterAnnotation && r.calc.qualifiesByQty);
  notesSheet.addRow([
    "รายการที่มีหมายเหตุ 'มิเตอร์ NN' ต้องยืนยันกับผู้ใช้",
    meterAnnotated.length === 0
      ? "ไม่พบในรอบนี้"
      : meterAnnotated.map((r) => `${r.customerCode} เอกสาร ${r.docNo} (${r.meterAnnotation})`).join(" | "),
  ]);
  notesSheet.addRow([
    "ข้อมูล master ที่ผู้ใช้ป้อนเองล่วงหน้า (masterOverrides ของสาขานี้)",
    branch.masterOverrides.map((o) => `${o.customerCode}: ${o.distanceKm ?? "ทางผ่าน"} กม./${o.salesperson} — ${o.source}`).join(" | ") || "ไม่มี",
  ]);
  notesSheet.addRow([
    "ผลการจับคู่หนี้ค้างชำระ",
    debtRows.length === 0 ? "ไม่พบรายการ" : `พบ ${debtRows.length} รายการ รวม ฿${input.debtDeductionTotal.toLocaleString()}`,
  ]);
  const sentinelRows = input.rows.filter((r) => r.calc.commission === "ตรวจสอบประเภท(R)");
  notesSheet.addRow([
    "รายการที่ต้องตรวจสอบประเภท(R)",
    sentinelRows.length === 0 ? "ไม่มี" : sentinelRows.map((r) => `${r.customerCode} เอกสาร ${r.docNo}`).join(" | "),
  ]);
  const noMasterRows = input.rows.filter((r) => r.calc.qualifiesByQty && r.calc.flags.some((f) => f.includes("ไม่พบลูกค้านี้ในไฟล์ master")));
  notesSheet.addRow([
    "ลูกค้าที่เข้าเกณฑ์แต่ไม่พบในไฟล์ master เลย (M ถูกตั้งเป็น 0 โดยดีฟอลต์ — ต้องยืนยันระยะทาง/เซลล์จริงก่อนส่งมอบ)",
    noMasterRows.length === 0 ? "ไม่มี" : [...new Set(noMasterRows.map((r) => r.customerCode))].join(", "),
  ]);
  for (const note of branch.standingNotes) {
    notesSheet.addRow(["ข้อสังเกตมาตรฐานของสาขานี้", note]);
  }
  for (const w of input.warnings) {
    notesSheet.addRow(["คำเตือนจากระบบ (parsing/checksum)", w]);
  }
  notesSheet.columns.forEach((c) => (c.width = 36));
  notesSheet.getColumn(2).width = 70;
  notesSheet.eachRow((row) => row.eachCell((c) => (c.alignment = { wrapText: true, vertical: "top" })));

  const buf = await workbook.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}
