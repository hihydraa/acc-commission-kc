/**
 * The sales-report PDFs' embedded font (a CID-keyed subset, CIDFont+F1)
 * genuinely maps several Thai tone marks/vowel signs to Private Use Area
 * (U+E000-U+F8FF) codepoints in its own ToUnicode CMap — verified by
 * decompressing the font's CMap stream directly out of the raw PDF bytes,
 * not inferred from OCR or any text-extraction library's behavior: the
 * defect is baked into the file itself, before pdf-parse/pdfjs-dist ever
 * touch it. The font appears to carry several duplicate glyphs for the same
 * mark (different contextual/positional variants — Thai tone marks render
 * differently depending on the base consonant's shape), and whatever
 * generated this PDF's CMap only bothered to give ONE variant of each mark
 * its real Unicode codepoint, leaving the rest as arbitrary PUA filler.
 *
 * The mapping below was built empirically: align this file's own raw
 * customer-header text against the SAME customer's name as read by the
 * master-file OCR pass (ocrNames.ts, itself independently reliable — see
 * that file), across every sales file for a real branch/month, then take
 * the position where OCR's text has a combining mark that raw text is
 * missing and see what PUA codepoint sits there instead. Cross-checked
 * against product names this codebase already hardcodes the correct
 * spelling for (PRODUCT_NAME_BY_CODE in excelExport.ts — "แก๊สโซฮอล์" needs
 * exactly the two marks this map assigns U+F70C and U+F70E/U+F709) and
 * against the report's own repeated column-header text (e.g. "เป็นของแถม?"
 * pins U+F712). Every mapped codepoint was confirmed on at least 2
 * independent, unrelated occurrences, and the fixed-up text matched (or in
 * several cases, corrected an actual misread in) the OCR ground truth on a
 * full real branch/month's worth of names.
 *
 * NOT the master (distance/เซลล์) file's own corruption — verified that file
 * has zero PUA codepoints in its extracted text at all; its defect is a
 * different, unrelated one (a spurious extra NIKHAHIT/ำ-like substitution),
 * already handled by ocrNames.ts's OCR pass. Do not apply this fix there.
 */

// Written as \uXXXX escapes deliberately, not literal characters — several
// of these are zero-width/combining codepoints that don't round-trip
// reliably as bare object-literal keys through every tool in this pipeline.
const PUA_MAP: Readonly<Record<string, string>> = {
  "": "ิ", // -> SARA I (i)
  "": "์", // -> THANTHAKHAT, duplicate glyph of U+F70E
  "": "่", // -> MAI EK
  "": "้", // -> MAI THO
  "": "๊", // -> MAI TRI
  "": "์", // -> THANTHAKHAT
  "": "ั", // -> MAI HAN-AKAT
  "": "็", // -> MAITAICHU
  "": "๊", // -> MAI TRI, duplicate glyph of U+F70C
  "": "๊", // -> MAI TRI, duplicate glyph of U+F70C
};

const PUA_RANGE_RE = /[\u{E000}-\u{F8FF}]/gu;

export interface FixThaiTextResult {
  fixed: string;
  /** codepoints (e.g. "U+F707") this run encountered but has no confirmed
   *  mapping for — left untouched in `fixed` rather than guessed at, so a
   *  caller can log them for manual review instead of silently shipping a
   *  wrong character (see module doc: every mapped codepoint here was
   *  confirmed on real, independent examples first, not guessed). */
  unresolved: Set<string>;
}

export function fixThaiText(text: string): FixThaiTextResult {
  const unresolved = new Set<string>();
  const fixed = text.replace(PUA_RANGE_RE, (ch) => {
    const mapped = PUA_MAP[ch];
    if (mapped) return mapped;
    unresolved.add(`U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`);
    return ch;
  });
  return { fixed, unresolved };
}
