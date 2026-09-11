import type { ParsedDistanceMaster, DistanceMasterRow } from "./types";

/**
 * Parses the "ระยะทาง และ พนักงานขาย" master file (customer code -> distance
 * km + assigned salesperson + product + optional freight tag).
 *
 * The real file (สาขาสามทอง, ส.ค. 2569) is a narrow multi-column PDF table.
 * `pdf-parse` extracts it with almost ZERO separating whitespace between
 * columns within a visual row (e.g. "1ไร่แสงตะวันKCL660030อ.กุฉินารายณ์84
 * DSจุ่น1สาย1สู้2จ่าตุ่นST51205...") and no reliable line breaks between
 * records. A one-row-per-line scanner cannot work on this file at all.
 *
 * Fix (same strategy the marketing-commission-calc SKILL's prior branch used
 * for its own master file): join everything into one text stream and anchor
 * purely on customer-CODE matches — never on Thai text position, which is
 * exactly the kind of match this codebase avoids everywhere else too. The
 * segment of text between one code and the next contains that customer's
 * area + distance + product + salesperson + optional tag in a fixed order,
 * regardless of missing whitespace.
 *
 * Within a segment the fixed order is: [area text] [distance-or-"-"]
 * [product code, e.g. DS/G91/G95] [salesperson name] [optional tag]. The
 * distance+product pair is matched together (a bare number could otherwise
 * be confused with area/index text); the salesperson is matched against the
 * branch's own roster (config-driven, never guessed) rather than a generic
 * "any Thai text" pattern, because that's the only way to tell the
 * salesperson name apart from the NEXT record's leading index+name that
 * inevitably gets glued on with no separator.
 *
 * A garbled-font quirk specific to this PDF's embedded font consistently
 * renders สาย (SARA AA, า) as สำย (SARA AM, ำ) in extracted text — verified
 * against the real file, where it affects every า in the document, not just
 * the tag. Rather than chase every possible Thai vowel substitution, tag
 * detection below uses a script-independent signal instead: the "1สาย1สู้"
 * tag is the only thing that can follow a salesperson name with ZERO
 * separating whitespace before hitting a digit ("...จุ่น1สาย1สู้..." — no
 * space before the leading "1"), whereas the next record's index number
 * always has a real space before it ("...จุ่น 10นงลักษณ์..."). So: if a
 * digit immediately (0 chars) follows the matched salesperson name, treat it
 * as the "1สาย1สู้" tag — no Thai text comparison needed at all.
 */

// Customer codes here are either letters+digits (KCL660030, ST51205) or, in
// at least one real row, purely numeric (3031045) — unlike the sales-report
// parser's customer codes, which are always letter-prefixed.
//
// The leading boundary for the letter-prefixed form is a negative lookbehind
// for a LATIN LETTER only, not a digit — a real row's address/name text can
// end in a digit glued directly onto the next code with zero separating
// whitespace (e.g. "...ทางหลวงที่ 8ST579612อ.เมือง..." — no space before
// "ST579612"). Rejecting on a preceding digit too silently drops that whole
// customer (found missing from the parsed output with no warning, tracked
// down by diffing the parsed row count against the source PDF's own 1-31
// index numbers). The pure-numeric form keeps the stricter digit+letter
// lookbehind since without a letter prefix, a stray run of 6+ digits needs
// more protection against accidentally matching inside an unrelated number.
const CUSTOMER_CODE_RE = /(?<![A-Za-z])([A-Za-z]{1,5}\d{4,})(?![A-Za-z0-9])|(?<![A-Za-z0-9])(\d{6,})(?![A-Za-z0-9])/g;
const DISTANCE_PRODUCT_RE = /(\d+(?:\.\d+)?|-)\s*([A-Z][A-Z0-9]{1,4})/;
const HEADER_NOISE_RE = /ระยะทาง|เซลล์|ลำดับ|ชื่อลูกค้า|รหัส|พื้นที่|กม\.?|สินค้า/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseDistanceMasterText(text: string, salespersonRoster: string[]): ParsedDistanceMaster {
  const warnings: string[] = [];
  const rows: DistanceMasterRow[] = [];

  if (salespersonRoster.length === 0) {
    warnings.push("ไม่มีรายชื่อเซลล์ของสาขานี้ใน config — ไม่สามารถแยกชื่อเซลล์ออกจากข้อความอื่นในไฟล์ master ได้");
    return { rows, warnings };
  }
  const rosterRe = new RegExp(salespersonRoster.map(escapeRegExp).join("|"));

  const fullText = text.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ");
  const codeMatches = [...fullText.matchAll(CUSTOMER_CODE_RE)];

  let cursor = 0;
  for (let i = 0; i < codeMatches.length; i++) {
    const match = codeMatches[i];
    const customerCode = (match[1] ?? match[2]).toUpperCase();
    const codeStart = match.index!;
    const codeEnd = codeStart + match[0].length;
    const segmentEnd = i + 1 < codeMatches.length ? codeMatches[i + 1].index! : fullText.length;
    const segment = fullText.slice(codeEnd, segmentEnd);

    const nameGuess = fullText
      .slice(cursor, codeStart)
      .replace(HEADER_NOISE_RE, " ")
      .replace(/^\s*\d+\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    cursor = segmentEnd;

    const dp = segment.match(DISTANCE_PRODUCT_RE);
    if (!dp) {
      warnings.push(`ลูกค้า ${customerCode}: ไม่พบคอลัมน์ระยะทาง/สินค้า — ตรวจสอบไฟล์ master ต้นฉบับ`);
      rows.push({ customerCode, customerName: nameGuess || customerCode, productCode: null, distanceKm: null, salesperson: null, tag: "" });
      continue;
    }
    const distanceKm = dp[1] === "-" ? null : parseFloat(dp[1]);
    const productCode = dp[2];
    const afterDp = segment.slice(dp.index! + dp[0].length);

    const sm = afterDp.match(rosterRe);
    let salesperson: string | null = null;
    let tag: DistanceMasterRow["tag"] = "";
    if (sm) {
      salesperson = sm[0];
      const afterSalesperson = afterDp.slice(sm.index! + sm[0].length);
      if (/^\d/.test(afterSalesperson)) tag = "1สาย1สู้";
    } else {
      warnings.push(`ลูกค้า ${customerCode}: ไม่พบชื่อเซลล์ที่ตรงกับ roster ในไฟล์ master — ตรวจสอบด้วยมือ`);
    }
    if (distanceKm === null && !tag) tag = "ทางผ่าน";

    rows.push({ customerCode, customerName: nameGuess || customerCode, productCode, distanceKm, salesperson, tag });
  }

  if (rows.length === 0) {
    warnings.push("ไม่พบรหัสลูกค้าในไฟล์ master เลย — ตรวจรูปแบบไฟล์ก่อนใช้ผลลัพธ์");
  }

  return { rows, warnings };
}
