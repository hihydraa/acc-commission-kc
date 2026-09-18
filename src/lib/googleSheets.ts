import { JWT } from "google-auth-library";
import type { MasterLookup, ResolvedMasterEntry } from "./pipeline";

/**
 * Reads/writes the "Commission_Distance_Seller" Google Sheet — one tab per
 * branch (ST/KN/MUK/VRN) — which is now the sole source of customer
 * distance/เซลล์/ชื่อลูกค้า data (replacing the old monthly master-PDF
 * upload). Requires a Google service account with the Sheet shared to it as
 * Editor; see GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
 * below — this is a manual setup step for the account owner, not something
 * this code can do on its own (see standingNotes on mukdahan.ts/wanonniwat.ts
 * for what still needs confirming before real data goes in).
 *
 * The two existing tabs (ST/KN) don't share one column layout (ST has
 * สินค้า/หมายเหตุ columns KN doesn't) — read defensively by HEADER NAME on
 * row 1, never by a fixed column index, so a tab missing a column just
 * reads that field as blank instead of erroring or misreading a neighbor.
 */

const SPREADSHEET_ID = "1r2szI26J1NqPakkvhVxctf8BiIHrQ0TFOXrd7jQW1XU";

export interface SheetRow {
  rowNumber: number; // 1-indexed, matches the real sheet row (for updates)
  customerCode: string;
  customerName: string;
  area: string;
  distanceKm: number | null;
  tag: "1สาย1สู้" | "ทางผ่าน" | "";
  salesperson: string;
}

function isConfigured(): boolean {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
}

function getClient(): JWT {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!email || !key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ยังไม่ได้ตั้งค่า — ดู src/lib/googleSheets.ts");
  }
  return new JWT({
    email,
    // Vercel env vars can't hold real newlines — the key is stored with
    // literal "\n" escapes and unescaped here, the standard pattern for
    // service-account keys in serverless env vars.
    key: key.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function fetchRange(tabName: string, range: string): Promise<string[][]> {
  const client = getClient();
  const token = await client.getAccessToken();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(`${tabName}!${range}`)}`,
    { headers: { Authorization: `Bearer ${token.token}` } }
  );
  if (!res.ok) throw new Error(`Google Sheets API error (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { values?: string[][] };
  return data.values ?? [];
}

function parseDistance(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function parseTag(raw: string | undefined): "1สาย1สู้" | "ทางผ่าน" | "" {
  const t = (raw ?? "").trim();
  if (t === "1สาย1สู้" || t === "ทางผ่าน") return t;
  return "";
}

/** Reads a branch's whole tab, matching columns by header name (row 1) so
 *  ST's extra สินค้า/หมายเหตุ columns and KN's narrower layout both work. */
export async function readBranchSheet(tabName: string): Promise<SheetRow[]> {
  const values = await fetchRange(tabName, "A1:Z1000");
  if (values.length === 0) return [];
  const header = values[0].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const idxCode = col("รหัส");
  const idxName = col("ชื่อลูกค้า");
  const idxArea = col("พื้นที่");
  const idxDistance = col("ระยะทาง/กม.");
  const idxTag = col("หมายเหตุ");
  const idxSalesperson = col("เซลล์");

  const rows: SheetRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const customerCode = (row[idxCode] ?? "").trim();
    if (!customerCode) continue;
    const rawDistance = idxDistance >= 0 ? (row[idxDistance] ?? "").trim() : "";
    // A tab with no dedicated "หมายเหตุ" column (e.g. KN) still needs a way
    // to express "ทางผ่าน" — it's written directly into the ระยะทาง/กม.
    // column as text instead of a number (confirmed real: KN row 21,
    // "ปั๊มปุ๊บริการ ... ทางผ่าน"), so that text doubles as the tag there.
    const inlineTag = rawDistance === "ทางผ่าน" || rawDistance === "1สาย1สู้" ? (rawDistance as "1สาย1สู้" | "ทางผ่าน") : "";
    rows.push({
      rowNumber: i + 1,
      customerCode,
      customerName: (row[idxName] ?? "").trim(),
      area: idxArea >= 0 ? (row[idxArea] ?? "").trim() : "",
      distanceKm: inlineTag ? null : parseDistance(rawDistance),
      tag: idxTag >= 0 ? parseTag(row[idxTag]) : inlineTag,
      salesperson: idxSalesperson >= 0 ? (row[idxSalesperson] ?? "").trim() : "",
    });
  }
  return rows;
}

/** Distinct เซลล์ names seen in a branch's tab — replaces the old hardcoded
 *  BranchConfig.salespersonRoster (see branches/types.ts). */
export async function readBranchRoster(tabName: string): Promise<string[]> {
  const rows = await readBranchSheet(tabName);
  return [...new Set(rows.map((r) => r.salesperson).filter(Boolean))];
}

/** Update-if-code-found / append-if-new, matched by the รหัส column —
 *  called when the user confirms/edits a customer on the confirmation page. */
export async function upsertRow(tabName: string, row: Omit<SheetRow, "rowNumber">): Promise<void> {
  const existing = await readBranchSheet(tabName);
  const match = existing.find((r) => r.customerCode === row.customerCode);
  const client = getClient();
  const token = await client.getAccessToken();
  const values = [row.customerCode, row.customerName, row.area, row.distanceKm ?? "", row.salesperson, row.tag];

  if (match) {
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(`${tabName}!A${match.rowNumber}:F${match.rowNumber}`)}?valueInputOption=USER_ENTERED`,
      { method: "PUT", headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [values] }) }
    );
    if (!res.ok) throw new Error(`Google Sheets update failed (${res.status}): ${await res.text()}`);
  } else {
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(`${tabName}!A1`)}:append?valueInputOption=USER_ENTERED`,
      { method: "POST", headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [values] }) }
    );
    if (!res.ok) throw new Error(`Google Sheets append failed (${res.status}): ${await res.text()}`);
  }
}

/** Builds a MasterLookup (see pipeline.ts) from a branch's live Sheet data.
 *  Falls back to NULL-like behavior (nothing resolves) if credentials
 *  aren't configured yet, with a console warning rather than crashing the
 *  whole request — see GOOGLE_SERVICE_ACCOUNT_EMAIL/KEY above. */
export async function buildSheetMasterLookup(tabName: string): Promise<MasterLookup> {
  if (!isConfigured()) {
    console.warn("[googleSheets] GOOGLE_SERVICE_ACCOUNT_EMAIL/KEY not set — every customer will need manual confirmation");
    return { get: () => null };
  }
  const rows = await readBranchSheet(tabName);
  const byCode = new Map<string, ResolvedMasterEntry>();
  for (const r of rows) {
    byCode.set(r.customerCode, { customerName: r.customerName, distanceKm: r.distanceKm, salesperson: r.salesperson, tag: r.tag });
  }
  return { get: (code: string) => byCode.get(code) ?? null };
}
