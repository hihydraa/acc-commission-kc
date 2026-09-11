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
 * [product code, e.g. DS/G91/G95 — สามทอง's file has this column, กระนวน's
 * does NOT] [salesperson name] [optional tag]. Rather than require a product
 * code (which would break on a branch whose master file omits that column
 * entirely — confirmed against กระนวน's real file), the salesperson is
 * matched first, against the branch's own roster (config-driven, never
 * guessed — this is also the only way to tell the salesperson name apart
 * from the NEXT record's leading index+name that inevitably gets glued on
 * with no separator), and the distance is then read as the LAST bare
 * number/"-" token appearing before that match — a product code token like
 * "G91" never satisfies a whitespace-bounded all-digit match, so it's
 * naturally skipped over whether or not it's present.
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
// A distance token must not be preceded by a Latin letter/digit (never
// matches the "91" inside a glued-on "G91", or a code's own trailing
// digits) — but IS commonly glued directly onto Thai area text with zero
// whitespace on either side (both branches' files do this — e.g. สามทอง's
// "กุฉินารายณ์84 DS" and กระนวน's "เขาสวนกวาง13       อ้อม" both have no
// space before the number), so a Thai character or start-of-segment is a
// valid left boundary. The right side may likewise run directly into a
// following letter with no space (สามทอง's "84DS"-style zero-gap product
// code column, which กระนวน's file doesn't have at all).
const DISTANCE_TOKEN_RE = /(?<![A-Za-z0-9.])(-|\d+(?:\.\d+)?)(?=\s|[A-Za-z]|$)/g;
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

  // The customer's own display NAME actually appears BEFORE their code
  // (order per record: [seq][name][code][area][distance][product]
  // [salesperson][tag]), glued directly onto the TAIL of the PREVIOUS
  // record's segment with no separator. So `pendingNameStart` — the
  // boundary carried from one iteration to the next — must point at the
  // position right after the previous record's own salesperson+tag match,
  // not at that previous record's segment end (which is the same position
  // as the current code's start, collapsing the name-search window to zero
  // width — this is display-only text, so a rough boundary here is fine,
  // it doesn't need to be pixel-perfect).
  let pendingNameStart = 0;
  for (let i = 0; i < codeMatches.length; i++) {
    const match = codeMatches[i];
    const customerCode = (match[1] ?? match[2]).toUpperCase();
    const codeStart = match.index!;
    const codeEnd = codeStart + match[0].length;
    const segmentEnd = i + 1 < codeMatches.length ? codeMatches[i + 1].index! : fullText.length;
    const segment = fullText.slice(codeEnd, segmentEnd);

    const nameGuess = fullText
      .slice(pendingNameStart, codeStart)
      .replace(HEADER_NOISE_RE, " ")
      .replace(/^\s*\d+\s*/, "")
      .replace(/\s+/g, " ")
      .trim();

    const sm = segment.match(rosterRe);
    if (!sm) {
      warnings.push(`ลูกค้า ${customerCode}: ไม่พบชื่อเซลล์ที่ตรงกับ roster ในไฟล์ master — ตรวจสอบด้วยมือ`);
      rows.push({ customerCode, customerName: nameGuess || customerCode, productCode: null, distanceKm: null, salesperson: null, tag: "" });
      pendingNameStart = segmentEnd;
      continue;
    }
    const salesperson = sm[0];
    const beforeSalesperson = segment.slice(0, sm.index!);
    const distanceTokens = [...beforeSalesperson.matchAll(DISTANCE_TOKEN_RE)];
    const lastDistanceToken = distanceTokens.length > 0 ? distanceTokens[distanceTokens.length - 1][1] : null;
    if (!lastDistanceToken) {
      warnings.push(`ลูกค้า ${customerCode}: ไม่พบคอลัมน์ระยะทาง — ตรวจสอบไฟล์ master ต้นฉบับ`);
    }
    const distanceKm = lastDistanceToken === null || lastDistanceToken === "-" ? null : parseFloat(lastDistanceToken);

    const afterSalespersonStart = codeEnd + sm.index! + sm[0].length;
    const afterSalesperson = fullText.slice(afterSalespersonStart, segmentEnd);
    let tag: DistanceMasterRow["tag"] = "";
    // "1สาย1สู้" glued directly onto the salesperson name (no space) — its
    // own vowels are subject to the same font-corruption risk as the SKILL
    // check above, so match loosely by shape (digit + short Thai run,
    // twice) rather than the literal string, and consume it here so it
    // doesn't bleed into the next record's name guess.
    const tagMatch = afterSalesperson.match(/^\d\s*[ก-๙](?:\s?[ก-๙]){0,3}\s*\d\s*[ก-๙](?:\s?[ก-๙]){0,3}/);
    if (tagMatch) {
      tag = "1สาย1สู้";
      pendingNameStart = afterSalespersonStart + tagMatch[0].length;
    } else {
      pendingNameStart = afterSalespersonStart;
    }
    if (distanceKm === null && !tag) tag = "ทางผ่าน";

    rows.push({ customerCode, customerName: nameGuess || customerCode, productCode: null, distanceKm, salesperson, tag });
  }

  if (rows.length === 0) {
    warnings.push("ไม่พบรหัสลูกค้าในไฟล์ master เลย — ตรวจรูปแบบไฟล์ก่อนใช้ผลลัพธ์");
  }

  return { rows, warnings };
}
