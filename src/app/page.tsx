"use client";

import { useState } from "react";
import Link from "next/link";
import { BRANCHES } from "@/branches";

interface QualifyingCustomerPreview {
  customerCode: string;
  customerName: string;
  truckLabels: string[];
  resolved: { customerName: string; distanceKm: number | null; salesperson: string; tag: "1สาย1สู้" | "ทางผ่าน" | "" } | null;
}

interface ConfirmRow {
  customerCode: string;
  customerName: string;
  truckLabels: string[];
  distanceKm: string; // kept as string for the input box; "" = blank
  tag: "1สาย1สู้" | "ทางผ่าน" | "";
  salesperson: string;
  fromSheet: boolean; // true if the Sheet already had this customer
  // Snapshot of what the Sheet actually had (or "" for a brand-new
  // customer) — compared against the live fields above at submit time to
  // decide whether this row needs writing back, so an unedited prefilled
  // row (e.g. distance "84" that came straight from the Sheet) is never
  // mistaken for an edit just because its field isn't blank.
  originalCustomerName: string;
  originalDistanceKm: string;
  originalTag: "1สาย1สู้" | "ทางผ่าน" | "";
  originalSalesperson: string;
}

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

type Step = "upload" | "confirm" | "result";

export default function Home() {
  const [step, setStep] = useState<Step>("upload");
  const [branchId, setBranchId] = useState(BRANCHES[0]?.id ?? "");
  const [meterTruckFiles, setMeterTruckFiles] = useState<FileList | null>(null);
  const [trailerFiles, setTrailerFiles] = useState<FileList | null>(null);
  const [pumpFillFiles, setPumpFillFiles] = useState<FileList | null>(null);
  const [arFile, setArFile] = useState<File | null>(null);

  const [periodLabel, setPeriodLabel] = useState("");
  const [periodLabelThai, setPeriodLabelThai] = useState("");
  const [arAsOfLabel, setArAsOfLabel] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CalcResponse | null>(null);
  const [resolveWarnings, setResolveWarnings] = useState<string[]>([]);

  const [roster, setRoster] = useState<string[]>([]);
  const [rows, setRows] = useState<ConfirmRow[]>([]);

  const branch = BRANCHES.find((b) => b.id === branchId);

  function collectFormFiles(): FormData {
    const form = new FormData();
    form.set("branchId", branchId);
    Array.from(meterTruckFiles ?? []).forEach((f) => form.append("meterTruckFiles", f));
    Array.from(trailerFiles ?? []).forEach((f) => form.append("trailerFiles", f));
    Array.from(pumpFillFiles ?? []).forEach((f) => form.append("pumpFillFiles", f));
    return form;
  }

  async function handleResolve(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const hasAnyFile = (meterTruckFiles?.length ?? 0) + (trailerFiles?.length ?? 0) + (pumpFillFiles?.length ?? 0) > 0;
    if (!hasAnyFile) {
      setError("กรุณาแนบไฟล์อย่างน้อย 1 ไฟล์ (รถมิเตอร์/รถเทรลเลอร์/กรอกหลังปั๊ม)");
      return;
    }
    if (!arFile) {
      setError("กรุณาเลือกไฟล์รายงานลูกหนี้ค้างชำระ (AR)");
      return;
    }
    if (!periodLabel || !periodLabelThai || !arAsOfLabel) {
      setError("กรุณากรอกข้อมูลงวด (เดือน/ปี และวันที่รายงานลูกหนี้)");
      return;
    }
    setLoading(true);
    try {
      const form = collectFormFiles();
      const res = await fetch("/api/resolve", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "ตรวจสอบข้อมูลไม่สำเร็จ");
        return;
      }
      setRoster(data.roster as string[]);
      setResolveWarnings(data.warnings as string[]);
      setRows(
        (data.customers as QualifyingCustomerPreview[]).map((c) => {
          const name = c.resolved?.customerName || c.customerName;
          const distance = c.resolved?.distanceKm != null ? String(c.resolved.distanceKm) : "";
          const tag = c.resolved?.tag ?? "";
          const salesperson = c.resolved?.salesperson ?? "";
          return {
            customerCode: c.customerCode,
            customerName: name,
            truckLabels: c.truckLabels,
            distanceKm: distance,
            tag,
            salesperson,
            fromSheet: c.resolved !== null,
            originalCustomerName: name,
            originalDistanceKm: distance,
            originalTag: tag,
            originalSalesperson: salesperson,
          };
        })
      );
      setStep("confirm");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function updateRow(idx: number, field: keyof ConfirmRow, value: string) {
    setRows((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value } as ConfirmRow;
      return next;
    });
  }

  const missingCount = rows.filter((r) => !r.salesperson.trim() || (r.tag === "" && !r.distanceKm.trim())).length;
  const missingSalespersonCount = rows.filter((r) => !r.salesperson.trim()).length;

  async function handleFinalize() {
    setError(null);
    if (missingSalespersonCount > 0) {
      setError(`มีลูกค้า ${missingSalespersonCount} รายที่ยังไม่ได้ระบุเซลล์ — กรุณากรอกให้ครบก่อนคำนวณ`);
      return;
    }
    setLoading(true);
    try {
      const form = collectFormFiles();
      if (arFile) form.set("arFile", arFile);
      form.set(
        "period",
        JSON.stringify({ periodLabel, periodLabelThai, arAsOfLabel, confirmDateLabel: new Date().toLocaleDateString("th-TH") })
      );
      // Union with whatever salesperson names actually got typed on this
      // confirmation page — a name not yet in the Sheet (e.g. the first
      // อุ้ย customer for a branch whose Sheet only has จุ่น so far) must
      // still count as a recognized เซลล์ for THIS run, or
      // commissionEngine's roster check would zero her commission out.
      const finalRoster = [...new Set([...roster, ...rows.map((r) => r.salesperson.trim()).filter(Boolean)])];
      form.set("roster", JSON.stringify(finalRoster));
      form.set(
        "confirmedCustomers",
        JSON.stringify(
          rows.map((r) => ({
            customerCode: r.customerCode,
            customerName: r.customerName,
            distanceKm: r.tag ? null : r.distanceKm.trim() ? Number(r.distanceKm) : null,
            tag: r.tag,
            salesperson: r.salesperson.trim(),
            edited:
              !r.fromSheet ||
              r.customerName !== r.originalCustomerName ||
              r.distanceKm !== r.originalDistanceKm ||
              r.tag !== r.originalTag ||
              r.salesperson.trim() !== r.originalSalesperson,
          }))
        )
      );
      const res = await fetch("/api/calculate", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "คำนวณไม่สำเร็จ");
        return;
      }
      setResult(data as CalcResponse);
      setStep("result");
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

  function startOver() {
    setStep("upload");
    setResult(null);
    setRows([]);
    setMeterTruckFiles(null);
    setTrailerFiles(null);
    setPumpFillFiles(null);
    setArFile(null);
  }

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-10 text-neutral-900">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">ระบบคำนวณค่าคอมมิชชั่นฝ่ายการตลาด</h1>
            <p className="mt-1 text-sm text-neutral-600">
              เลือกสาขา → อัปโหลดไฟล์แยกตามช่องทาง → ตรวจสอบ/แก้ไขข้อมูลลูกค้า → คำนวณและดาวน์โหลดไฟล์ Excel
            </p>
          </div>
          <Link href="/settings" className="whitespace-nowrap text-sm text-neutral-600 underline">
            ตั้งค่าลูกค้ายกเว้น →
          </Link>
        </header>

        {step === "upload" && (
          <form onSubmit={handleResolve} className="space-y-5 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
            <div>
              <label className="block text-sm font-medium">สาขา / BU</label>
              <select className="mt-1 w-full rounded border border-neutral-300 px-3 py-2 text-sm" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                {BRANCHES.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.companyName} — {b.label}
                  </option>
                ))}
              </select>
              {branch && <p className="mt-1 text-xs text-neutral-500">สินค้าที่นับ: {branch.fuelProductCodes.join(", ")} · เกณฑ์ ≥2,000 ลิตร (ทุกสาขาใช้กฎเดียวกัน)</p>}
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium">งวด (เช่น 8/69)</label>
                <input required className="mt-1 w-full rounded border border-neutral-300 px-2 py-2 text-sm" value={periodLabel} onChange={(e) => setPeriodLabel(e.target.value)} placeholder="8/69" />
              </div>
              <div>
                <label className="block text-sm font-medium">งวด (ไทย)</label>
                <input required className="mt-1 w-full rounded border border-neutral-300 px-2 py-2 text-sm" value={periodLabelThai} onChange={(e) => setPeriodLabelThai(e.target.value)} placeholder="ส.ค. 2569" />
              </div>
              <div>
                <label className="block text-sm font-medium">วันที่รายงานลูกหนี้</label>
                <input required className="mt-1 w-full rounded border border-neutral-300 px-2 py-2 text-sm" value={arAsOfLabel} onChange={(e) => setArAsOfLabel(e.target.value)} placeholder="7 ก.ย.69" />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium">รถมิเตอร์ (เลือกได้หลายไฟล์)</label>
              <input type="file" accept="application/pdf" multiple className="mt-1 w-full text-sm" onChange={(e) => setMeterTruckFiles(e.target.files)} />
              {meterTruckFiles && <p className="mt-1 text-xs text-neutral-500">เลือกแล้ว {meterTruckFiles.length} ไฟล์</p>}
            </div>
            <div>
              <label className="block text-sm font-medium">รถเทรลเลอร์ (เลือกได้หลายไฟล์)</label>
              <input type="file" accept="application/pdf" multiple className="mt-1 w-full text-sm" onChange={(e) => setTrailerFiles(e.target.files)} />
              {trailerFiles && <p className="mt-1 text-xs text-neutral-500">เลือกแล้ว {trailerFiles.length} ไฟล์</p>}
            </div>
            <div>
              <label className="block text-sm font-medium">กรอกหลังปั๊ม (เลือกได้หลายไฟล์)</label>
              <input type="file" accept="application/pdf" multiple className="mt-1 w-full text-sm" onChange={(e) => setPumpFillFiles(e.target.files)} />
              {pumpFillFiles && <p className="mt-1 text-xs text-neutral-500">เลือกแล้ว {pumpFillFiles.length} ไฟล์</p>}
            </div>
            <div>
              <label className="block text-sm font-medium">รายงานลูกหนี้ค้างชำระ *</label>
              <input type="file" accept="application/pdf" className="mt-1 w-full text-sm" onChange={(e) => setArFile(e.target.files?.[0] ?? null)} />
            </div>

            <button type="submit" disabled={loading} className="w-full rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {loading ? "กำลังตรวจสอบข้อมูล..." : "ตรวจสอบข้อมูล"}
            </button>
          </form>
        )}

        {step === "confirm" && (
          <div className="space-y-4 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
            <h2 className="font-semibold">
              ยืนยันข้อมูลลูกค้าก่อนคำนวณ ({rows.length} ราย{missingCount > 0 ? ` — ยังขาดข้อมูล ${missingCount} ราย` : ""})
            </h2>
            <p className="text-xs text-neutral-500">
              แถวสีเหลืองคือลูกค้าที่ยังไม่มีข้อมูลใน Google Sheet — กรุณากรอกระยะทาง/แท็ก/เซลล์ให้ครบ การแก้ไขที่นี่จะถูกบันทึกกลับเข้า Google Sheet เมื่อกดคำนวณ
            </p>
            <div className="max-h-[28rem] overflow-auto rounded border border-neutral-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-neutral-100">
                  <tr className="text-left text-xs text-neutral-600">
                    <th className="p-2">รหัส</th>
                    <th className="p-2">ชื่อลูกค้า</th>
                    <th className="p-2">ไฟล์</th>
                    <th className="p-2">ระยะทาง(กม.)</th>
                    <th className="p-2">Tag</th>
                    <th className="p-2">เซลล์</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, idx) => (
                    <tr key={r.customerCode} className={`border-t border-neutral-100 ${r.fromSheet ? "" : "bg-amber-50"}`}>
                      <td className="p-2 font-mono text-xs">{r.customerCode}</td>
                      <td className="p-2">
                        <input className="w-40 rounded border border-neutral-300 px-1 py-0.5 text-xs" value={r.customerName} onChange={(e) => updateRow(idx, "customerName", e.target.value)} />
                      </td>
                      <td className="p-2 text-xs text-neutral-500">{r.truckLabels.join(", ")}</td>
                      <td className="p-2">
                        <input
                          className="w-20 rounded border border-neutral-300 px-1 py-0.5 text-xs"
                          value={r.distanceKm}
                          disabled={r.tag !== ""}
                          onChange={(e) => updateRow(idx, "distanceKm", e.target.value)}
                        />
                      </td>
                      <td className="p-2">
                        <select className="rounded border border-neutral-300 px-1 py-0.5 text-xs" value={r.tag} onChange={(e) => updateRow(idx, "tag", e.target.value)}>
                          <option value="">—</option>
                          <option value="1สาย1สู้">1สาย1สู้</option>
                          <option value="ทางผ่าน">ทางผ่าน</option>
                        </select>
                      </td>
                      <td className="p-2">
                        <input
                          list="roster-options"
                          className="w-24 rounded border border-neutral-300 px-1 py-0.5 text-xs"
                          value={r.salesperson}
                          onChange={(e) => updateRow(idx, "salesperson", e.target.value)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <datalist id="roster-options">
                {roster.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
            {resolveWarnings.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-amber-700">คำเตือนจากการอ่านไฟล์ ({resolveWarnings.length})</summary>
                <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto rounded bg-amber-50 p-2">
                  {resolveWarnings.map((w, i) => (
                    <li key={i}>• {w}</li>
                  ))}
                </ul>
              </details>
            )}
            <div className="flex gap-2">
              <button onClick={() => setStep("upload")} className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium">
                ← กลับไปแก้ไฟล์
              </button>
              <button onClick={handleFinalize} disabled={loading} className="flex-1 rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {loading ? "กำลังคำนวณ..." : "ยืนยันและคำนวณ"}
              </button>
            </div>
          </div>
        )}

        {error && <div className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800">{error}</div>}

        {step === "result" && result && (
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

            <button onClick={downloadFile} className="w-full rounded bg-emerald-700 px-4 py-2 text-sm font-medium text-white">
              ดาวน์โหลดไฟล์ Excel ({result.filename})
            </button>
            <button onClick={startOver} className="w-full rounded border border-neutral-300 px-4 py-2 text-sm font-medium">
              คำนวณรอบใหม่
            </button>

            {result.warnings.length > 0 && (
              <details className="text-sm" open>
                <summary className="cursor-pointer font-medium text-amber-700">คำเตือน / สิ่งที่ต้องตรวจสอบก่อนส่งมอบ ({result.warnings.length})</summary>
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
