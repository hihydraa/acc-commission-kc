import { NextRequest, NextResponse } from "next/server";
import { getBranchById, BRANCHES } from "@/branches";
import { loadSettings, saveBranchOverride, effectiveEditableState, type QtyRule, type BranchOverride } from "@/lib/settings";
import type { ExcludedCustomer } from "@/branches/types";

export const runtime = "nodejs";

function isValidQtyRule(v: unknown): v is QtyRule {
  if (!v || typeof v !== "object") return false;
  const q = v as Record<string, unknown>;
  return typeof q.minQtyLiters === "number" && q.minQtyLiters >= 0 && typeof q.requireExactMultiple === "boolean" && typeof q.qtyMultipleOf === "number" && q.qtyMultipleOf > 0;
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
      validated[dept.code] = rule;
    }
    override.departmentQty = validated;
  } else {
    if (!isValidQtyRule(qty)) {
      return NextResponse.json({ error: "เกณฑ์ปริมาณไม่ถูกต้อง" }, { status: 400 });
    }
    override.qty = qty;
  }

  await saveBranchOverride(branchId, override);
  return NextResponse.json({ ok: true, updatedAt: override.updatedAt });
}
