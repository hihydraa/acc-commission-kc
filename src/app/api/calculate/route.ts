import { NextRequest, NextResponse } from "next/server";
import { getBranchById, BRANCHES } from "@/branches";
import { runCommissionPipeline, type ChannelInput, type InputFile, type ChannelKey, type MasterLookup, type ResolvedMasterEntry } from "@/lib/pipeline";
import { loadSettings, applyBranchOverride } from "@/lib/settings";
import { upsertRow } from "@/lib/googleSheets";
import type { PeriodInfo } from "@/lib/excelExport";

export const runtime = "nodejs";
export const maxDuration = 60;

async function toInputFile(file: File): Promise<InputFile> {
  const buffer = Buffer.from(await file.arrayBuffer());
  return { filename: file.name, buffer };
}

const CHANNEL_FIELD: Record<ChannelKey, string> = {
  meterTruck: "meterTruckFiles",
  trailer: "trailerFiles",
  pumpFill: "pumpFillFiles",
};

interface ConfirmedCustomer extends ResolvedMasterEntry {
  customerCode: string;
  /** true when the user actually typed/changed something on the confirm
   *  page (vs. it arriving already correct from the Sheet) — only these get
   *  written back, so an unedited row's Sheet data is never rewritten
   *  byte-for-byte on every single run */
  edited: boolean;
}

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const branchId = form.get("branchId");
    if (typeof branchId !== "string") {
      return NextResponse.json({ error: "ไม่ได้ระบุสาขา (branchId)" }, { status: 400 });
    }
    const baseBranch = getBranchById(branchId);
    if (!baseBranch) {
      return NextResponse.json({ error: `ไม่พบสาขา '${branchId}' — สาขาที่รองรับ: ${BRANCHES.map((b) => b.id).join(", ")}` }, { status: 400 });
    }
    const settings = await loadSettings();
    const branch = applyBranchOverride(baseBranch, settings[branchId]);

    const channelInputs: ChannelInput[] = [];
    for (const [channel, field] of Object.entries(CHANNEL_FIELD) as [ChannelKey, string][]) {
      const entries = form.getAll(field).filter((f): f is File => f instanceof File);
      if (entries.length > 0) channelInputs.push({ channel, files: await Promise.all(entries.map(toInputFile)) });
    }
    const arFileEntry = form.get("arFile");
    if (channelInputs.length === 0) {
      return NextResponse.json({ error: "ต้องแนบไฟล์อย่างน้อย 1 ไฟล์ (รถมิเตอร์/รถเทรลเลอร์/กรอกหลังปั๊ม)" }, { status: 400 });
    }
    if (!(arFileEntry instanceof File)) {
      return NextResponse.json({ error: "ต้องแนบไฟล์รายงานลูกหนี้ค้างชำระ (AR)" }, { status: 400 });
    }
    const arFile = await toInputFile(arFileEntry);

    const periodRaw = form.get("period");
    const rosterRaw = form.get("roster");
    const confirmedRaw = form.get("confirmedCustomers");
    if (typeof periodRaw !== "string" || typeof rosterRaw !== "string" || typeof confirmedRaw !== "string") {
      return NextResponse.json({ error: "ข้อมูลยืนยัน (period/roster/confirmedCustomers) ไม่ครบ — ต้องผ่านหน้ายืนยันก่อนคำนวณ" }, { status: 400 });
    }
    const period = JSON.parse(periodRaw) as PeriodInfo;
    const roster = JSON.parse(rosterRaw) as string[];
    const confirmed = JSON.parse(confirmedRaw) as ConfirmedCustomer[];

    const confirmedByCode = new Map(confirmed.map((c) => [c.customerCode, c]));
    const masterLookup: MasterLookup = { get: (code) => confirmedByCode.get(code) ?? null };

    const result = await runCommissionPipeline(branch, channelInputs, arFile, period, roster, masterLookup);

    // Write back only rows the user actually edited on the confirmation
    // page — never rewrite a Sheet row that arrived already correct, so an
    // unedited run makes zero writes to the shared Sheet.
    const edited = confirmed.filter((c) => c.edited);
    if (edited.length > 0) {
      await Promise.allSettled(
        edited.map((c) =>
          upsertRow(branch.sheetTabName, {
            customerCode: c.customerCode,
            customerName: c.customerName,
            area: "",
            distanceKm: c.distanceKm,
            tag: c.tag,
            salesperson: c.salesperson,
          })
        )
      );
    }

    const fileBase64 = Buffer.from(result.workbook).toString("base64");
    const filename = `ค่าคอม_${branch.id}_${period.periodLabel.replace(/\//g, "-")}.xlsx`;

    return NextResponse.json({
      filename,
      fileBase64,
      summary: result.summary,
      warnings: result.warnings,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `คำนวณไม่สำเร็จ: ${message}` }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ branches: BRANCHES.map((b) => ({ id: b.id, label: b.label, companyName: b.companyName })) });
}
