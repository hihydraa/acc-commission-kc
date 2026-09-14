import Anthropic from "@anthropic-ai/sdk";

/**
 * Every PDF this pipeline reads (master, and every per-truck sales report)
 * shares the same defect: the embedded text layer is genuinely corrupted for
 * Thai combining marks (tone marks, some vowels) — verified by rendering the
 * page to an image and comparing: the VISUAL glyphs are correct, but every
 * text-extraction library reads the same broken embedded Unicode data,
 * because the defect is in the PDF's own font encoding table, not in how any
 * of these tools parse it. Customer names are display-only (never used for
 * matching — that always goes through the customer CODE, which this same
 * text layer reads correctly), so this is purely a readability problem.
 *
 * Two earlier designs were tried and rejected on real production runs (both
 * against เบอร์71_ST_8.69.pdf / AR_ST_7.9.69.pdf) before this one:
 *  1. Tesseract OCR on a pixel crop — read the master file's clean table
 *     fine, but measurably WORSENED many names on the sales-report font
 *     ("คุณแมสุป" -> "คุณเม่สปี") across several crop/scale/margin attempts.
 *  2. Claude reading whole rendered PAGE images, several per request, with
 *     the codes list appended once at the end — the model blended unrelated
 *     customers together (codes came back with fabricated, phonetically
 *     unrelated names, and several different codes shared identical
 *     invented surnames). Labeling each full-page image with its own
 *     expected codes did NOT fix this on a second production run — a full
 *     page still has many OTHER visible names crowded around the requested
 *     one, which is apparently enough ambiguity for the model to pattern-
 *     match onto the wrong one instead of admitting it can't read a small
 *     specific detail confidently.
 *
 * This version crops a small, tight image around ONLY the printed name next
 * to ONE customer code (anchored on the code's own text position — reliable,
 * since only the Thai combining marks are corrupted, never the ASCII code).
 * One crop can physically only contain one customer's name, which removes
 * the cross-customer ambiguity that broke both earlier designs — the model
 * can still misread a genuinely illegible crop, but it cannot blend it with
 * a DIFFERENT customer's name the way it could pick the wrong name off a
 * busy full page.
 *
 * Cost control ("ใช้ API ให้ประหยัด"): crops are tiny, so many of them (not
 * just a few full pages) are packed into one request; a page is only ever
 * rendered once no matter how many of its customers still need a crop, and
 * a code already resolved (anywhere) is never requested again.
 */

const MODEL = "claude-haiku-4-5-20251001";
// Rendering a crop still means rasterizing the WHOLE page first (pdfjs has
// no partial-region render) — a production run with ~80 customers spread
// across a 41-page report meant ~80 separate full-page rasters at scale 4
// with nothing capping the time spent, which is exactly what took the whole
// request past Vercel's function limit (confirmed: the deployed endpoint
// started returning the platform's own generic 500 instead of this
// pipeline's own JSON error, meaning the function was killed before it
// could respond at all). Scale 2 cuts that raster cost ~4x; the real fix is
// the `deadline` check in the page loops below, which this alone doesn't
// replace.
const CROP_SCALE = 2;
const CROPS_PER_REQUEST = 20;
const REQUEST_CONCURRENCY = 3;
// Overall wall-clock budget for every Claude call in one pipeline run —
// leaves headroom under the API route's own maxDuration for PDF parsing,
// the commission calculation itself, and building the Excel workbook, all
// of which still happen after this returns.
const TOTAL_BUDGET_MS = 42_000;

const MASTER_CODE_RE = /^[A-Za-z]{1,5}\d{4,}$|^\d{6,}$/;
const SALES_CUSTOMER_CODE_RE = /^[A-Za-z]{1,5}\d{4,}$/;
const HEADER_LINE_RE = /^(.+?)\s*\/\s*(\S+)\s*$/;

type PdfTextItem = { str: string; transform: number[]; width: number; height: number };
type PdfDoc = import("pdfjs-dist/legacy/build/pdf.mjs").PDFDocumentProxy;
type CanvasFactory = (w: number, h: number) => { getContext: (kind: "2d") => unknown; toBuffer: (mime: string) => Buffer };

export interface ClaudeNameResult {
  namesByCode: Map<string, string>;
  warnings: string[];
}

interface CropTarget {
  code: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface CropJob {
  code: string;
  png: Buffer;
}

async function loadCanvasFactory(): Promise<CanvasFactory> {
  // pdfjs-dist's renderer needs @napi-rs/canvas's node-canvas compat shim
  // specifically (node-canvas.js) — the raw Canvas API throws a Path2D type
  // error without it, and the plain `canvas` package silently renders every
  // glyph as blank instead. Pinned to exactly 0.1.100 in package.json —
  // newer majors change something in the native Path2D/fill implementation
  // that breaks pdfjs-dist's rendering calls even through this same shim.
  const { createRequire } = await import("module");
  const require = createRequire(import.meta.url);
  const { createCanvas } = require("@napi-rs/canvas/node-canvas.js") as { createCanvas: CanvasFactory };
  return createCanvas;
}

/**
 * Scans every page of `buffer` (text-content only — cheap, no rendering) for
 * still-needed codes from `remaining`, computing each one's crop region
 * directly from its text item's own position. Claims a code the moment its
 * region is found (mutates `remaining`) so a later file never redoes the
 * work. `isMaster` picks the layout rule:
 *  - master (distance/เซลล์) file: a real table, the code is its own text
 *    item — crop the name column immediately to its left.
 *  - a sales-report file: an inline "<name> /<code>" header line, where the
 *    code is sometimes its own text item and sometimes glued to the name in
 *    one item (verified against real files — no single assumption holds) —
 *    crop the WHOLE line's bounding box instead of trying to isolate a
 *    token. Line pitch here is much tighter than the master table's, so the
 *    vertical margin is kept small to avoid bleeding into the row above/
 *    below (verified: a generous margin picks up the previous row's text).
 */
async function collectCropTargets(
  buffer: Buffer,
  remaining: Set<string>,
  isMaster: boolean,
  deadline: number
): Promise<{ doc: PdfDoc; targetsByPage: Map<number, CropTarget[]>; timedOut: boolean }> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), stopAtErrors: false, isEvalSupported: false }).promise;
  const targetsByPage = new Map<number, CropTarget[]>();
  if (remaining.size === 0) return { doc, targetsByPage, timedOut: false };

  for (let pageNum = 1; pageNum <= doc.numPages && remaining.size > 0; pageNum++) {
    if (Date.now() > deadline) return { doc, targetsByPage, timedOut: true };
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: CROP_SCALE });
    const content = await page.getTextContent({ disableNormalization: true });
    const items = content.items.filter((i) => "str" in i && "transform" in i) as unknown as PdfTextItem[];
    const targets: CropTarget[] = [];

    if (isMaster) {
      for (const item of items) {
        const code = item.str.trim().toUpperCase();
        if (!MASTER_CODE_RE.test(code) || !remaining.has(code)) continue;
        remaining.delete(code);
        const [vx, vy] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        const h = item.height * CROP_SCALE;
        const x0 = 42 * CROP_SCALE; // past the ลำดับ column and the table's own left border
        const x1 = Math.max(x0 + 10, vx - 15); // stop just left of the code token
        targets.push({ code, x0, y0: vy - h - 6, x1, y1: vy + 10 });
      }
    } else {
      const lines = new Map<number, PdfTextItem[]>();
      for (const it of items) {
        const y = Math.round(it.transform[5]);
        const arr = lines.get(y) ?? [];
        arr.push(it);
        lines.set(y, arr);
      }
      for (const rowItems of lines.values()) {
        const sorted = [...rowItems].sort((a, b) => a.transform[4] - b.transform[4]);
        const trimmed = sorted.map((i) => i.str).join("").trim();
        if (!trimmed || /\d+\.\d+/.test(trimmed) || trimmed.includes("ลิตร")) continue; // data/subtotal line, not a header
        const m = trimmed.match(HEADER_LINE_RE);
        if (!m) continue;
        const code = m[2].toUpperCase();
        if (!SALES_CUSTOMER_CODE_RE.test(code) || !remaining.has(code)) continue;
        remaining.delete(code);

        const nonSpace = sorted.filter((i) => i.str.trim() !== "");
        if (nonSpace.length === 0) continue;
        const minXpdf = Math.min(...nonSpace.map((i) => i.transform[4]));
        const maxXpdf = Math.max(...nonSpace.map((i) => i.transform[4] + (i.width || 0)));
        const yPdf = sorted[0].transform[5];
        const hPdf = Math.max(...nonSpace.map((i) => i.height || 12));
        const [vx0, vy] = viewport.convertToViewportPoint(minXpdf, yPdf);
        const [vx1] = viewport.convertToViewportPoint(maxXpdf, yPdf);
        const h = hPdf * CROP_SCALE;
        const marginX = 3 * CROP_SCALE;
        targets.push({ code, x0: Math.max(0, vx0 - marginX), y0: vy - h - 2, x1: vx1 + marginX, y1: vy + 3 });
      }
    }
    if (targets.length > 0) targetsByPage.set(pageNum, targets);
  }
  return { doc, targetsByPage, timedOut: false };
}

/** Renders `pageNum` once and cuts every one of its crop targets out of
 *  that single render — a page with 15 needed customers costs one render,
 *  not 15. */
async function renderCrops(doc: PdfDoc, pageNum: number, targets: CropTarget[], createCanvas: CanvasFactory): Promise<CropJob[]> {
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale: CROP_SCALE });
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  await page.render({ canvasContext: ctx, viewport }).promise;

  const jobs: CropJob[] = [];
  for (const t of targets) {
    const w = t.x1 - t.x0;
    const h = t.y1 - t.y0;
    if (w <= 0 || h <= 0) continue;
    const cropCanvas = createCanvas(w, h);
    const cropCtx = cropCanvas.getContext("2d") as CanvasRenderingContext2D;
    cropCtx.drawImage(canvas as unknown as CanvasImageSource, t.x0, t.y0, w, h, 0, 0, w, h);
    jobs.push({ code: t.code, png: cropCanvas.toBuffer("image/png") });
  }
  return jobs;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object found in response");
  return JSON.parse(body.slice(start, end + 1));
}

async function callClaudeForCrops(client: Anthropic, crops: CropJob[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (crops.length === 0) return result;

  // Each image is a tight crop containing exactly ONE customer's printed
  // name — physically impossible to blend with another customer's, unlike
  // the whole-page-image design this replaced (see module doc).
  const content: Anthropic.ContentBlockParam[] = [];
  crops.forEach((c, i) => {
    content.push({ type: "text", text: `Image ${i + 1} = customer code ${c.code}` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: c.png.toString("base64") } });
  });
  content.push({
    type: "text",
    text:
      `Each image above is a tight crop from a Thai PDF report, showing ONLY the customer name printed for the one customer code labeled just before it (the code itself may or may not be visible in the crop — ignore it either way, you already have it from the label). Read the EXACT Thai name in each crop, including every tone mark and vowel exactly as shown (the source PDF's own embedded text is corrupted for these — read the visible glyphs, not any text you might otherwise infer).\n\n` +
      `If a crop is blank, cut off, or genuinely illegible, omit that code rather than guessing.\n\n` +
      `Respond with ONLY a JSON object mapping each code to its exact Thai name, e.g. {"KCL660012":"ปั๊ม นิมิตรบริการ"}. No other text.`,
  });

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: Math.min(4096, 200 + crops.length * 40),
    messages: [{ role: "user", content }],
  });

  const textBlock = msg.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return result;
  const parsed = extractJson(textBlock.text);
  if (parsed && typeof parsed === "object") {
    for (const [code, name] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof name === "string" && name.trim()) result.set(code.toUpperCase(), name.trim());
    }
  }
  return result;
}

export interface ResolveCustomerNamesInput {
  masterFile: Buffer | null;
  salesFiles: { filename: string; buffer: Buffer }[];
  /** every customer code that will actually be displayed somewhere in the
   *  output — resolving anything outside this set would just burn API
   *  budget on names nobody sees (e.g. a customer who only shows up in the
   *  AR report — that report's own names are never displayed anywhere,
   *  only its document numbers/amounts are, so it's not scanned here). */
  targetCodes: Set<string>;
}

export async function resolveCustomerNamesViaClaude({ masterFile, salesFiles, targetCodes }: ResolveCustomerNamesInput): Promise<ClaudeNameResult> {
  const warnings: string[] = [];
  const namesByCode = new Map<string, string>();
  if (targetCodes.size === 0) return { namesByCode, warnings };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    warnings.push("[แก้ชื่อภาษาไทยด้วย Claude] ไม่ได้ตั้งค่า ANTHROPIC_API_KEY — ข้ามการแก้ชื่อรอบนี้ทั้งหมด ใช้ชื่อจากไฟล์ตามปกติแทน");
    return { namesByCode, warnings };
  }
  const client = new Anthropic({ apiKey });
  const createCanvas = await loadCanvasFactory();

  // ONE deadline for the whole function, not one per phase — rendering a
  // crop still means rasterizing its entire page first (pdfjs has no
  // partial-region render), so with a customer spread thinly across a
  // multi-hundred-page report, the RENDER phase can be just as expensive as
  // the API-call phase. A budget that only covered the API phase let a real
  // production run render ~80 separate full pages with nothing capping the
  // time spent, which ran the whole request past Vercel's own function
  // limit and killed it before this module's own graceful-fallback warnings
  // could ever be returned.
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let renderTimedOut = false;

  const remaining = new Set(targetCodes);
  const cropJobs: CropJob[] = [];

  async function collect(buffer: Buffer, source: string, isMaster: boolean) {
    if (remaining.size === 0 || Date.now() > deadline) return;
    try {
      const { doc, targetsByPage, timedOut } = await collectCropTargets(buffer, remaining, isMaster, deadline);
      if (timedOut) renderTimedOut = true;
      for (const [pageNum, targets] of targetsByPage) {
        if (Date.now() > deadline) {
          renderTimedOut = true;
          break;
        }
        cropJobs.push(...(await renderCrops(doc, pageNum, targets, createCanvas)));
      }
    } catch (err) {
      warnings.push(`[แก้ชื่อภาษาไทยด้วย Claude] อ่านไฟล์ '${source}' ไม่สำเร็จ — ใช้ชื่อจากไฟล์ตามปกติแทน (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  if (masterFile) await collect(masterFile, "master", true);
  for (const f of salesFiles) await collect(f.buffer, f.filename, false);

  if (cropJobs.length === 0) {
    if (renderTimedOut) {
      warnings.push(`[แก้ชื่อภาษาไทยด้วย Claude] อ่าน/แปลงหน้า PDF ใช้เวลาเกิน ${TOTAL_BUDGET_MS / 1000} วินาที ก่อนจะเริ่มแก้ชื่อได้แม้แต่รายการเดียว — ใช้ชื่อจากไฟล์ตามปกติทั้งหมด`);
    }
    return { namesByCode, warnings };
  }

  const batches: CropJob[][] = [];
  for (let i = 0; i < cropJobs.length; i += CROPS_PER_REQUEST) batches.push(cropJobs.slice(i, i + CROPS_PER_REQUEST));

  let timedOut = renderTimedOut;
  let nextBatch = 0;
  let apiErrors = 0;

  async function runner() {
    while (nextBatch < batches.length) {
      if (Date.now() > deadline) {
        timedOut = true;
        return;
      }
      const batch = batches[nextBatch++];
      try {
        const expectedCodes = new Set(batch.map((c) => c.code));
        const found = await callClaudeForCrops(client, batch);
        for (const [code, name] of found) {
          // Defense in depth against a malformed response: never accept a
          // code this batch didn't actually ask about.
          if (expectedCodes.has(code)) namesByCode.set(code, name);
        }
      } catch {
        apiErrors++;
        // one bad batch (network hiccup, rate limit, malformed response)
        // must never take the rest of the run down with it — those codes
        // just keep their existing (uncorrected) name.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(REQUEST_CONCURRENCY, batches.length) }, () => runner()));

  if (timedOut) {
    warnings.push(`[แก้ชื่อภาษาไทยด้วย Claude] ใช้เวลาเกิน ${TOTAL_BUDGET_MS / 1000} วินาที — แก้ชื่อได้ ${namesByCode.size} รายการ ที่เหลือใช้ชื่อจากไฟล์ตามปกติแทน`);
  }
  if (apiErrors > 0) {
    warnings.push(`[แก้ชื่อภาษาไทยด้วย Claude] เรียก API ไม่สำเร็จ ${apiErrors} ครั้ง (จากทั้งหมด ${batches.length} รอบ) — รายการในรอบที่พลาดใช้ชื่อจากไฟล์ตามปกติแทน`);
  }

  return { namesByCode, warnings };
}
