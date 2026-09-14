import { createWorker, type Worker } from "tesseract.js";

/**
 * The master-file PDF's embedded text layer is genuinely corrupted for Thai
 * combining marks (tone marks, some vowels) — verified by rendering the page
 * to an image and comparing: the VISUAL glyphs are correct, but every text
 * extraction library (pdf-parse, pdfjs-dist's getTextContent, even Python's
 * PyMuPDF) reads the same broken embedded Unicode data, because the defect
 * is in the PDF's own font encoding table, not in how any of these tools
 * parse it. Customer names are display-only (never used for matching — that
 * always goes through the customer CODE, which this same text layer reads
 * correctly), so this is purely a readability problem, but a persistent one
 * across every sheet.
 *
 * Fix: render the page as an image and OCR just the name column, anchored
 * per-row on the customer CODE's own position (reliable, from the text
 * layer) rather than trying to fix the text extraction itself. This module
 * is intentionally scoped to the (small, single-page) distance/master file
 * only — OCR-ing every row of every multi-hundred-row sales report PDF
 * would be far too slow for a request/response API and far riskier (a
 * misread digit in a quantity or amount corrupts the actual commission
 * calculation, unlike a misread letter in a display-only name).
 *
 * This whole pass is wrapped in a hard timeout (see OCR_TIMEOUT_MS below).
 * A real Vercel deploy once hit an uncaught exception inside tesseract.js's
 * worker thread (a missing transitive dependency, "Cannot find module
 * 'bmp-js'" — since fixed by listing it in next.config.ts's
 * outputFileTracingIncludes) that never rejected its promise, hanging the
 * whole request until the PLATFORM's own timeout killed it 60 seconds
 * later. Since this feature is a display-only nice-to-have layered on top
 * of a pipeline that must otherwise respond quickly, any failure mode here
 * — known or not yet discovered — must fail fast and fall back to the
 * uncorrected name, never take the whole request down with it.
 */

const CUSTOMER_CODE_RE = /^[A-Za-z]{1,5}\d{4,}$|^\d{6,}$/;
const OCR_TIMEOUT_MS = 20_000;

export interface OcrNameResult {
  namesByCode: Map<string, string>;
  warnings: string[];
}

/**
 * Strip the OCR'd leading "<seq number>" token and stray table-border
 * artifacts (Tesseract sometimes reads a cell's left border line as "[", "|",
 * "!", or "(") that a plain page-segmentation-mode-7 (single text line) pass
 * picks up along with the real name text.
 */
function cleanOcrName(raw: string): string {
  return raw
    .replace(/\|/g, "")
    .replace(/\s+/g, " ")
    .trim()
    // Leading ลำดับ number + stray table-border-line misreads interleave
    // unpredictably ("(0  ![name", "5 [name", "10 name" have all been seen)
    // — strip any leading run mixing digits, whitespace, and this
    // punctuation set in one pass rather than two separate anchored
    // replacements (which only catch one pattern each and leave the other
    // stranded when they interleave).
    .replace(/^[\d\s[\](){}!.'"`~*_-]+/, "")
    .trim();
}

async function runOcrPass(buffer: Buffer, namesByCode: Map<string, string>): Promise<void> {
  // pdfjs-dist's renderer calls ctx.fill(path)/ctx.stroke(path) with a
  // Path2D object in a way that needs @napi-rs/canvas's node-canvas compat
  // shim (node-canvas.js, bundled inside the package) — the raw
  // Canvas/getContext API throws "Value is none of these types String,
  // Path" without it, and the plain `canvas` (node-canvas) package silently
  // renders every glyph as blank instead (table borders draw fine, all text
  // is empty) — both dead ends found the hard way.
  //
  // @napi-rs/canvas is pinned to EXACTLY 0.1.100 in package.json — newer
  // majors (verified against 1.0.9) changed something in the native
  // Path2D/fill implementation that breaks pdfjs-dist's rendering calls
  // outright, even through this same compat shim. Do not bump this
  // dependency without re-verifying OCR rendering still works.
  const { createRequire } = await import("module");
  const require = createRequire(import.meta.url);
  const { createCanvas } = require("@napi-rs/canvas/node-canvas.js") as {
    createCanvas: (w: number, h: number) => { getContext: (kind: "2d") => unknown; toBuffer: (mime: string) => Buffer };
  };

  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), stopAtErrors: false, isEvalSupported: false }).promise;

  let worker: Worker | null = null;
  try {
    // Vercel's deployed function directory is read-only — tesseract.js's
    // default cache location (CWD) would fail to write there. /tmp is the
    // one writable path serverless functions get; the Thai language data
    // (~1MB) downloads fresh on every cold start since /tmp doesn't persist
    // between invocations, but that's an acceptable tradeoff for a feature
    // scoped to one small file.
    worker = await createWorker("tha", undefined, { cachePath: "/tmp" });
    await worker.setParameters({ tessedit_pageseg_mode: "7" as never }); // PSM 7 = single text line

    const SCALE = 4; // ~288dpi — verified sharp enough for reliable Thai OCR at this table's font size
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: SCALE });
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      await page.render({ canvasContext: ctx, viewport }).promise;

      const content = await page.getTextContent();
      const codeItems = content.items.filter(
        (i): i is typeof i & { str: string; transform: number[]; height: number } => "str" in i && CUSTOMER_CODE_RE.test(i.str.trim())
      );

      for (const item of codeItems) {
        const code = item.str.trim().toUpperCase();
        if (namesByCode.has(code)) continue; // first occurrence wins, same convention as the text-layer parser
        const [vx, vy] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        const h = item.height * SCALE;
        // Left margin, past the ลำดับ column and clear of the table's own
        // cell border line — too close to that border and Tesseract
        // sometimes hallucinates a stray leading เ/[/( character from it.
        const cropX0 = 42 * SCALE;
        const cropX1 = Math.max(cropX0 + 10, vx - 15);
        const cropY0 = vy - h - 6;
        const cropY1 = vy + 10;
        const cropW = cropX1 - cropX0;
        const cropH = cropY1 - cropY0;
        if (cropW <= 0 || cropH <= 0) continue;

        const cropCanvas = createCanvas(cropW, cropH);
        const cropCtx = cropCanvas.getContext("2d") as CanvasRenderingContext2D;
        cropCtx.drawImage(canvas as unknown as CanvasImageSource, cropX0, cropY0, cropW, cropH, 0, 0, cropW, cropH);

        const { data } = await worker.recognize(cropCanvas.toBuffer("image/png"));
        const cleaned = cleanOcrName(data.text);
        if (cleaned) namesByCode.set(code, cleaned);
      }
    }
  } finally {
    if (worker) await worker.terminate().catch(() => {});
  }
}

export async function ocrCustomerNamesFromMasterPdf(buffer: Buffer): Promise<OcrNameResult> {
  const warnings: string[] = [];
  const namesByCode = new Map<string, string>();

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), OCR_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([runOcrPass(buffer, namesByCode).then(() => "done" as const), timeout]);
    if (result === "timeout") {
      warnings.push(`[OCR ชื่อลูกค้า] ใช้เวลาเกิน ${OCR_TIMEOUT_MS / 1000} วินาที — ข้ามการแก้ไขชื่อด้วย OCR รอบนี้ (ใช้ชื่อจากไฟล์ตามปกติแทน)`);
    }
  } catch (err) {
    warnings.push(`[OCR ชื่อลูกค้า] เกิดข้อผิดพลาดระหว่าง OCR — ใช้ชื่อจากไฟล์ตามปกติแทน (${err instanceof Error ? err.message : String(err)})`);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  return { namesByCode, warnings };
}
