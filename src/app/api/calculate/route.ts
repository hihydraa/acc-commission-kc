import { NextRequest, NextResponse } from "next/server";
import { getBranchById, BRANCHES } from "@/branches";
import { runCommissionPipeline, type InputFile } from "@/lib/pipeline";

export const runtime = "nodejs";
export const maxDuration = 60;

async function toInputFile(file: File): Promise<InputFile> {
  const buffer = Buffer.from(await file.arrayBuffer());
  return { filename: file.name, buffer };
}

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const branchId = form.get("branchId");
    if (typeof branchId !== "string") {
      return NextResponse.json({ error: "ไม่ได้ระบุสาขา (branchId)" }, { status: 400 });
    }
    const branch = getBranchById(branchId);
    if (!branch) {
      return NextResponse.json({ error: `ไม่พบสาขา '${branchId}' — สาขาที่รองรับ: ${BRANCHES.map((b) => b.id).join(", ")}` }, { status: 400 });
    }

    const salesFileEntries = form.getAll("salesFiles").filter((f): f is File => f instanceof File);
    const arFileEntry = form.get("arFile");
    const masterFileEntry = form.get("masterFile");

    if (salesFileEntries.length === 0) {
      return NextResponse.json({ error: "ต้องแนบไฟล์รายงานขายรายคันรถอย่างน้อย 1 ไฟล์" }, { status: 400 });
    }
    if (!(arFileEntry instanceof File)) {
      return NextResponse.json({ error: "ต้องแนบไฟล์รายงานลูกหนี้ค้างชำระ (AR)" }, { status: 400 });
    }

    const salesFiles = await Promise.all(salesFileEntries.map(toInputFile));
    const arFile = await toInputFile(arFileEntry);
    const masterFile = masterFileEntry instanceof File ? await toInputFile(masterFileEntry) : null;

    const result = await runCommissionPipeline(branch, salesFiles, arFile, masterFile);

    const fileBase64 = Buffer.from(result.workbook).toString("base64");
    const monthLabel = new Date().toISOString().slice(0, 7);
    const filename = `ค่าคอม_${branch.id}_${monthLabel}.xlsx`;

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
