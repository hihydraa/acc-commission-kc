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
  masterFound: boolean;
  meterAnnotation: string | null;
  salesperson: string | null;
  outstandingAmount: number | null; // set once matched against AR (step 4)
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

export interface BuildWorkbookInput {
  branch: BranchConfig;
  truckLabels: string[];
  rows: ExportTransactionRow[];
  masterRows: MasterSheetRow[];
  debtDeductionTotal: number;
  debtQtyTotal: number;
  standingNotes: string[];
  warnings: string[];
}

const PRODUCT_NAME_BY_CODE: Record<string, string> = { DS: "ดีเซล B7", G91: "แก๊สโซฮอล์ 91", G95: "แก๊สโซฮอล์ 95" };

function productLabel(code: string): string {
  return PRODUCT_NAME_BY_CODE[code] ?? code;
}

function toThaiDateDisplay(ddmmyy: string): string {
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

function freightFormula(r: number): string {
  return (
    `IF(H${r}="1สาย1สู้",0,IF(G${r}="",0,IFERROR(_xlfn.IFS(` +
    `AND(G${r}>=20,G${r}<=59),0.15,AND(G${r}>=60,G${r}<=69),0.17,` +
    `AND(G${r}>=70,G${r}<=79),0.19,AND(G${r}>=80,G${r}<=89),0.2,` +
    `AND(G${r}>=90,G${r}<=99),0.22,AND(G${r}>=100,G${r}<=109),0.24,` +
    `AND(G${r}>=110,G${r}<=129),0.28,AND(G${r}>=130,G${r}<=139),0.3,` +
    `AND(G${r}>=140,G${r}<=159),0.32,AND(G${r}>=160,G${r}<=169),0.34,` +
    `AND(G${r}>=170,G${r}<=179),0.35,AND(G${r}>=180,G${r}<=189),0.36,` +
    `AND(G${r}>=190,G${r}<=199),0.38,AND(G${r}>=200,G${r}<=209),0.39` +
    `),0)))`
  );
}

function commissionFormula(r: number, branch: BranchConfig): string {
  const rosterCheck = branch.salespersonRoster.map((name) => `S${r}<>"${name}"`).join(",");
  const penalty = branch.penaltyNegativeQEnabled ? `-I${r}*${branch.ratePerLiter}` : "0";
  const tier = (label: string, threshold: number) =>
    `IF(R${r}="${label}",IF(Q${r}>=${threshold},I${r}*${branch.ratePerLiter},IF(Q${r}>=0,0,${penalty}))`;
  return (
    `IFERROR(IF(OR(I${r}="",R${r}=""),0,` +
    `IF(OR(I${r}<${branch.minQtyLiters},MOD(I${r},${branch.qtyMultipleOf})<>0),0,` +
    `IF(AND(${rosterCheck}),0,` +
    `${tier("ขายสด", branch.thresholds.cash)},` +
    `${tier("ขายเชื่อ", branch.thresholds.credit)},` +
    `${tier("ลูกหนี้ค้างชำระ", branch.thresholds.overdue)},` +
    `"ตรวจสอบประเภท(R)")))))),0)`
  );
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
  masterSheet.addRow(["รหัสลูกค้า", "เซลล์", "ระยะทาง(กม.)", "Tag", "ชื่อลูกค้า", "ที่มา"]);
  masterSheet.getRow(1).font = { bold: true };
  for (const m of input.masterRows) {
    const isExcluded = branch.excludedCustomers.some((e) => e.customerCode === m.customerCode);
    const isUserConfirmed = m.sourceText.startsWith("ยืนยันจากผู้ใช้");
    const row = masterSheet.addRow([m.customerCode, m.salesperson, m.distanceKm, m.tag, m.customerName, m.sourceText]);
    if (isExcluded) row.eachCell((c) => (c.fill = EXCLUDE_FILL));
    else if (isUserConfirmed) row.eachCell((c) => (c.fill = HIGHLIGHT_FILL));
  }
  masterSheet.columns.forEach((c) => (c.width = 22));
  masterSheet.getColumn(5).width = 32;
  masterSheet.getColumn(6).width = 46;

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
    sheet.getRow(1).font = { bold: true };

    const deptRows = input.rows.filter((r) => r.truckLabel === truckLabel);
    deptRows.forEach((r, idx) => {
      const excelRow = idx + 2;
      const noteParts = [...r.calc.flags];
      if (r.meterAnnotation) noteParts.push(`หมายเหตุจากไฟล์ขาย: "${r.meterAnnotation}" — ต้องยืนยันกับผู้ใช้ว่านับเป็นยอดเซลล์จริงหรือไม่`);
      if (r.outstandingAmount !== null) noteParts.push(`หักหนี้ค้างชำระ ฿${r.outstandingAmount.toLocaleString()} — พบในรายงานลูกหนี้ ณ ${branch.arAsOfLabel}`);

      sheet.addRow([
        idx + 1,
        toThaiDateDisplay(r.docDate),
        r.docNo,
        r.customerCode,
        r.customerName,
        productLabel(r.productCode),
        { formula: `IFERROR(VLOOKUP(D${excelRow},Master!$A:$D,3,FALSE()),"")` },
        { formula: `IFERROR(VLOOKUP(D${excelRow},Master!$A:$D,4,FALSE()),"")` },
        r.qty,
        r.saleValue,
        r.cost,
        { formula: `IFERROR(J${excelRow}-K${excelRow},"")` },
        { formula: freightFormula(excelRow) },
        { formula: `IFERROR(M${excelRow}*I${excelRow},"")` },
        { formula: `IFERROR(N${excelRow}+K${excelRow},"")` },
        { formula: `IFERROR(J${excelRow}-O${excelRow},"")` },
        { formula: `IFERROR(P${excelRow}/I${excelRow},"")` },
        { formula: `IF(LEFT(C${excelRow},1)="H","ขายสด",IF(LEFT(C${excelRow},1)="I","ขายเชื่อ","ตรวจสอบ"))` },
        { formula: `IFERROR(VLOOKUP(D${excelRow},Master!$A:$D,2,FALSE()),"ตรวจสอบเซลล์")` },
        { formula: commissionFormula(excelRow, branch) },
        noteParts.join("; "),
      ]);
    });

    const lastDataRow = deptRows.length + 1;
    truckLastRow.set(truckLabel, lastDataRow);
    if (deptRows.length > 0) {
      const totalRow = lastDataRow + 2;
      const qualifyingRow = lastDataRow + 3;
      const qtyRange = `I2:I${lastDataRow}`;
      const qualifyCond = `(${qtyRange}>=${branch.minQtyLiters})*(MOD(${qtyRange},${branch.qtyMultipleOf})=0)`;
      sheet.getRow(totalRow).getCell(5).value = "รวมทั้งชีท";
      sheet.getRow(totalRow).getCell(9).value = { formula: `SUM(${qtyRange})` };
      sheet.getRow(totalRow).getCell(20).value = { formula: `SUM(T2:T${lastDataRow})` };
      sheet.getRow(qualifyingRow).getCell(5).value = "รวมเฉพาะรายการที่เข้าเกณฑ์ค่าคอม";
      sheet.getRow(qualifyingRow).getCell(9).value = { formula: `SUMPRODUCT(${qualifyCond}*${qtyRange})` };
      sheet.getRow(qualifyingRow).getCell(20).value = { formula: `SUM(T2:T${lastDataRow})` };
      sheet.getRow(totalRow).font = { bold: true };
      sheet.getRow(qualifyingRow).font = { bold: true };
    }

    sheet.columns.forEach((c) => (c.width = 15));
    sheet.getColumn(5).width = 26;
    sheet.getColumn(21).width = 42;
  }

  // ---------- หักหนี้ค้างชำระ ----------
  const debtSheet = workbook.addWorksheet(safeSheetName("หักหนี้ค้างชำระ", usedSheetNames));
  debtSheet.mergeCells(1, 1, 1, 8);
  debtSheet.getCell("A1").value = `ลูกหนี้ ณ ${branch.arAsOfLabel} ที่ยังไม่จ่ายชำระ ตรงกับรายการที่เข้าเกณฑ์ค่าคอมเดือน ${branch.periodLabel} (ทุกชนิดน้ำมันที่เข้าเกณฑ์)`;
  debtSheet.getRow(1).font = { bold: true };
  debtSheet.addRow(["รหัสลูกค้า", "ชื่อลูกค้า", "เอกสาร#", "วันที่", "ลิตรที่ต้องนำมาหักค่าคอม", "เซลล์", "ค่าคอมของรายการนี้ (บาท)", `ยอดคงค้าง (บาท) ตามรายงานลูกหนี้ ${branch.arAsOfLabel}`]);
  debtSheet.getRow(2).font = { bold: true };
  const debtRows = input.rows.filter((r) => (r.outstandingAmount ?? 0) > 0);
  for (const r of debtRows) {
    const s = truckSheetNameByLabel.get(r.truckLabel)!;
    debtSheet.addRow([
      { formula: `'${s}'!D${r.excelRow}` },
      { formula: `'${s}'!E${r.excelRow}` },
      { formula: `'${s}'!C${r.excelRow}` },
      { formula: `'${s}'!B${r.excelRow}` },
      { formula: `'${s}'!I${r.excelRow}` },
      { formula: `'${s}'!S${r.excelRow}` },
      { formula: `'${s}'!T${r.excelRow}` },
      r.arOutstandingReference,
    ]);
  }
  const debtDataLast = debtRows.length + 2;
  if (debtRows.length > 0) {
    debtSheet.addRow([]);
    debtSheet.getCell(`A${debtDataLast + 2}`).value = "รวมลิตรที่ต้องหัก";
    debtSheet.getCell(`B${debtDataLast + 2}`).value = { formula: `SUM(E3:E${debtDataLast})` };
    debtSheet.getCell(`A${debtDataLast + 3}`).value = "รวมค่าคอมที่ต้องหัก";
    debtSheet.getCell(`B${debtDataLast + 3}`).value = { formula: `SUM(G3:G${debtDataLast})` };
    debtSheet.getRow(debtDataLast + 2).font = { bold: true };
    debtSheet.getRow(debtDataLast + 3).font = { bold: true };
    const noteStart = debtDataLast + 5;
    debtSheet.getCell(`A${noteStart}`).value = "หมายเหตุ:";
    debtSheet.getCell(`A${noteStart + 1}`).value =
      `- วิธีหัก: จับคู่เลขที่เอกสารของรายการที่เข้าเกณฑ์ค่าคอมเดือน ${branch.periodLabel} กับเอกสารที่ยังคงค้างในรายงานลูกหนี้คงค้างแบบละเอียด ณ วันที่ ${branch.arAsOfLabel}`;
    debtSheet.getCell(`A${noteStart + 2}`).value = `- พบ ${debtRows.length} รายการที่ตรงกัน:`;
    debtRows.forEach((r, i) => {
      debtSheet.getCell(`A${noteStart + 3 + i}`).value =
        `    ${i + 1}) ${r.customerCode} ${r.customerName} เอกสาร ${r.docNo} (${productLabel(r.productCode)} ${r.qty.toLocaleString()} ลิตร) ยอดคงค้าง ${(r.arOutstandingReference ?? 0).toLocaleString()} บาท`;
    });
    debtSheet.getCell(`A${noteStart + 3 + debtRows.length}`).value =
      "- ค่าคอมของแต่ละรายการคำนวณจากสูตรเดียวกับชีทรถ (ตามลิตรจริงของรายการนั้น) ไม่ได้หักเป็นยอดเงินคงค้างตรงๆ";
  } else {
    debtSheet.addRow(["ไม่พบรายการค้างชำระที่ตรงกับรายการเข้าเกณฑ์เดือนนี้"]);
  }
  debtSheet.columns.forEach((c) => (c.width = 20));
  debtSheet.getColumn(2).width = 28;
  debtSheet.getColumn(1).width = 90;

  // ---------- ค่าคอมรวม ----------
  const summarySheet = workbook.addWorksheet(safeSheetName("ค่าคอมรวม", usedSheetNames));
  summarySheet.addRow([
    "เซลล์",
    `จำนวนลิตร (รวมรายการที่เข้าเกณฑ์ >=${branch.minQtyLiters.toLocaleString()}L และลงท้ายพันพอดี ทุกชนิดน้ำมัน)`,
    "ค่าคอมมิชชั่นรวม (ก่อนหักหนี้)",
    "หักค่าคอมจากหนี้ค้างชำระ",
    "ค่าคอมสุทธิ",
  ]);
  summarySheet.getRow(1).font = { bold: true };
  branch.salespersonRoster.forEach((name, i) => {
    const r = i + 2;
    const qtyTerms = input.truckLabels.map((label) => {
      const s = truckSheetNameByLabel.get(label)!;
      const last = truckLastRow.get(label) ?? 1;
      return `SUMPRODUCT(('${s}'!$S$2:$S$${last}=$A${r})*('${s}'!$I$2:$I$${last}>=${branch.minQtyLiters})*(MOD('${s}'!$I$2:$I$${last},${branch.qtyMultipleOf})=0)*'${s}'!$I$2:$I$${last})`;
    });
    const commTerms = input.truckLabels.map((label) => {
      const s = truckSheetNameByLabel.get(label)!;
      const last = truckLastRow.get(label) ?? 1;
      return `SUMIF('${s}'!$S$2:$S$${last},$A${r},'${s}'!$T$2:$T$${last})`;
    });
    summarySheet.addRow([
      name,
      { formula: qtyTerms.join("+") },
      { formula: commTerms.join("+") },
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
  summarySheet.columns.forEach((c) => (c.width = 24));
  summarySheet.getColumn(2).width = 36;

  // ---------- ใบปะหน้า ----------
  const coverSheet = workbook.addWorksheet(safeSheetName("ใบปะหน้า", usedSheetNames));
  coverSheet.mergeCells(1, 1, 1, branch.teamSplit.roles.length + 2);
  coverSheet.getCell("A1").value = `สรุปค่าคอมมิชชั่นฝ่ายการตลาด สาขา${branch.label} - เดือน ${branch.periodLabel} (${branch.periodLabelThai})`;
  coverSheet.getRow(1).font = { bold: true, size: 13 };
  coverSheet.mergeCells(3, 1, 3, branch.teamSplit.roles.length + 2);
  coverSheet.getCell("A3").value =
    `หมายเหตุ: อัตราแบ่ง ${branch.teamSplit.roles.map((r) => `${r.label} ${(r.percent * 100).toFixed(0)}%`).join(" / ")} | เข้าเกณฑ์ =${branch.fuelProductCodes.map(productLabel).join("+")} ที่ >=${branch.minQtyLiters.toLocaleString()} ลิตร และลงท้ายพันพอดี | ไม่รวมลูกค้า${branch.excludedCustomers.map((e) => ` ${e.customerName}`).join(", ")} (ลูกค้ารถมิเตอร์)`;
  coverSheet.getRow(3).font = { italic: true };

  const splitHeaderRow = 5;
  const colLetterForRoleIdx = (i: number) => String.fromCharCode("C".charCodeAt(0) + i);
  coverSheet.getRow(splitHeaderRow).values = ["เจ้าของยอด (เซลล์)", "ค่าคอมสุทธิ (บาท)", ...branch.teamSplit.roles.map((r) => `${r.label} ${(r.percent * 100).toFixed(0)}%`)];
  coverSheet.getRow(splitHeaderRow).font = { bold: true };
  branch.salespersonRoster.forEach((name, i) => {
    const srcRow = i + 2; // ค่าคอมรวม row for this salesperson
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
        cells.push({ formula: `ROUND($B${outRow}*${role.percent},2)` });
      }
    });
    coverSheet.addRow(cells);
  });
  const totalRow = splitHeaderRow + 1 + branch.salespersonRoster.length;
  const totalCells: (string | { formula: string })[] = ["รวม"];
  for (let c = 2; c <= branch.teamSplit.roles.length + 2; c++) {
    const col = String.fromCharCode("A".charCodeAt(0) + c - 1);
    totalCells.push({ formula: `SUM(${col}${splitHeaderRow + 1}:${col}${totalRow - 1})` });
  }
  coverSheet.getRow(totalRow).values = totalCells;
  coverSheet.getRow(totalRow).font = { bold: true };
  coverSheet.columns.forEach((c) => (c.width = 22));

  // ---------- หมายเหตุ ----------
  const notesSheet = workbook.addWorksheet(safeSheetName("หมายเหตุ", usedSheetNames));
  let nr = 1;
  const addTitle = (text: string) => {
    notesSheet.getCell(`A${nr}`).value = text;
    notesSheet.getRow(nr).font = { bold: true };
    nr += 2;
  };
  const addLine = (text: string) => {
    notesSheet.getCell(`A${nr}`).value = text;
    nr++;
  };
  const blank = () => {
    nr++;
  };

  notesSheet.mergeCells(1, 1, 1, 2);
  addTitle(`หมายเหตุและข้อสมมติฐานในการคำนวณค่าคอม ${branch.id.toUpperCase()} เดือน ${branch.periodLabel}`);

  addLine("1) ขอบเขตข้อมูลที่ใช้");
  addLine(`- ไฟล์ยอดขายรายรถ: ${input.truckLabels.join(", ")} (ทั้งหมดในโฟลเดอร์ ${branch.dataFolderLabel})`);
  addLine(`- ไฟล์ระยะทาง/เซลล์: '${branch.masterFileLabel}'`);
  addLine(`- ไฟล์ลูกหนี้คงค้าง: รายงานลูกหนี้คงค้างแบบละเอียด ณ ${branch.arAsOfLabel}`);
  blank();

  addLine("2) เกณฑ์การกรองรายการที่เข้าเกณฑ์ค่าคอม");
  addLine(`- รวมน้ำมันใสทุกชนิด: ${branch.fuelProductCodes.map(productLabel).join(", ")}`);
  addLine(
    `- ปริมาณขายสุทธิต้อง >= ${branch.minQtyLiters.toLocaleString()} ลิตร ต่อ 1 เอกสาร${branch.requireExactMultiple ? ` 'และ' ต้องลงท้ายพันพอดี (หาร ${branch.qtyMultipleOf.toLocaleString()} ลงตัว) — เช่น 2,000/3,000/4,000 เข้าเกณฑ์ แต่ 2,500 ไม่เข้าเกณฑ์เลยทั้งบิล` : ""}`
  );
  addLine("- ชีทรถแต่ละคันแสดงทุกแถวของทุกชนิดสินค้า (รวมแถวที่ไม่เข้าเกณฑ์ไว้เพื่อการตรวจสอบ) — คอลัมน์ 'ค่าคอม' เป็น 0 อัตโนมัติถ้าไม่เข้าเกณฑ์");
  addLine("- ไม่ได้ตรวจการรวมบิลย่อยที่ต่ำกว่าเกณฑ์ของลูกค้ารายเดียวกันในวันเดียวกัน หากพบควรให้ผู้ใช้ยืนยันก่อนรวมบิล");
  blank();

  addLine("3) ลูกค้าที่ตัดออกจากค่าคอมการตลาด");
  if (branch.excludedCustomers.length === 0) addLine("- ไม่มี");
  for (const e of branch.excludedCustomers) {
    addLine(`- ${e.customerCode} ${e.customerName} — ${e.reason} จึงตัดออกทั้งหมด (ยืนยันจากผู้ใช้ ${branch.confirmDateLabel})`);
  }
  const meterAnnotated = [...new Map(input.rows.filter((r) => r.meterAnnotation && r.calc.qualifiesByQty).map((r) => [r.customerCode, r])).values()];
  for (const r of meterAnnotated) {
    addLine(
      `- ${r.customerCode} ${r.customerName} มีข้อความ '${r.meterAnnotation}' กำกับในรายงานยอดขาย แต่ผู้ใช้ยืนยันว่านับเป็นค่าคอมเซลล์จริง จึงนับรวมค่าคอมตามปกติ`
    );
  }
  addLine("- หากพบลูกค้ารถมิเตอร์รายอื่นปะปนอยู่ในรายงานยอดขายสาขา ควรตรวจสอบและตัดออกในลักษณะเดียวกัน");
  blank();

  addLine("4) ประเภท (ขายสด/ขายเชื่อ)");
  addLine("- ใช้กฎ: เลขที่เอกสารขึ้นต้นด้วย H = ขายสด, ขึ้นต้นด้วย I = ขายเชื่อ (ไม่ใช่ 100% แน่นอน — ควรสุ่มตรวจกับระบบบัญชีเป็นระยะ)");
  addLine(
    `- เกณฑ์กำไรต่อลิตร (ขายสด>=${(branch.thresholds.cash * 100).toFixed(0)}สต./ลิตร, ขายเชื่อ>=${(branch.thresholds.credit * 100).toFixed(0)}สต./ลิตร, ค้างชำระ>=${(branch.thresholds.overdue * 100).toFixed(0)}สต./ลิตร, อัตรา ${(branch.ratePerLiter * 100).toFixed(0)}สต./ลิตร) ใช้เกณฑ์เดียวกันทุกชนิดน้ำมัน`
  );
  blank();

  addLine("5) ค่าขนส่ง/ระยะทาง");
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
  const noMasterCodes = [...new Set(input.rows.filter((r) => r.calc.qualifiesByQty && !r.masterFound).map((r) => r.customerCode))];
  addLine(
    noMasterCodes.length === 0
      ? "- ทุกลูกค้าที่เข้าเกณฑ์รอบนี้มีข้อมูล master ครบแล้ว"
      : `- ⚠ ลูกค้าที่เข้าเกณฑ์แต่ไม่พบในไฟล์ master เลยรอบนี้ (ค่าขนส่งถูกตั้งเป็น 0 โดยดีฟอลต์ — ต้องยืนยันระยะทาง/เซลล์จริงก่อนส่งมอบ): ${noMasterCodes.join(", ")}`
  );
  blank();

  addLine("6) การหักค่าคอมจากหนี้ที่ยังเก็บไม่ได้");
  addLine(
    input.debtQtyTotal > 0
      ? `- จับคู่เลขที่เอกสารของรายการที่เข้าเกณฑ์ค่าคอมเดือนนี้ กับเอกสารที่ยังค้างชำระในรายงานลูกหนี้ ณ ${branch.arAsOfLabel} — พบรายการตรงกัน รวม ฿${input.debtDeductionTotal.toLocaleString()} (ดูชีท 'หักหนี้ค้างชำระ') หักค่าคอมเฉพาะรายการนั้นตามลิตรจริง`
      : `- จับคู่เลขที่เอกสารของรายการที่เข้าเกณฑ์ค่าคอมเดือนนี้ กับเอกสารที่ยังค้างชำระในรายงานลูกหนี้ ณ ${branch.arAsOfLabel} — ไม่พบรายการที่ตรงกันในรอบนี้`
  );
  blank();

  addLine("7) บรรทัดสรุปในแต่ละชีทรถ");
  addLine("- ท้ายชีทของรถแต่ละคัน มี 2 บรรทัดสรุป: 'รวมทั้งชีท' และ 'รวมเฉพาะรายการที่เข้าเกณฑ์ค่าคอม' — ยอดค่าคอมรวมของทุกชีทรถบวกกันต้องเท่ากับยอด 'ค่าคอมมิชชั่นรวม (ก่อนหักหนี้)' ในชีท ค่าคอมรวม ถ้าไม่ตรงกันคือบั๊ก ต้องตามหาก่อนส่งมอบ");
  blank();

  const sentinelRows = input.rows.filter((r) => r.calc.commission === "ตรวจสอบประเภท(R)");
  addLine("8) เรื่องที่ยังไม่ได้คำนวณอัตโนมัติ / ควรตรวจสอบเพิ่มเติม");
  for (const note of input.standingNotes) addLine(`- ${note}`);
  addLine(
    sentinelRows.length === 0
      ? "- ไม่มีรายการที่ตรวจสอบประเภท(R) ไม่ได้ในรอบนี้"
      : `- ⚠ รายการที่ตรวจสอบประเภท(R) ไม่ได้ (เลขที่เอกสารไม่ขึ้นต้นด้วย H/I): ${sentinelRows.map((r) => `${r.customerCode} เอกสาร ${r.docNo}`).join(", ")}`
  );
  addLine("- ควรตรวจสอบกับฝ่ายบัญชีว่ายังมีลูกค้ารถมิเตอร์รายอื่น หรือรายการที่มีข้อความแทรก (เช่น 'มิเตอร์ XX') ปะปนอยู่ในรายงานยอดขายสาขาหรือไม่ และอัปเดตไฟล์ master ให้ครบสำหรับเดือนถัดไป");
  blank();

  if (input.warnings.length > 0) {
    addLine("9) คำเตือนจากระบบ (parsing/checksum)");
    for (const w of input.warnings.slice(0, 30)) addLine(`- ${w}`);
    if (input.warnings.length > 30) addLine(`- ... และอีก ${input.warnings.length - 30} รายการ`);
  }

  notesSheet.getColumn(1).width = 120;
  notesSheet.eachRow((row) => row.eachCell((c) => (c.alignment = { wrapText: true, vertical: "top" })));

  const buf = await workbook.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}
