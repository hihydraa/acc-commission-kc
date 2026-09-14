import { normalizeDocNo, baseDocNo, normalizeThai, parseThaiNumber } from "./normalize";
import type { ParsedSalesReport, RawSalesLine } from "./types";

/**
 * Parses "รายงานสรุปยอดขาย แยกตามลูกค้า" (per-truck sales report) plain text,
 * already extracted from PDF via `extractPdfText` (see pdfExtract.ts — kept
 * separate so this stays pure-string-in/JSON-out and unit-testable without a
 * real PDF binary).
 *
 * Verified directly against the real สาขาสามทอง ส.ค. 2569 reference files
 * (เบอร์55/65/69/71, เทรลเลอร์73/74) — same underlying ERP export layout as
 * the ones this parser was first built against (a different BU, same
 * software). Column order, header/skip markers, and the checksum-critical
 * `extractQtyAndValue` layout below all held up unchanged.
 */

const SALE_LINE_RE = /^(\S.*?)\s+(\d{2}\/\d{2}\/\d{2})\s+(.*)$/;
// Captures "<name> /<code>" from the start of the line. Deliberately NOT
// anchored at the end — subtotal lines have more tokens (qty/value/"ลิตร")
// trailing after the code, unlike plain header lines.
const CODE_SUFFIX_RE = /^(.+?)\s*\/\s*(\S+)/;

/**
 * Distinguishes a customer header ("ปั๊มxxx /KCL660037") from a product
 * header ("ดีเซล B7 /DS") by the CODE'S SHAPE, not indentation — indentation
 * is not reliable across every PDF extraction path (pdf.js can collapse
 * repeated whitespace on some files). Customer codes are 1-5 letters
 * immediately followed by 4+ digits with nothing after (KCL680214,
 * ST600136, and confirmed against a real row this missed: "คุณอำนาจ
 * วิเศษปัสสา (ครอบครัวKC) /B4009" — a single-letter-prefixed code, which the
 * original {2,5} minimum wrongly rejected, misreading the whole line as a
 * PRODUCT header instead and silently dropping the customer's display name
 * — the sale line's own qty/value were unaffected since those come from
 * the sale line itself, not this header, so no earlier checksum caught it).
 * No product code in this report matches the 1-5-letters-then-4+-digits
 * shape either way — they're short mixed letter/digit tokens (DS, G91,
 * G95, B7) with too few trailing digits.
 */
const CUSTOMER_CODE_RE = /^[A-Za-z]{1,5}\d{4,}$/;

const SKIP_LINE_MARKERS = [
  "หน้า",
  "หนา :",
  "หนา:",
  "เลขที่เอกสาร",
  "รายการสินค้า",
  "รายการสินคา",
  "เขตการขายจาก",
  "วันที่จาก",
];
const NORMALIZED_SKIP_LINE_MARKERS = SKIP_LINE_MARKERS.map(normalizeThai);

// Anchored to the START of the line — this is meant to catch the report's
// own letterhead line (e.g. "หจก.สามทองบริการ" printed on every page), which
// never carries a trailing "/<code>". A customer whose own name happens to
// start with "บริษัท"/"ห้างหุ้นส่วน" (a very common Thai company-name prefix —
// real example: "บริษัทสหเมืองท่า ดีเวลลอปเม้นต์ จำกัด /ST51165") would
// otherwise get silently skipped by this same pattern, which doesn't drop
// its transaction rows (their customerCode column doesn't depend on this
// header) but does leave currentCustomerNameRaw stuck on the PREVIOUS
// customer's name for every row until the next real header — found by
// tracing why ST51165's debt-sheet rows showed ST51163's name. The
// CODE_SUFFIX_RE check below excludes that case: a real customer header
// always ends in "/<code>", the letterhead line never does.
const COMPANY_LINE_RE = /^(ห[จๆ]ก\.|บริษัท|ห้างหุ้นส่วน|หางหุนสวน)/;

function isNumericToken(token: string): boolean {
  return /^-?[\d,]+(\.\d+)?$/.test(token);
}

function isDecimalToken(token: string): boolean {
  return /^-?[\d,]+\.\d+$/.test(token);
}

/**
 * Column layout confirmed against real exported PDFs — a subtotal/
 * grand-total line always has exactly 6 quantity columns then, after the
 * "ลิตร" label, 9 value columns: [cash_qty, credit_qty, _, _, _, TOTAL_QTY]
 * ลิตร [cash_value, credit_value, _, _, TOTAL_VALUE, cost, _, profit,
 * profit%]. The trailing "profit%" column (a small number like 3.66) must
 * not be misread as the total value.
 */
export function extractQtyAndValue(line: string): { qty: number | null; value: number | null } {
  const litersIdx = line.indexOf("ลิตร");

  if (litersIdx !== -1) {
    const beforeNumbers = [...line.slice(0, litersIdx).matchAll(/-?[\d,]+\.\d+/g)].map((m) =>
      parseThaiNumber(m[0])
    );
    const qty = beforeNumbers.length > 0 ? beforeNumbers[beforeNumbers.length - 1] : null;

    const afterNumbers = [...line.slice(litersIdx + "ลิตร".length).matchAll(/-?[\d,]+\.\d+/g)].map((m) =>
      parseThaiNumber(m[0])
    );
    const value = afterNumbers.length >= 5 ? afterNumbers[4] : afterNumbers[afterNumbers.length - 1] ?? null;
    return { qty, value };
  }

  const numberTokens = [...line.matchAll(/-?[\d,]+\.\d+/g)].map((m) => parseThaiNumber(m[0]));
  if (numberTokens.length === 0) return { qty: null, value: null };
  const qty = numberTokens.length >= 6 ? numberTokens[5] : numberTokens[0];
  const value = numberTokens.length >= 11 ? numberTokens[10] : numberTokens[numberTokens.length - 1];
  return { qty, value };
}

export function parseSalesReportText(text: string): ParsedSalesReport {
  const warnings: string[] = [];
  const rawLines = text.split(/\r?\n/);

  const truckMatch = text.match(/เลือกแผนก\s*([A-Za-z0-9]+)/);
  const truckCode = truckMatch ? truckMatch[1].toUpperCase() : null;
  if (!truckCode) {
    warnings.push("ไม่พบบรรทัด 'เลือกแผนก' ในไฟล์ — ไม่สามารถระบุรหัสคันรถอัตโนมัติได้");
  }

  const result: ParsedSalesReport = {
    truckCode,
    lines: [],
    productSubtotals: [],
    customerSubtotals: [],
    grandTotal: null,
    warnings,
  };

  let currentProductCode = "";
  let currentProductName = "";
  let currentCustomerNameRaw = "";
  let grandTotalSeen = false;

  let productBlockQty = 0;
  let productBlockValue = 0;
  let customerBlockQty = 0;
  let customerBlockValue = 0;

  for (let i = 0; i < rawLines.length; i++) {
    if (grandTotalSeen) break;
    const raw = rawLines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const trimmedForSkipCheck = normalizeThai(trimmed);
    if (NORMALIZED_SKIP_LINE_MARKERS.some((m) => trimmedForSkipCheck.includes(m))) continue;
    if (COMPANY_LINE_RE.test(trimmed) && !CODE_SUFFIX_RE.test(trimmed)) continue;

    if (trimmed.startsWith("รวมทั้งสิ้น")) {
      const { qty, value } = extractQtyAndValue(trimmed);
      const countMatch = trimmed.match(/([\d,]+)\s*ราย/);
      result.grandTotal = {
        customerCount: countMatch ? parseInt(countMatch[1].replace(/,/g, ""), 10) : null,
        qtyTotal: qty ?? 0,
        valueTotal: value ?? 0,
        rawLine: trimmed,
      };
      grandTotalSeen = true;
      continue;
    }

    if (trimmed.startsWith("รวมลูกคา") || trimmed.startsWith("รวมลูกค้า")) {
      const { qty, value } = extractQtyAndValue(trimmed);
      const nameMatch = trimmed.match(/^รวมลูกค[้]?า\s*(.+?)(?:\s*\/|\s+\d)/);
      result.customerSubtotals.push({
        customerNameRaw: nameMatch ? nameMatch[1].trim() : trimmed,
        qtyTotal: qty ?? 0,
        valueTotal: value ?? 0,
        qtyComputed: customerBlockQty,
        valueComputed: customerBlockValue,
        rawLine: trimmed,
      });
      customerBlockQty = 0;
      customerBlockValue = 0;
      continue;
    }

    const saleMatch = trimmed.match(SALE_LINE_RE);
    if (saleMatch) {
      const [, docNoRaw, date, restRaw] = saleMatch;
      const rest = restRaw.trim().split(/\s+/).filter(Boolean);
      const qty = parseThaiNumber(rest[0]);
      const saleValue = parseThaiNumber(rest[1]);
      const cost = parseThaiNumber(rest[2]);
      const customerCode = rest[3] ?? "";

      // Scan for the repeated-quantity column (qty2). An inserted
      // annotation token between customer code and qty2 — e.g.
      // "ST57220  มิเตอร์ 53  2,000.00" — can itself contain a bare integer
      // ("53") that looks numeric; only a token with a decimal point is
      // trustworthy as the real quantity column (every real qty/value in
      // this report prints with 2 decimals). Anything non-decimal collected
      // along the way is surfaced as `meterAnnotation` instead of silently
      // misread as qty2.
      let qty2 = NaN;
      const annotationTokens: string[] = [];
      for (let j = 4; j < rest.length; j++) {
        if (isDecimalToken(rest[j])) {
          qty2 = parseThaiNumber(rest[j]);
          break;
        }
        annotationTokens.push(rest[j]);
      }
      // Only surface it as an annotation if it contains actual text (e.g.
      // "มิเตอร์ 53") — a lone bare integer with nothing else is more likely
      // stray column noise than a real annotation worth flagging.
      const meterAnnotation =
        annotationTokens.length > 0 && annotationTokens.some((t) => !isNumericToken(t))
          ? annotationTokens.join(" ")
          : null;

      if (!Number.isNaN(qty) && !Number.isNaN(saleValue) && customerCode) {
        const line: RawSalesLine = {
          docNo: normalizeDocNo(docNoRaw),
          baseDocNo: baseDocNo(docNoRaw),
          date,
          qty,
          qty2: Number.isNaN(qty2) ? qty : qty2,
          saleValue,
          cost: Number.isNaN(cost) ? 0 : cost,
          customerCode,
          productCode: currentProductCode,
          productName: currentProductName,
          customerNameRaw: currentCustomerNameRaw,
          meterAnnotation,
          sourceLineNo: i + 1,
        };
        result.lines.push(line);
        productBlockQty += qty;
        productBlockValue += saleValue;
        customerBlockQty += qty;
        customerBlockValue += saleValue;
        if (!Number.isNaN(qty2) && qty !== qty2) {
          warnings.push(`แถวที่ ${i + 1}: qty (${qty}) ไม่เท่ากับ qty2 (${qty2}) — เอกสาร ${line.docNo}`);
        }
      } else {
        warnings.push(`แถวที่ ${i + 1}: parse รายการขายไม่สำเร็จ (ข้าม): "${trimmed}"`);
      }
      continue;
    }

    const headerMatch = trimmed.match(CODE_SUFFIX_RE);
    if (headerMatch) {
      const hasNumericData = /\d+\.\d+/.test(trimmed) || /ลิตร/.test(trimmed);
      if (hasNumericData && /ลิตร/.test(trimmed)) {
        const { qty, value } = extractQtyAndValue(trimmed);
        result.productSubtotals.push({
          productCode: headerMatch[2].toUpperCase(),
          productName: headerMatch[1].trim(),
          qtyTotal: qty ?? 0,
          valueTotal: value ?? 0,
          qtyComputed: productBlockQty,
          valueComputed: productBlockValue,
          rawLine: trimmed,
        });
        productBlockQty = 0;
        productBlockValue = 0;
        continue;
      }
      if (!hasNumericData) {
        const code = headerMatch[2].toUpperCase();
        if (CUSTOMER_CODE_RE.test(code)) {
          currentCustomerNameRaw = headerMatch[1].trim();
        } else {
          currentProductCode = code;
          currentProductName = headerMatch[1].trim();
        }
        continue;
      }
    }
    // otherwise: unrecognized decorative/blank line — ignore silently.
  }

  if (!grandTotalSeen) {
    warnings.push("ไม่พบบรรทัด 'รวมทั้งสิ้น' — ตรวจสอบว่าไฟล์ครบทุกหน้าหรือไม่");
  }

  return result;
}
