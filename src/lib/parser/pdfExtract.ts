/**
 * Server-only PDF -> text extraction. Kept separate from the line parsers so
 * those stay pure-string-in/JSON-out and unit-testable without a real PDF
 * binary.
 *
 * `pdf-parse` (pinned to 1.1.1 — v2 changed its whole API) is the primary
 * extractor: pure-JS, no poppler/pdftotext binary dependency, so it's safe
 * to run in a Vercel serverless function. It bundles an older pdf.js with
 * weaker error recovery, though, so a malformed-but-common PDF structural
 * issue (e.g. a bad XRef entry) can throw — fall back to pdfjs-dist directly
 * (`stopAtErrors: false`) in that case.
 *
 * Verified directly against real เบอร์55/65/69/71/เทรลเลอร์73/74/AR/master
 * PDFs (สาขาสามทอง, ส.ค. 2569): pdf-parse renders Thai text correctly and
 * preserves the column spacing the line parsers below key off of — unlike
 * `pdftotext -layout` (poppler), which was tried first and silently dropped
 * most Thai glyphs on these particular files.
 */
import pdfParse from "pdf-parse";

export async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const result = await pdfParse(buffer);
    return result.text;
  } catch (primaryErr) {
    try {
      return await extractPdfTextWithPdfjs(buffer);
    } catch (fallbackErr) {
      const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw new Error(`อ่าน PDF ไม่สำเร็จทั้ง 2 วิธี — pdf-parse: ${primaryMsg} | pdfjs-dist: ${fallbackMsg}`);
    }
  }
}

async function extractPdfTextWithPdfjs(buffer: Buffer): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    stopAtErrors: false,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;

  const pageTexts: string[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    // disableNormalization preserves original inter-word spacing, which the
    // whitespace-based column parsers below depend on.
    const content = await page.getTextContent({ disableNormalization: true });
    let lastY: number | undefined;
    let pageText = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const y = item.transform[5];
      if (lastY === undefined || lastY === y) {
        pageText += item.str;
      } else {
        pageText += "\n" + item.str;
      }
      lastY = y;
    }
    pageTexts.push(pageText);
  }
  return pageTexts.join("\n\n");
}
