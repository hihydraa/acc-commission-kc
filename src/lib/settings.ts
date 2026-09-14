import { get, put } from "@vercel/blob";
import type { BranchConfig, ExcludedCustomer } from "@/branches/types";

/**
 * User-editable overrides on top of the hardcoded BranchConfig defaults in
 * src/branches/*.ts — lets accounting adjust excluded-customer lists, qty
 * thresholds, and per-department fixed-เซลล์ assignments from a /settings
 * page without a code change + redeploy for every small tweak (the exact
 * kind of change this project has needed repeatedly: KNDC0018, then
 * KNDC2075/KNDC2151, then B3's threshold itself, then which เซลล์ owns
 * กรอกหลังปั๊ม).
 *
 * Stored as a single small JSON blob in Vercel Blob (private access) rather
 * than a database — this project is otherwise intentionally stateless
 * (README: "ไม่มีฐานข้อมูล"), and a single JSON file is the smallest amount
 * of persistence that still gives every accounting user on any device the
 * SAME shared settings, which is what was asked for over localStorage.
 *
 * A branch can be a HYBRID of both models — สามทอง has flat qty rules for
 * its regular trucks (filename-classified) AND a "departments" entry for
 * its กรอกหลังปั๊ม channel (classified by the file's own "เลือกแผนก" header) —
 * so `qty` and `departmentQty` are independent, not mutually exclusive:
 * presence is decided by whether the branch has flat fields / a departments
 * array at all, never by which one "wins".
 */

export interface QtyRule {
  minQtyLiters: number;
  requireExactMultiple: boolean;
  qtyMultipleOf: number;
  /** only meaningful for a department whose hardcoded config already has a
   *  fixedSalesperson (e.g. กรอกหลังปั๊ม) — omitted/null for departments that
   *  resolve เซลล์ via the master file as usual (A7/B7/68) */
  fixedSalesperson?: string | null;
}

export interface BranchOverride {
  excludedCustomers: ExcludedCustomer[];
  /** present only for branches with flat minQtyLiters/etc (สามทอง's regular trucks) */
  qty?: QtyRule;
  /** present only for branches with a departments array, keyed by DepartmentConfig.code */
  departmentQty?: Record<string, QtyRule>;
  updatedAt: string;
  updatedBy?: string;
}

export type SettingsStore = Record<string, BranchOverride>;

const SETTINGS_PATHNAME = "settings/branch-overrides.json";

export async function loadSettings(): Promise<SettingsStore> {
  try {
    // useCache defaults to true (serves from Vercel's CDN) — a settings
    // change must be visible on the very next request, not whenever the
    // CDN's cache happens to expire, so always read straight from origin.
    const result = await get(SETTINGS_PATHNAME, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200) return {};
    const text = await new Response(result.stream).text();
    if (!text) return {};
    return JSON.parse(text) as SettingsStore;
  } catch {
    // No blob written yet, or a transient read error — treat as "no
    // overrides yet" rather than failing the whole request; the branch's
    // hardcoded defaults remain a safe fallback either way.
    return {};
  }
}

export async function saveBranchOverride(branchId: string, override: BranchOverride): Promise<void> {
  const current = await loadSettings();
  current[branchId] = override;
  await put(SETTINGS_PATHNAME, JSON.stringify(current, null, 2), {
    access: "private",
    contentType: "application/json",
    allowOverwrite: true,
    addRandomSuffix: false,
  });
}

/** Merges a stored override onto a branch's hardcoded config for one
 *  calculation run — never mutates the imported config object. */
export function applyBranchOverride(branch: BranchConfig, override: BranchOverride | undefined): BranchConfig {
  if (!override) return branch;
  const next: BranchConfig = { ...branch, excludedCustomers: override.excludedCustomers ?? branch.excludedCustomers };

  if (branch.minQtyLiters !== undefined && override.qty) {
    next.minQtyLiters = override.qty.minQtyLiters;
    next.requireExactMultiple = override.qty.requireExactMultiple;
    next.qtyMultipleOf = override.qty.qtyMultipleOf;
  }

  if (branch.departments && override.departmentQty) {
    next.departments = branch.departments.map((d) => {
      const o = override.departmentQty?.[d.code];
      if (!o) return d;
      return {
        ...d,
        minQtyLiters: o.minQtyLiters,
        requireExactMultiple: o.requireExactMultiple,
        qtyMultipleOf: o.qtyMultipleOf,
        // Only a department that already has a fixed เซลล์ concept
        // (fixedSalesperson !== null in the hardcoded config) can have it
        // overridden — never let a settings payload turn a normal
        // master-lookup department into a fixed-เซลล์ one or vice versa.
        fixedSalesperson: d.fixedSalesperson !== null ? (o.fixedSalesperson ?? d.fixedSalesperson) : null,
      };
    });
  }

  return next;
}

/** The current editable state for one branch — either its stored override
 *  or its hardcoded defaults, in the same shape either way, for the
 *  /settings page to render and the API to seed a fresh override from. */
export function effectiveEditableState(branch: BranchConfig, override: BranchOverride | undefined) {
  const hasFlat = branch.minQtyLiters !== undefined;
  const hasDepartments = !!branch.departments;
  return {
    excludedCustomers: override?.excludedCustomers ?? branch.excludedCustomers,
    qty: hasFlat
      ? {
          minQtyLiters: override?.qty?.minQtyLiters ?? branch.minQtyLiters ?? 0,
          requireExactMultiple: override?.qty?.requireExactMultiple ?? branch.requireExactMultiple ?? false,
          qtyMultipleOf: override?.qty?.qtyMultipleOf ?? branch.qtyMultipleOf ?? 1000,
        }
      : null,
    // Merged per-field (not a blind "stored override wins wholesale") so an
    // override saved before `fixedSalesperson` existed still falls back to
    // the hardcoded default for that one field instead of showing blank.
    departmentQty: hasDepartments
      ? Object.fromEntries(
          branch.departments!.map((d) => {
            const stored = override?.departmentQty?.[d.code];
            return [
              d.code,
              {
                minQtyLiters: stored?.minQtyLiters ?? d.minQtyLiters,
                requireExactMultiple: stored?.requireExactMultiple ?? d.requireExactMultiple,
                qtyMultipleOf: stored?.qtyMultipleOf ?? d.qtyMultipleOf,
                fixedSalesperson: d.fixedSalesperson !== null ? stored?.fixedSalesperson ?? d.fixedSalesperson : null,
              },
            ];
          })
        )
      : null,
    updatedAt: override?.updatedAt ?? null,
    updatedBy: override?.updatedBy ?? null,
  };
}
