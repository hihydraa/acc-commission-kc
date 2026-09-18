import { NextRequest, NextResponse } from "next/server";
import { getBranchById, BRANCHES } from "@/branches";
import { previewQualifyingCustomers, type ChannelInput, type InputFile, type ChannelKey } from "@/lib/pipeline";
import { loadSettings, applyBranchOverride } from "@/lib/settings";
import { buildSheetMasterLookup, readBranchRoster } from "@/lib/googleSheets";

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

/**
 * Phase 1 of the confirm-before-calculate flow (see src/lib/pipeline.ts's
 * previewQualifyingCustomers doc comment): parses the uploaded files and
 * reports which qualifying customers already have distance/เซลล์/ชื่อ data
 * (from the branch's Google Sheet tab) and which still need the user to
 * fill it in on /confirm.
 */
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
    if (channelInputs.length === 0) {
      return NextResponse.json({ error: "ต้องแนบไฟล์อย่างน้อย 1 ไฟล์ (รถมิเตอร์/รถเทรลเลอร์/กรอกหลังปั๊ม)" }, { status: 400 });
    }

    const [masterLookup, roster] = await Promise.all([buildSheetMasterLookup(branch.sheetTabName), readBranchRoster(branch.sheetTabName)]);
    const { customers, warnings } = await previewQualifyingCustomers(branch, channelInputs, masterLookup);

    return NextResponse.json({ customers, roster, warnings });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `ตรวจสอบข้อมูลไม่สำเร็จ: ${message}` }, { status: 500 });
  }
}
