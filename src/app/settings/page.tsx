"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BRANCHES } from "@/branches";

interface QtyRule {
  minQtyLiters: number;
  requireExactMultiple: boolean;
  qtyMultipleOf: number;
  fixedSalesperson?: string | null;
}

interface ExcludedCustomer {
  customerCode: string;
  customerName: string;
  reason: string;
}

interface SettingsResponse {
  branch: { id: string; label: string; companyName: string; departments: { code: string; label: string }[] | null };
  excludedCustomers: ExcludedCustomer[];
  qty: QtyRule | null;
  departmentQty: Record<string, QtyRule> | null;
  updatedAt: string | null;
  updatedBy: string | null;
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

  function updateExcludedRow(idx: number, field: keyof ExcludedCustomer, value: string) {
    if (!data) return;
    const rows = [...data.excludedCustomers];
    rows[idx] = { ...rows[idx], [field]: value };
    setData({ ...data, excludedCustomers: rows });
  }

  function addExcludedRow() {
    if (!data) return;
    setData({ ...data, excludedCustomers: [...data.excludedCustomers, { customerCode: "", customerName: "", reason: "" }] });
  }

  function removeExcludedRow(idx: number) {
    if (!data) return;
    setData({ ...data, excludedCustomers: data.excludedCustomers.filter((_, i) => i !== idx) });
  }

  function updateFlatQty(field: keyof QtyRule, value: number | boolean) {
    if (!data || !data.qty) return;
    setData({ ...data, qty: { ...data.qty, [field]: value } });
  }

  function updateDeptQty(code: string, field: keyof QtyRule, value: number | boolean | string) {
    if (!data || !data.departmentQty) return;
    setData({ ...data, departmentQty: { ...data.departmentQty, [code]: { ...data.departmentQty[code], [field]: value } } });
  }

  async function handleSave() {
    if (!data) return;
    setError(null);
    setSaving(true);
    try {
      const codes = data.excludedCustomers.map((c) => c.customerCode.trim().toUpperCase());
      if (codes.some((c) => !c)) {
        setError("มีแถวลูกค้าที่ยกเว้นที่ยังไม่ได้กรอกรหัสลูกค้า");
        return;
      }
      if (new Set(codes).size !== codes.length) {
        setError("มีรหัสลูกค้าที่ยกเว้นซ้ำกัน");
        return;
      }
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId,
          excludedCustomers: data.excludedCustomers,
          qty: data.qty,
          departmentQty: data.departmentQty,
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
            <h1 className="text-2xl font-bold">ตั้งค่าเงื่อนไขการคำนวณ</h1>
            <p className="mt-1 text-sm text-neutral-600">แก้ไขรายชื่อลูกค้าที่ยกเว้น และเกณฑ์ปริมาณ โดยไม่ต้องแก้โค้ด — มีผลทันทีกับการคำนวณครั้งถัดไปของทุกคน</p>
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
              <h2 className="font-semibold">เกณฑ์ปริมาณ</h2>
              {data.qty && (
                <div className="mt-3">
                  {data.departmentQty && <p className="mb-1 text-xs font-medium text-neutral-500">รถทั่วไป (ไฟล์ที่ไม่ตรงกับแผนกด้านล่าง)</p>}
                  <div className="grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <label className="block text-xs text-neutral-500">ปริมาณขั้นต่ำ (ลิตร/บิล)</label>
                    <input
                      type="number"
                      min={0}
                      className="mt-1 w-full rounded border border-neutral-300 px-2 py-1"
                      value={data.qty.minQtyLiters}
                      onChange={(e) => updateFlatQty("minQtyLiters", Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-500">ต้องลงท้ายพันพอดี</label>
                    <select
                      className="mt-1 w-full rounded border border-neutral-300 px-2 py-1"
                      value={data.qty.requireExactMultiple ? "yes" : "no"}
                      onChange={(e) => updateFlatQty("requireExactMultiple", e.target.value === "yes")}
                    >
                      <option value="no">ไม่ต้อง</option>
                      <option value="yes">ต้อง</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-500">หารลงตัวด้วย (ลิตร)</label>
                    <input
                      type="number"
                      min={1}
                      className="mt-1 w-full rounded border border-neutral-300 px-2 py-1"
                      value={data.qty.qtyMultipleOf}
                      onChange={(e) => updateFlatQty("qtyMultipleOf", Number(e.target.value))}
                      disabled={!data.qty.requireExactMultiple}
                    />
                  </div>
                  </div>
                </div>
              )}
              {data.departmentQty && data.branch.departments && (
                <>
                  {data.qty && <p className="mb-1 mt-4 text-xs font-medium text-neutral-500">แยกตามแผนก</p>}
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-neutral-500">
                        <th className="pb-1 pr-2">แผนก</th>
                        <th className="pb-1 pr-2">ปริมาณขั้นต่ำ (ลิตร/บิล)</th>
                        <th className="pb-1 pr-2">ต้องลงท้ายพันพอดี</th>
                        <th className="pb-1 pr-2">หารลงตัวด้วย</th>
                        <th className="pb-1">เซลล์คงที่ทั้งแผนก</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.branch.departments.map((d) => {
                        const rule = data.departmentQty![d.code];
                        return (
                          <tr key={d.code} className="border-t border-neutral-100">
                            <td className="py-1.5 pr-2 font-medium">
                              {d.label} ({d.code})
                            </td>
                            <td className="py-1.5 pr-2">
                              <input
                                type="number"
                                min={0}
                                className="w-28 rounded border border-neutral-300 px-2 py-1"
                                value={rule.minQtyLiters}
                                onChange={(e) => updateDeptQty(d.code, "minQtyLiters", Number(e.target.value))}
                              />
                            </td>
                            <td className="py-1.5 pr-2">
                              <select
                                className="rounded border border-neutral-300 px-2 py-1"
                                value={rule.requireExactMultiple ? "yes" : "no"}
                                onChange={(e) => updateDeptQty(d.code, "requireExactMultiple", e.target.value === "yes")}
                              >
                                <option value="no">ไม่ต้อง</option>
                                <option value="yes">ต้อง</option>
                              </select>
                            </td>
                            <td className="py-1.5 pr-2">
                              <input
                                type="number"
                                min={1}
                                className="w-24 rounded border border-neutral-300 px-2 py-1"
                                value={rule.qtyMultipleOf}
                                onChange={(e) => updateDeptQty(d.code, "qtyMultipleOf", Number(e.target.value))}
                                disabled={!rule.requireExactMultiple}
                              />
                            </td>
                            <td className="py-1.5">
                              {rule.fixedSalesperson !== null && rule.fixedSalesperson !== undefined ? (
                                <input
                                  placeholder="ชื่อเซลล์"
                                  className="w-32 rounded border border-neutral-300 px-2 py-1"
                                  value={rule.fixedSalesperson}
                                  onChange={(e) => updateDeptQty(d.code, "fixedSalesperson", e.target.value)}
                                />
                              ) : (
                                <span className="text-xs text-neutral-400">— (หาจากไฟล์ master)</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                </>
              )}
            </div>

            <div className="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">ลูกค้าที่ยกเว้นจากค่าคอม</h2>
                <button onClick={addExcludedRow} className="rounded bg-neutral-100 px-3 py-1 text-xs font-medium hover:bg-neutral-200">
                  + เพิ่มลูกค้า
                </button>
              </div>
              <div className="mt-3 space-y-2">
                {data.excludedCustomers.length === 0 && <p className="text-sm text-neutral-500">ไม่มีลูกค้าที่ยกเว้น</p>}
                {data.excludedCustomers.map((c, idx) => (
                  <div key={idx} className="grid grid-cols-[1fr_1.2fr_1.6fr_auto] items-start gap-2">
                    <input
                      placeholder="รหัสลูกค้า"
                      className="rounded border border-neutral-300 px-2 py-1 text-sm"
                      value={c.customerCode}
                      onChange={(e) => updateExcludedRow(idx, "customerCode", e.target.value)}
                    />
                    <input
                      placeholder="ชื่อลูกค้า"
                      className="rounded border border-neutral-300 px-2 py-1 text-sm"
                      value={c.customerName}
                      onChange={(e) => updateExcludedRow(idx, "customerName", e.target.value)}
                    />
                    <input
                      placeholder="เหตุผลที่ยกเว้น"
                      className="rounded border border-neutral-300 px-2 py-1 text-sm"
                      value={c.reason}
                      onChange={(e) => updateExcludedRow(idx, "reason", e.target.value)}
                    />
                    <button onClick={() => removeExcludedRow(idx)} className="rounded px-2 py-1 text-xs text-red-700 hover:bg-red-50">
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
              <button
                onClick={handleSave}
                disabled={saving}
                className="mt-4 w-full rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
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
