import { baseDocNo, parseThaiNumber } from "./normalize";
import type { ParsedArReport, ArOutstandingRow } from "./types";

/**
 * Parses "ลูกหนี้คงค้างแบบละเอียด" (detailed outstanding AR report), as of
 * the 7th of the month following the commission month.
 *
 * Verified directly against the real company-wide report (AR_ST_7.9.69.pdf,
 * ณ วันที่ 7 ก.ย. 2569 — covers every BU, not just one branch). Structure
 * per customer block:
 *
 *   ประเภทลูกคา   : ลูกคาหนวยรถมิเตอร        <- optional section heading,
 *                                              applies to every customer
 *                                              until the next "รวมตามประเภท"
 *                                              boundary line
 *      <name> /<code>
 *       <date>  <docno> [มิเตอร์ NN]   <bill_amount>   <paid_amount>   <outstanding>
 *                           RE<ref>  [<date>]              <alloc_amount>   <- write-off/
 *                                                                              payment
 *                                                                              allocation
 *                                                                              line, ignored
 *       รวมลูกคา   <name> /<code>     N ใบ   <total_outstanding>
 *
 * Confirmed: this report's document numbers are already the BASE document
 * number (no "-N" line-item suffix) — a sales-report doc number must have
 * its own "-N" suffix stripped (see normalize.ts baseDocNo) before matching
 * against `baseDocNo` here, per the SKILL's debt-deduction step.
 */

const CUSTOMER_HEADER_RE = /^(.+?)\s*\/\s*([A-Za-z0-9]+)\s*$/;
const BILL_LINE_RE =
  /^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\S+)(?:\s+(มิเตอร\S*\s*\d+))?\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s*$/;
const CATEGORY_HEADING_RE = /ประเภทลูกคา\s*:\s*(.+)$/;
const CATEGORY_BOUNDARY_RE = /^รวมตามประเภทลูกคา/;
const CUSTOMER_SUBTOTAL_RE = /^รวมลูกคา/;
const SKIP_MARKERS = ["หนา", "ลูกหนี้คงคาง", "รหัสลูกคา", "พนักงานขาย", "วันที่", "ตัดยอดโดย", "เอกสาร#", "จบรายงาน"];

export function parseArReportText(text: string): ParsedArReport {
  const warnings: string[] = [];
  const rows: ArOutstandingRow[] = [];
  const lines = text.split(/\r?\n/);

  const asOfMatch = text.match(/ณ\s*วันที่\s*(.+?)(?:\s{2,}|$)/m);
  const asOfDate = asOfMatch ? asOfMatch[1].trim() : null;
  if (!asOfDate) {
    warnings.push("ไม่พบวันที่ 'ณ วันที่' ในรายงานลูกหนี้ — โปรดตรวจสอบว่าไฟล์ถูกต้อง");
  }

  let currentCustomerName = "";
  let currentCustomerCode: string | null = null;
  let currentCategory: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (/^-{5,}/.test(trimmed) || /^={5,}/.test(trimmed)) continue;
    if (SKIP_MARKERS.some((m) => trimmed.startsWith(m) || trimmed.includes(m))) {
      // "ตัดยอดโดย" also appears as a real allocation sub-line prefix within
      // data rows, but those never start the trimmed line with it alone as
      // a header — safe to skip either way since alloc lines carry no
      // baseDocNo we need.
      const categoryHeading = trimmed.match(CATEGORY_HEADING_RE);
      if (categoryHeading) currentCategory = categoryHeading[1].trim();
      continue;
    }

    if (CATEGORY_BOUNDARY_RE.test(trimmed)) {
      currentCategory = null;
      continue;
    }
    if (CUSTOMER_SUBTOTAL_RE.test(trimmed)) continue;

    const billMatch = trimmed.match(BILL_LINE_RE);
    if (billMatch) {
      const [, billDate, docNoRaw, meterAnnotation, billAmountRaw, paidAmountRaw, outstandingRaw] = billMatch;
      rows.push({
        baseDocNo: baseDocNo(docNoRaw),
        customerCode: currentCustomerCode,
        customerNameRaw: currentCustomerName,
        billDate,
        billAmount: parseThaiNumber(billAmountRaw),
        paidAmount: parseThaiNumber(paidAmountRaw),
        outstanding: parseThaiNumber(outstandingRaw),
        meterAnnotation: meterAnnotation ? meterAnnotation.replace(/\s+/g, " ").trim() : null,
        category: currentCategory,
      });
      continue;
    }

    const headerMatch = trimmed.match(CUSTOMER_HEADER_RE);
    if (headerMatch && !/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(headerMatch[1])) {
      currentCustomerName = headerMatch[1].trim();
      currentCustomerCode = headerMatch[2].toUpperCase();
      continue;
    }
    // otherwise: allocation/write-off sub-line ("RE......") or decorative
    // line — ignore silently, not needed for the deduction match.
  }

  if (rows.length === 0) {
    warnings.push("ไม่พบรายการลูกหนี้เลยในไฟล์นี้ — ตรวจสอบรูปแบบไฟล์ก่อนใช้ผลลัพธ์");
  }

  return { rows, asOfDate, warnings };
}
