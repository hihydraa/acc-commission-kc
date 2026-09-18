import { get, put } from "@vercel/blob";
import type { BranchConfig, ExcludedCustomer } from "@/branches/types";

/**
 * User-editable overrides on top of the hardcoded BranchConfig defaults in
 * src/branches/*.ts. As of 2026-09-18 qty thresholds and freight rules are
 * unified across every branch (src/lib/calc/channelRules.ts) and are no
 * longer branch settings — the only thing left here is each branch's
 * excluded-customer list (the exact kind of change this project has needed
 * repeatedly: KNDC0018, then KNDC2075/KNDC2151, then ST57039).
 *
 * Stored as a single small JSON blob in Vercel Blob (private access) rather
 * than a database — a single JSON file is the smallest amount of
 * persistence that still gives every accounting user on any device the
 * SAME shared settings, over localStorage.
 */

export interface BranchOverride {
  excludedCustomers: ExcludedCustomer[];
  pumpFillSalesperson: string | null;
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
  return {
    ...branch,
    // `override.excludedCustomers` can be missing/undefined for a settings
    // blob saved under the pre-2026-09-18 schema (department-scoped
    // exclusions, no flat top-level list — e.g. กระนวน's old shape never set
    // this field at all) — fall back to the branch's hardcoded list rather
    // than crashing every request that touches this branch.
    excludedCustomers: override.excludedCustomers ?? branch.excludedCustomers,
    // Explicit `null` in a saved override means "no fixed เซลล์, resolve per
    // customer as usual" and must win over the branch's own hardcoded
    // default — only an entirely absent field (a pre-existing override blob
    // saved before this setting existed) falls back to the hardcoded value.
    pumpFillSalesperson: override.pumpFillSalesperson !== undefined ? override.pumpFillSalesperson : branch.pumpFillSalesperson,
  };
}

/** The current editable state for one branch — either its stored override
 *  or its hardcoded defaults, for the /settings page to render and the API
 *  to seed a fresh override from. */
export function effectiveEditableState(branch: BranchConfig, override: BranchOverride | undefined) {
  return {
    excludedCustomers: override?.excludedCustomers ?? branch.excludedCustomers,
    pumpFillSalesperson: override?.pumpFillSalesperson !== undefined ? override.pumpFillSalesperson : branch.pumpFillSalesperson,
    updatedAt: override?.updatedAt ?? null,
    updatedBy: override?.updatedBy ?? null,
  };
}
