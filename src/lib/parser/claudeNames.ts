import Anthropic from "@anthropic-ai/sdk";
import { PDFDocument } from "pdf-lib";

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
 * Three earlier designs were tried and rejected on real production runs
 * (against เบอร์71_ST_8.69.pdf / AR_ST_7.9.69.pdf) before this one:
 *  1. Tesseract OCR on a pixel crop — worked on the master file's clean
 *     table, but measurably WORSENED many names on the sales-report font.
 *  2. Claude reading whole rendered PAGE images, several per request — the
 *     model blended unrelated customers together even when each image was
 *     labeled with its own expected codes.
 *  3. Claude reading a TIGHT PIXEL CROP around one customer's name (one
 *     crop = one customer, so cross-customer blending should have been
 *     structurally impossible) — still came back mostly wrong, including
 *     names that had read correctly under design #2. The crop that failed
 *     looked perfectly legible on manual visual inspection of the SAME
 *     render this codebase produces locally.
 *
 * What #1-#3 all had in common: this codebase rendering the PDF to a raster
 * image itself (pdfjs-dist + @napi-rs/canvas/skia) before showing it to
 * anything. The one thing that's independently VERIFIED to read this exact
 * kind of file correctly is Claude reading the PDF the user pastes directly
 * into chat — which uses Claude's own native PDF handling, not a
 * third-party renderer. skia evidently renders this PDF's (already known
 * to have a defective font table) glyphs in a way a human eye smooths over
 * but that trips up character-precise reading, on both a local OCR engine
 * and Claude alike.
 *
 * Fix: stop rendering ourselves. Extract just the ONE needed page into its
 * own tiny single-page PDF (via pdf-lib — a cheap structural copy, no
 * rasterization) and send that page as a native PDF `document` content
 * block, exactly like a user pasting the file into chat, so Claude's own
 * (already-proven) PDF renderer handles it instead of ours.
 *
 * Cost control ("ใช้ API ให้ประหยัด"): only a page actually containing a
 * still-needed code is ever extracted (never a whole file blind), several
 * single-page PDFs are batched per request instead of one request per
 * customer, and a code already resolved (anywhere) is never requested again.
 */

// TEMP DIAGNOSTIC: was claude-haiku-4-5-20251001. Haiku's answers matched
// this report's own corrupted text layer exactly on a real production run
// (e.g. "ปม นิมิตรบริการ" — missing marks — instead of the visually-correct
// "ปั๊ม นิมิตรบริการ"), suggesting it read the embedded text instead of
// actually looking at the rendered page. Testing whether a stronger model
// looks harder rather than taking that shortcut before deciding if the
// extra cost is worth it.
const MODEL = "claude-sonnet-5";
const PAGES_PER_REQUEST = 6;
const REQUEST_CONCURRENCY = 3;
// Overall wall-clock budget for every Claude call in one pipeline run —
// leaves headroom under the API route's own maxDuration for PDF parsing,
// the commission calculation itself, and building the Excel workbook, all
// of which still happen after this returns.
const TOTAL_BUDGET_MS = 42_000;

const MASTER_CODE_RE = /^[A-Za-z]{1,5}\d{4,}$|^\d{6,}$/;
const SALES_CUSTOMER_CODE_RE = /^[A-Za-z]{1,5}\d{4,}$/;
const HEADER_LINE_RE = /^(.+?)\s*\/\s*(\S+)\s*$/;

type PdfTextItem = { str: string };

export interface ClaudeNameResult {
  namesByCode: Map<string, string>;
  warnings: string[];
}

interface PageDoc {
  source: string;
  pageNum: number;
  codes: string[];
  pdfBase64: string;
}

/**
 * Text-content-only scan (cheap, no rendering) for which PAGE each
 * still-needed code's header is on, and which OTHER still-needed codes
 * share that same page — `isMaster` picks the layout rule:
 *  - master (distance/เซลล์) file: a real table, the code is its own text
 *    item.
 *  - a sales-report file: an inline "<name> /<code>" header line, where the
 *    code is sometimes its own text item and sometimes glued to the name in
 *    one item (verified against real files) — matched on the joined line
 *    text instead of a single item.
 * Claims every code it finds (mutates `remaining`) so a later file never
 * rescans for something already located.
 */
async function locatePages(buffer: Buffer, remaining: Set<string>, isMaster: boolean): Promise<Map<number, string[]>> {
  const pagesFound = new Map<number, string[]>();
  if (remaining.size === 0) return pagesFound;

  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), stopAtErrors: false, isEvalSupported: false }).promise;

  for (let pageNum = 1; pageNum <= doc.numPages && remaining.size > 0; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent({ disableNormalization: true });
    const items = content.items.filter((i) => "str" in i && "transform" in i) as unknown as (PdfTextItem & { transform: number[] })[];
    const found: string[] = [];

    if (isMaster) {
      for (const item of items) {
        const code = item.str.trim().toUpperCase();
        if (MASTER_CODE_RE.test(code) && remaining.has(code)) found.push(code);
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
        const trimmed = rowItems.map((i) => i.str).join("").trim();
        if (!trimmed || /\d+\.\d+/.test(trimmed) || trimmed.includes("ลิตร")) continue; // data/subtotal line, not a header
        const m = trimmed.match(HEADER_LINE_RE);
        if (!m) continue;
        const code = m[2].toUpperCase();
        if (SALES_CUSTOMER_CODE_RE.test(code) && remaining.has(code)) found.push(code);
      }
    }
    if (found.length === 0) continue;
    const unique = [...new Set(found)];
    unique.forEach((c) => remaining.delete(c));
    pagesFound.set(pageNum, unique);
  }
  return pagesFound;
}

/** Copies ONE page out of `buffer` into its own brand-new single-page PDF —
 *  a structural copy (pdf-lib), never a rasterization, so this never
 *  inherits skia's rendering quirks and costs almost nothing regardless of
 *  how large the source report is. */
async function extractPageAsPdf(buffer: Buffer, pageIndexZeroBased: number): Promise<string> {
  const srcDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const outDoc = await PDFDocument.create();
  const [copied] = await outDoc.copyPages(srcDoc, [pageIndexZeroBased]);
  outDoc.addPage(copied);
  const bytes = await outDoc.save();
  return Buffer.from(bytes).toString("base64");
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object found in response");
  return JSON.parse(body.slice(start, end + 1));
}

async function callClaudeForPages(client: Anthropic, pages: PageDoc[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (pages.length === 0) return result;

  // Each PDF page is Claude's own native document reading (not a raster
  // image this codebase produced) — see module doc for why that distinction
  // is the actual fix, not just another prompt tweak.
  const content: Anthropic.ContentBlockParam[] = [];
  pages.forEach((p, i) => {
    content.push({ type: "text", text: `Document ${i + 1} — customer codes to find on THIS page only: ${p.codes.join(", ")}` });
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: p.pdfBase64 } });
  });
  const allCodes = pages.flatMap((p) => p.codes);
  content.push({
    type: "text",
    text:
      `Each document above is one page of a Thai fuel-sales/customer PDF report, labeled with the customer codes printed somewhere ON THAT SPECIFIC PAGE. For each code, find it on its labeled page and read the EXACT Thai customer name printed right next to it (include every tone mark and vowel exactly as shown — this report's own embedded text layer is corrupted for these, so read what's actually printed on the page, not any text layer).\n\n` +
      `Rules: only report a name you can actually find on that code's own labeled page; never guess or reuse a name from a different code; omit a code entirely rather than answer it if you're not confident.\n\n` +
      `All codes across every page: ${allCodes.join(", ")}\n\n` +
      `Respond with ONLY a JSON object mapping each code you found to its exact Thai name, e.g. {"KCL660012":"ปั๊ม นิมิตรบริการ"}. No other text.`,
  });

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: Math.min(4096, 200 + allCodes.length * 40),
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

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const remaining = new Set(targetCodes);
  const pageDocs: PageDoc[] = [];

  async function collect(buffer: Buffer, source: string, isMaster: boolean) {
    if (remaining.size === 0 || Date.now() > deadline) return;
    try {
      const pages = await locatePages(buffer, remaining, isMaster);
      for (const [pageNum, codes] of pages) {
        if (Date.now() > deadline) break;
        const pdfBase64 = await extractPageAsPdf(buffer, pageNum - 1);
        pageDocs.push({ source, pageNum, codes, pdfBase64 });
      }
    } catch (err) {
      warnings.push(`[แก้ชื่อภาษาไทยด้วย Claude] อ่านไฟล์ '${source}' ไม่สำเร็จ — ใช้ชื่อจากไฟล์ตามปกติแทน (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  if (masterFile) await collect(masterFile, "master", true);
  for (const f of salesFiles) await collect(f.buffer, f.filename, false);

  if (pageDocs.length === 0) return { namesByCode, warnings };

  const batches: PageDoc[][] = [];
  for (let i = 0; i < pageDocs.length; i += PAGES_PER_REQUEST) batches.push(pageDocs.slice(i, i + PAGES_PER_REQUEST));

  let timedOut = false;
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
        const expectedCodes = new Set(batch.flatMap((p) => p.codes));
        const found = await callClaudeForPages(client, batch);
        for (const [code, name] of found) {
          // Defense in depth against a malformed response: never accept a
          // code this batch didn't actually ask about.
          if (expectedCodes.has(code)) namesByCode.set(code, name);
        }
      } catch (err) {
        apiErrors++;
        if (apiErrors <= 2) {
          // TEMP DIAGNOSTIC: surface the actual SDK error for the first
          // couple of failures instead of just a count, to find out WHY
          // (e.g. an invalid/inaccessible model id) rather than guessing.
          warnings.push(`[แก้ชื่อภาษาไทยด้วย Claude][debug] ${err instanceof Error ? err.message : String(err)}`);
        }
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
