"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BRANCHES } from "@/branches";

interface ExcludedCustomer {
  customerCode: string;
  customerName: string;
  reason: string;
}

interface SettingsResponse {
  branch: { id: string; label: string; companyName: string };
  excludedCustomers: ExcludedCustomer[];
  pumpFillSalesperson: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

function validateExcludedCustomers(rows: ExcludedCustomer[]): string | null {
  const codes = rows.map((c) => c.customerCode.trim().toUpperCase());
  if (codes.some((c) => !c)) return "มีแถวลูกค้าที่ยกเว้นที่ยังไม่ได้กรอกรหัสลูกค้า";
  if (new Set(codes).size !== codes.length) return "มีรหัสลูกค้าที่ยกเว้นซ้ำกัน";
  return null;
}

export default function SettingsPage() {
  const [branchId, setBranchId] = useState(BRANCHES[0]?.id ?? "");
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [updatedBy, setUpdatedBy] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      setSavedAt(null);
      try {
        const res = await fetch(`/api/settings?branchId=${encodeURIComponent(branchId)}`);
        const json = await res.json();
        if (cancelled) return;
        if (json.error) {
          setError(json.error);
          setData(null);
        } else {
          setData(json as SettingsResponse);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [branchId]);

  function updateRow(idx: number, field: keyof ExcludedCustomer, value: string) {
    if (!data) return;
    const next = [...data.excludedCustomers];
    next[idx] = { ...next[idx], [field]: value };
    setData({ ...data, excludedCustomers: next });
  }
  function addRow() {
    if (!data) return;
    setData({ ...data, excludedCustomers: [...data.excludedCustomers, { customerCode: "", customerName: "", reason: "" }] });
  }
  function removeRow(idx: number) {
    if (!data) return;
    setData({ ...data, excludedCustomers: data.excludedCustomers.filter((_, i) => i !== idx) });
  }

  async function handleSave() {
    if (!data) return;
    setError(null);
    setSaving(true);
    try {
      const err = validateExcludedCustomers(data.excludedCustomers);
      if (err) {
        setError(err);
        return;
      }
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId,
          excludedCustomers: data.excludedCustomers,
          pumpFillSalesperson: data.pumpFillSalesperson,
          updatedBy: updatedBy || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "บันทึกไม่สำเร็จ");
        return;
      }
      setSavedAt(json.updatedAt);
      setData({ ...data, updatedAt: json.updatedAt, updatedBy: updatedBy || data.updatedBy });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-10 text-neutral-900">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">ตั้งค่าลูกค้าที่ยกเว้นจากค่าคอม</h1>
            <p className="mt-1 text-sm text-neutral-600">
              แก้ไขได้โดยไม่ต้องแก้โค้ด — มีผลทันทีกับการคำนวณครั้งถัดไปของทุกคน (เกณฑ์ปริมาณและค่าขนส่งใช้กฎเดียวกันทุกสาขาแล้ว ไม่มีให้ตั้งค่าต่อสาขาอีกต่อไป — ดูที่ src/lib/calc/channelRules.ts)
            </p>
          </div>
          <Link href="/" className="whitespace-nowrap text-sm text-neutral-600 underline">
            ← กลับหน้าคำนวณ
          </Link>
        </header>

        <div className="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
          <label className="block text-sm font-medium">สาขา / BU</label>
          <select className="mt-1 w-full rounded border border-neutral-300 px-3 py-2 text-sm" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            {BRANCHES.map((b) => (
              <option key={b.id} value={b.id}>
                {b.companyName} — {b.label}
              </option>
            ))}
          </select>
        </div>

        {loading && <div className="text-sm text-neutral-500">กำลังโหลด...</div>}
        {error && <div className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800">{error}</div>}

        {data && !loading && (
          <>
            <div className="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
              <h2 className="font-semibold">เซลล์ประจำช่องทางกรอกหลังปั๊ม</h2>
              <p className="mt-1 text-xs text-neutral-500">
                ถ้ากรอกชื่อไว้ ลูกค้ากรอกหลังปั๊มทุกรายของสาขานี้จะถูกนับเป็นของเซลล์คนนี้ทั้งหมด ไม่ต้องยืนยันทีละราย — เว้นว่างไว้ถ้าช่องทางนี้ต้องแยกเซลล์ตามลูกค้า (เช่น วานรนิวาส)
              </p>
              <input
                placeholder="เช่น อ้อม (เว้นว่าง = แยกตามลูกค้า)"
                className="mt-2 w-full rounded border border-neutral-300 px-3 py-2 text-sm"
                value={data.pumpFillSalesperson ?? ""}
                onChange={(e) => setData({ ...data, pumpFillSalesperson: e.target.value || null })}
              />
            </div>

            <div className="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">ลูกค้าที่ยกเว้นจากค่าคอมการตลาด</h2>
                <button onClick={addRow} className="rounded bg-neutral-100 px-3 py-1 text-xs font-medium hover:bg-neutral-200">
                  + เพิ่มลูกค้า
                </button>
              </div>
              <div className="mt-3 space-y-2">
                {data.excludedCustomers.length === 0 && <p className="text-sm text-neutral-500">ไม่มีลูกค้าที่ยกเว้น</p>}
                {data.excludedCustomers.map((c, idx) => (
                  <div key={idx} className="grid grid-cols-[1fr_1.2fr_1.6fr_auto] items-start gap-2">
                    <input placeholder="รหัสลูกค้า" className="rounded border border-neutral-300 px-2 py-1 text-sm" value={c.customerCode} onChange={(e) => updateRow(idx, "customerCode", e.target.value)} />
                    <input placeholder="ชื่อลูกค้า" className="rounded border border-neutral-300 px-2 py-1 text-sm" value={c.customerName} onChange={(e) => updateRow(idx, "customerName", e.target.value)} />
                    <input placeholder="เหตุผลที่ยกเว้น" className="rounded border border-neutral-300 px-2 py-1 text-sm" value={c.reason} onChange={(e) => updateRow(idx, "reason", e.target.value)} />
                    <button onClick={() => removeRow(idx)} className="rounded px-2 py-1 text-xs text-red-700 hover:bg-red-50">
                      ลบ
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
              <label className="block text-sm font-medium">ชื่อผู้แก้ไข (ไม่บังคับ)</label>
              <input placeholder="เช่น ชื่อผู้แก้ไข" className="mt-1 w-full rounded border border-neutral-300 px-3 py-2 text-sm" value={updatedBy} onChange={(e) => setUpdatedBy(e.target.value)} />
              {data.updatedAt && (
                <p className="mt-2 text-xs text-neutral-500">
                  แก้ไขล่าสุด: {new Date(data.updatedAt).toLocaleString("th-TH")}
                  {data.updatedBy ? ` โดย ${data.updatedBy}` : ""}
                </p>
              )}
              <button onClick={handleSave} disabled={saving} className="mt-4 w-full rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {saving ? "กำลังบันทึก..." : "บันทึกการตั้งค่า"}
              </button>
              {savedAt && <p className="mt-2 text-sm text-emerald-700">บันทึกสำเร็จ — มีผลกับการคำนวณครั้งถัดไปทันที</p>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
