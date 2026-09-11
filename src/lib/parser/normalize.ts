/**
 * Text normalization helpers for parsing PDF-extracted reports.
 *
 * Real exports from this accounting system (`pdftotext`/pdf.js-based
 * extraction) can drop Thai combining vowel/tone marks or inject a Private
 * Use Area (PUA, U+E000-U+F8FF) glyph mid-word after a page break — see
 * marketing-commission-calc SKILL.md "Known parsing gotchas". Document
 * numbers can also carry a stray space before the "-N" line-item suffix
 * (e.g. "ID6505601- 1").
 *
 * Rule: never match on raw Thai customer/salesperson names for anything
 * that drives a number — always match on customer_code or a config-driven
 * roster. Thai section-heading matches (e.g. skip markers) go through
 * `normalizeThai` first so a dropped tone mark doesn't break the match.
 */

const PUA_RANGE = /[\u{E000}-\u{F8FF}]/gu;
const THAI_COMBINING_MARKS = /[ัิ-ฺ็-๎]/g;

export function normalizeThai(s: string): string {
  return s.replace(PUA_RANGE, "").replace(THAI_COMBINING_MARKS, "");
}

export function normalizeDocNo(s: string): string {
  return s.replace(/\s+/g, "").toUpperCase();
}

/** Strip the trailing "-<line item number>" suffix, e.g. IDB126080098-1 -> IDB126080098 */
export function baseDocNo(s: string): string {
  return normalizeDocNo(s).replace(/-\d+$/, "");
}

export function parseThaiNumber(token: string | undefined | null): number {
  if (!token) return NaN;
  return parseFloat(token.replace(/,/g, ""));
}

export function isDecimalToken(token: string): boolean {
  return /^-?[\d,]+\.\d+$/.test(token);
}
