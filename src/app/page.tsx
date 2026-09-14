"use client";

import { useState } from "react";
import Link from "next/link";
import { BRANCHES } from "@/branches";

interface CalcSummary {
  truckCount: number;
  qualifyingTransactionCount: number;
  qualifyingCustomerCount: number;
  qualifyingLiters: number;
  grossCommission: number;
  debtDeduction: number;
  netCommission: number;
  matchedDebtFlagged: number;
}

interface CalcResponse {
  filename: string;
  fileBase64: string;
  summary: CalcSummary;
  warnings: string[];
}

function baht(n: number): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function Home() {
  const [branchId, setBranchId] = useState(BRANCHES[0]?.id ?? "");
  const [salesFiles, setSalesFiles] = useState<FileList | null>(null);
  const [arFile, setArFile] = useState<File | null>(null);
  const [masterFile, setMasterFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CalcResponse | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    if (!salesFiles || salesFiles.length === 0) {
      setError("กรุณาเลือกไฟล์รายงานขายรายคันรถอย่างน้อย 1 ไฟล์");
      return;
    }
    if (!arFile) {
      setError("กรุณาเลือกไฟล์รายงานลูกหนี้ค้างชำระ (AR)");
      return;
    }
    setLoading(true);
    try {
      const form = new FormData();
      form.set("branchId", branchId);
      Array.from(salesFiles).forEach((f) => form.append("salesFiles", f));
      form.set("arFile", arFile);
      if (masterFile) form.set("masterFile", masterFile);

      const res = await fetch("/api/calculate", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "คำนวณไม่สำเร็จ");
        return;
      }
      setResult(data as CalcResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function downloadFile() {
    if (!result) return;
    const byteChars = atob(result.fileBase64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    const blob = new Blob([new Uint8Array(byteNumbers)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = result.filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const branch = BRANCHES.find((b) => b.id === branchId);

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-10 text-neutral-900">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">ระบบคำนวณค่าคอมมิชชั่นฝ่ายการตลาด</h1>
            <p className="mt-1 text-sm text-neutral-600">
              อัปโหลดไฟล์ PDF รายงานขายรายคันรถ (หลายไฟล์), รายงานลูกหนี้ค้างชำระ, และไฟล์ master ระยะทาง/เซลล์ (ถ้ามี) —
              ระบบจะคำนวณและสร้างไฟล์ Excel ตาม Template ให้อัตโนมัติ
            </p>
          </div>
          <Link href="/settings" className="whitespace-nowrap text-sm text-neutral-600 underline">
            ตั้งค่าเงื่อนไข →
          </Link>
        </header>

        <form onSubmit={handleSubmit} className="space-y-5 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
          <div>
            <label className="block text-sm font-medium">สาขา / BU</label>
            <select
              className="mt-1 w-full rounded border border-neutral-300 px-3 py-2 text-sm"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
            >
              {BRANCHES.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.companyName} — {b.label}
                </option>
              ))}
            </select>
            {branch && (
              <p className="mt-1 text-xs text-neutral-500">
                เซลล์ในสาขานี้: {branch.salespersonRoster.join(", ")} · สินค้าที่นับ: {branch.fuelProductCodes.join(", ")} ·{" "}
                {branch.departments
                  ? `เกณฑ์แยกตามแผนก: ${branch.departments.map((d) => `${d.label} ≥${d.minQtyLiters.toLocaleString()}ล.`).join(", ")}`
                  : `เกณฑ์ ≥${(branch.minQtyLiters ?? 0).toLocaleString()} ลิตร${branch.requireExactMultiple ? ` (หาร ${branch.qtyMultipleOf} ลงตัว)` : ""}`}
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium">รายงานขายรายคันรถ (เลือกได้หลายไฟล์) *</label>
            <input
              type="file"
              accept="application/pdf"
              multiple
              className="mt-1 w-full text-sm"
              onChange={(e) => setSalesFiles(e.target.files)}
            />
            {salesFiles && <p className="mt-1 text-xs text-neutral-500">เลือกแล้ว {salesFiles.length} ไฟล์</p>}
          </div>

          <div>
            <label className="block text-sm font-medium">รายงานลูกหนี้ค้างชำระ (ลงวันที่ 7 ของเดือนถัดไป) *</label>
            <input
              type="file"
              accept="application/pdf"
              className="mt-1 w-full text-sm"
              onChange={(e) => setArFile(e.target.files?.[0] ?? null)}
            />
          </div>

          <div>
            <label className="block text-sm font-medium">ไฟล์ master ระยะทาง/เซลล์ (ถ้ามี)</label>
            <input
              type="file"
              accept="application/pdf"
              className="mt-1 w-full text-sm"
              onChange={(e) => setMasterFile(e.target.files?.[0] ?? null)}
            />
            <p className="mt-1 text-xs text-neutral-500">
              หากไม่แนบ ระบบจะใช้เฉพาะข้อมูลที่ยืนยันไว้ล่วงหน้าของสาขานี้ — ลูกค้าที่ยังไม่มีระยะทางจะถูกตั้งค่าขนส่งเป็น 0 บาท/ลิตร
              โดยดีฟอลต์ และจะถูกระบุไว้ในชีทหมายเหตุให้ตรวจสอบก่อนส่งมอบ
            </p>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {loading ? "กำลังคำนวณ..." : "คำนวณค่าคอม"}
          </button>
        </form>

        {error && <div className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800">{error}</div>}

        {result && (
          <div className="space-y-4 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
            <h2 className="font-semibold">ผลการคำนวณ</h2>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-neutral-500">รายการเข้าเกณฑ์</dt>
                <dd className="font-medium">{result.summary.qualifyingTransactionCount.toLocaleString()} รายการ</dd>
              </div>
              <div>
                <dt className="text-neutral-500">จำนวนลูกค้า</dt>
                <dd className="font-medium">{result.summary.qualifyingCustomerCount.toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-neutral-500">ลิตรรวม (เข้าเกณฑ์)</dt>
                <dd className="font-medium">{result.summary.qualifyingLiters.toLocaleString()} ลิตร</dd>
              </div>
              <div>
                <dt className="text-neutral-500">ค่าคอมรวม (ก่อนหักหนี้)</dt>
                <dd className="font-medium">฿{baht(result.summary.grossCommission)}</dd>
              </div>
              <div>
                <dt className="text-neutral-500">หักหนี้ค้างชำระ</dt>
                <dd className="font-medium">฿{baht(result.summary.debtDeduction)}</dd>
              </div>
              <div>
                <dt className="text-neutral-500">ค่าคอมสุทธิ</dt>
                <dd className="font-medium">฿{baht(result.summary.netCommission)}</dd>
              </div>
            </dl>

            {result.summary.debtDeduction === 0 && result.summary.matchedDebtFlagged > 0 && (
              <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                พบหนี้ค้างชำระที่ตรงกับรายการเข้าเกณฑ์ ฿{baht(result.summary.matchedDebtFlagged)} — สาขานี้ไม่ได้หักอัตโนมัติ
                (นโยบายให้บัญชีพิจารณาหัก 50%/100% เอง) ดูรายละเอียดในชีท &quot;หักหนี้ค้างชำระ&quot; ของไฟล์ Excel
              </div>
            )}

            <button onClick={downloadFile} className="w-full rounded bg-emerald-700 px-4 py-2 text-sm font-medium text-white">
              ดาวน์โหลดไฟล์ Excel ({result.filename})
            </button>

            {result.warnings.length > 0 && (
              <details className="text-sm" open>
                <summary className="cursor-pointer font-medium text-amber-700">
                  คำเตือน / สิ่งที่ต้องตรวจสอบก่อนส่งมอบ ({result.warnings.length})
                </summary>
                <ul className="mt-2 max-h-80 space-y-1 overflow-y-auto rounded bg-amber-50 p-3 text-xs text-amber-900">
                  {result.warnings.map((w, i) => (
                    <li key={i}>• {w}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
