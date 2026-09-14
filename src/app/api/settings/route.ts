import { NextRequest, NextResponse } from "next/server";
import { getBranchById, BRANCHES } from "@/branches";
import { loadSettings, saveBranchOverride, effectiveEditableState, type QtyRule, type BranchOverride } from "@/lib/settings";
import type { ExcludedCustomer } from "@/branches/types";

export const runtime = "nodejs";

function isValidQtyRule(v: unknown): v is QtyRule {
  if (!v || typeof v !== "object") return false;
  const q = v as Record<string, unknown>;
  if (typeof q.minQtyLiters !== "number" || q.minQtyLiters < 0) return false;
  if (typeof q.requireExactMultiple !== "boolean") return false;
  if (typeof q.qtyMultipleOf !== "number" || q.qtyMultipleOf <= 0) return false;
  if (q.fixedSalesperson !== undefined && q.fixedSalesperson !== null && typeof q.fixedSalesperson !== "string") return false;
  return true;
}

function isValidExcludedCustomers(v: unknown): v is ExcludedCustomer[] {
  if (!Array.isArray(v)) return false;
  const codes = new Set<string>();
  for (const row of v) {
    if (!row || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    if (typeof r.customerCode !== "string" || !r.customerCode.trim()) return false;
    if (typeof r.customerName !== "string") return false;
    if (typeof r.reason !== "string") return false;
    const code = r.customerCode.trim().toUpperCase();
    if (codes.has(code)) return false; // no duplicates
    codes.add(code);
  }
  return true;
}

export async function GET(request: NextRequest) {
  const branchId = request.nextUrl.searchParams.get("branchId");
  const settings = await loadSettings();

  if (!branchId) {
    return NextResponse.json({ branches: BRANCHES.map((b) => ({ id: b.id, label: b.label, companyName: b.companyName })) });
  }
  const branch = getBranchById(branchId);
  if (!branch) {
    return NextResponse.json({ error: `ไม่พบสาขา '${branchId}'` }, { status: 400 });
  }
  const state = effectiveEditableState(branch, settings[branchId]);
  return NextResponse.json({
    branch: {
      id: branch.id,
      label: branch.label,
      companyName: branch.companyName,
      departments: branch.departments?.map((d) => ({ code: d.code, label: d.label })) ?? null,
    },
    ...state,
  });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "ข้อมูลที่ส่งมาไม่ใช่ JSON ที่ถูกต้อง" }, { status: 400 });
  }
  const { branchId, excludedCustomers, qty, departmentQty, updatedBy } = (body ?? {}) as Record<string, unknown>;

  if (typeof branchId !== "string") {
    return NextResponse.json({ error: "ไม่ได้ระบุสาขา (branchId)" }, { status: 400 });
  }
  const branch = getBranchById(branchId);
  if (!branch) {
    return NextResponse.json({ error: `ไม่พบสาขา '${branchId}'` }, { status: 400 });
  }
  if (!isValidExcludedCustomers(excludedCustomers)) {
    return NextResponse.json({ error: "รายชื่อลูกค้าที่ยกเว้นไม่ถูกต้อง (ตรวจสอบรหัสลูกค้าซ้ำ หรือช่องว่าง)" }, { status: 400 });
  }

  const override: BranchOverride = {
    excludedCustomers: excludedCustomers.map((c) => ({ customerCode: c.customerCode.trim().toUpperCase(), customerName: c.customerName.trim(), reason: c.reason.trim() })),
    updatedAt: new Date().toISOString(),
    updatedBy: typeof updatedBy === "string" && updatedBy.trim() ? updatedBy.trim() : undefined,
  };

  // A branch can be a hybrid (สามทอง: flat rules for its regular trucks +
  // a departments entry for กรอกหลังปั๊ม) — these are independent, not
  // mutually exclusive, so both get validated/saved when both apply.
  if (branch.minQtyLiters !== undefined) {
    if (!isValidQtyRule(qty)) {
      return NextResponse.json({ error: "เกณฑ์ปริมาณไม่ถูกต้อง" }, { status: 400 });
    }
    override.qty = { minQtyLiters: qty.minQtyLiters, requireExactMultiple: qty.requireExactMultiple, qtyMultipleOf: qty.qtyMultipleOf };
  }

  if (branch.departments) {
    if (!departmentQty || typeof departmentQty !== "object") {
      return NextResponse.json({ error: "ไม่ได้ระบุเกณฑ์ปริมาณต่อแผนก (departmentQty)" }, { status: 400 });
    }
    const dq = departmentQty as Record<string, unknown>;
    const validated: Record<string, QtyRule> = {};
    for (const dept of branch.departments) {
      const rule = dq[dept.code];
      if (!isValidQtyRule(rule)) {
        return NextResponse.json({ error: `เกณฑ์ปริมาณของแผนก '${dept.label}' (${dept.code}) ไม่ถูกต้อง` }, { status: 400 });
      }
      validated[dept.code] = {
        minQtyLiters: rule.minQtyLiters,
        requireExactMultiple: rule.requireExactMultiple,
        qtyMultipleOf: rule.qtyMultipleOf,
        // Only departments that already have a fixed เซลล์ concept can have
        // one saved — ignore the field entirely for A7/B7/68-style
        // departments even if the client sent one.
        fixedSalesperson: dept.fixedSalesperson !== null ? (typeof rule.fixedSalesperson === "string" ? rule.fixedSalesperson.trim() || null : dept.fixedSalesperson) : null,
      };
    }
    override.departmentQty = validated;
  }

  await saveBranchOverride(branchId, override);
  return NextResponse.json({ ok: true, updatedAt: override.updatedAt });
}
