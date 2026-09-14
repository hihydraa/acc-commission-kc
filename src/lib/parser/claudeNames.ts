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
 * A local Tesseract-OCR-on-a-pixel-crop approach was tried first (render the
 * page, crop tightly around just the name) and worked well on the master
 * file's own table layout, but measurably WORSENED many names on the
 * sales-report files' font — verified against real files (e.g. "คุณแมสุป" ->
 * "คุณเม่สปี", "สมบูรณ บ.หนองหิน" -> "จงบรณ์ บหนองหิ้น") across several crop/
 * scale/margin variations, not just one bad attempt. This module replaces
 * that with Claude's own vision reading of the rendered page image instead
 * of a narrow pixel crop + a small OCR model — the same reason Claude chat
 * already read these PDFs correctly when the user pasted them directly (see
 * the marketing-commission-calc session notes): a real vision-capable model
 * reads the page the way a person would, not the page's own (corrupted)
 * embedded text.
 *
 * Cost control ("ใช้ API ให้ประหยัด"): only a PAGE actually containing a
 * still-needed customer code's header line is ever rendered/sent (never a
 * whole file blind), every request batches several pages' images together
 * instead of one request per name, and once a code is resolved anywhere it
 * is never requested again — see `resolveCustomerNamesViaClaude`.
 */

const MODEL = "claude-haiku-4-5-20251001";
const RENDER_SCALE = 2; // moderate — a vision model reading printed text doesn't need Tesseract's ~288dpi
const PAGES_PER_REQUEST = 6;
const REQUEST_CONCURRENCY = 3;
// Overall wall-clock budget for every Claude call in one pipeline run — see
// ocrNames.ts-era note this replaces: leaves headroom under the API route's
// own maxDuration for PDF parsing, the commission calculation itself, and
// building the Excel workbook, all of which still happen after this returns.
const TOTAL_BUDGET_MS = 42_000;

const MASTER_CODE_RE = /^[A-Za-z]{1,5}\d{4,}$|^\d{6,}$/;
const SALES_CUSTOMER_CODE_RE = /^[A-Za-z]{1,5}\d{4,}$/;
const HEADER_LINE_RE = /^(.+?)\s*\/\s*(\S+)\s*$/;

type PdfTextItem = { str: string; transform: number[] };

export interface ClaudeNameResult {
  namesByCode: Map<string, string>;
  warnings: string[];
}

interface PageJob {
  source: string;
  doc: import("pdfjs-dist/legacy/build/pdf.mjs").PDFDocumentProxy;
  pageNum: number;
  codes: string[];
}

/** Every page in `buffer` that contains at least one still-unclaimed code
 *  from `remaining`, tagged with which codes it has — text-content only, no
 *  rendering yet, so scanning a multi-hundred-page report for this costs
 *  almost nothing. `isMaster` picks which layout's code-position rule to use
 *  (see module doc on ocrNames.ts's old table-vs-inline-header distinction,
 *  which still applies here for LOCATING a code, just not for cropping). */
async function findRelevantPages(
  buffer: Buffer,
  remaining: Set<string>,
  isMaster: boolean
): Promise<{ doc: import("pdfjs-dist/legacy/build/pdf.mjs").PDFDocumentProxy; pages: Map<number, string[]> }> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), stopAtErrors: false, isEvalSupported: false }).promise;
  const pages = new Map<number, string[]>();
  if (remaining.size === 0) return { doc, pages };

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent({ disableNormalization: true });
    const items = content.items.filter((i) => "str" in i && "transform" in i) as unknown as PdfTextItem[];
    const found: string[] = [];

    if (isMaster) {
      for (const it of items) {
        const code = it.str.trim().toUpperCase();
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
        const sorted = [...rowItems].sort((a, b) => a.transform[4] - b.transform[4]);
        const trimmed = sorted.map((i) => i.str).join("").trim();
        if (!trimmed || /\d+\.\d+/.test(trimmed) || trimmed.includes("ลิตร")) continue;
        const m = trimmed.match(HEADER_LINE_RE);
        if (!m) continue;
        const code = m[2].toUpperCase();
        if (SALES_CUSTOMER_CODE_RE.test(code) && remaining.has(code)) found.push(code);
      }
    }
    if (found.length > 0) pages.set(pageNum, [...new Set(found)]);
  }
  return { doc, pages };
}

async function renderPagePng(
  doc: import("pdfjs-dist/legacy/build/pdf.mjs").PDFDocumentProxy,
  pageNum: number
): Promise<Buffer> {
  // Same @napi-rs/canvas compat shim as the old ocrNames.ts module — see its
  // history for why the raw Canvas API and the plain `canvas` package both
  // fail here (a Path2D type error, and silently-blank text, respectively),
  // and why @napi-rs/canvas stays pinned to exactly 0.1.100.
  const { createRequire } = await import("module");
  const require = createRequire(import.meta.url);
  const { createCanvas } = require("@napi-rs/canvas/node-canvas.js") as {
    createCanvas: (w: number, h: number) => { getContext: (kind: "2d") => unknown; toBuffer: (mime: string) => Buffer };
  };
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toBuffer("image/png");
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object found in response");
  return JSON.parse(body.slice(start, end + 1));
}

async function callClaudeForBatch(client: Anthropic, pages: { source: string; pageNum: number; png: Buffer }[], codes: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (codes.length === 0 || pages.length === 0) return result;

  const content: Anthropic.ContentBlockParam[] = pages.map((p) => ({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: p.png.toString("base64") },
  }));
  content.push({
    type: "text",
    text:
      `These are pages from a Thai fuel-sales/customer PDF report. For each of these customer codes, find where it is printed on one of the pages and read the EXACT Thai customer name printed right next to it (include every tone mark and vowel exactly as shown — the source PDF's own embedded text is corrupted for these, so read the visible glyphs, not any text you might otherwise infer).\n\n` +
      `Codes: ${codes.join(", ")}\n\n` +
      `Respond with ONLY a JSON object mapping each code you found to its exact Thai name, e.g. {"KCL660012":"ปั๊ม นิมิตรบริการ"}. Omit any code you cannot find on these pages. No other text.`,
  });

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: Math.min(4096, 200 + codes.length * 40),
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

  const remaining = new Set(targetCodes);
  const pageJobs: PageJob[] = [];
  const openedDocs: import("pdfjs-dist/legacy/build/pdf.mjs").PDFDocumentProxy[] = [];

  async function collect(buffer: Buffer, source: string, isMaster: boolean) {
    if (remaining.size === 0) return;
    try {
      const { doc, pages } = await findRelevantPages(buffer, remaining, isMaster);
      openedDocs.push(doc);
      for (const [pageNum, codes] of pages) {
        const stillNeeded = codes.filter((c) => remaining.has(c));
        if (stillNeeded.length === 0) continue;
        stillNeeded.forEach((c) => remaining.delete(c));
        pageJobs.push({ source, doc, pageNum, codes: stillNeeded });
      }
    } catch (err) {
      warnings.push(`[แก้ชื่อภาษาไทยด้วย Claude] อ่านไฟล์ '${source}' ไม่สำเร็จ — ใช้ชื่อจากไฟล์ตามปกติแทน (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  if (masterFile) await collect(masterFile, "master", true);
  for (const f of salesFiles) await collect(f.buffer, f.filename, false);

  if (pageJobs.length === 0) return { namesByCode, warnings };

  // Batch PAGES_PER_REQUEST pages (and their union of codes) per API call —
  // one call reading several pages at once is far cheaper than one call per
  // customer name.
  const batches: PageJob[][] = [];
  for (let i = 0; i < pageJobs.length; i += PAGES_PER_REQUEST) batches.push(pageJobs.slice(i, i + PAGES_PER_REQUEST));

  const deadline = Date.now() + TOTAL_BUDGET_MS;
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
        const pages = await Promise.all(batch.map(async (j) => ({ source: j.source, pageNum: j.pageNum, png: await renderPagePng(j.doc, j.pageNum) })));
        const codes = [...new Set(batch.flatMap((j) => j.codes))];
        const found = await callClaudeForBatch(client, pages, codes);
        for (const [code, name] of found) namesByCode.set(code, name);
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
