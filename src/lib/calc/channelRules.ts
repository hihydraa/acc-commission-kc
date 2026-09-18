import type { TeamSplitConfig } from "./teamSplit";
import type { CommissionThresholds } from "./commissionEngine";

/**
 * Universal rules shared by EVERY branch (confirmed with the user
 * 2026-09-18, superseding สามทอง/กระนวน's earlier divergent per-branch
 * numbers) — the marketing-commission-calc method never actually depended
 * on the branch, only on which of two CHANNELS a file belongs to. There are
 * exactly two:
 *
 * - "deliveryRoute": รถมิเตอร์ (numbered delivery trucks), รถเทรลเลอร์
 *   (trailers), and any externally-contracted truck ("รถนอก", confirmed
 *   real for วานรนิวาส) — all three already computed identically (distance
 *   -> DEFAULT_FREIGHT_TIERS lookup, same qty rule); they only ever differed
 *   in which label ("รถ 55" vs "เทรลเลอร์ 73") a truck's sheet got, which is
 *   now decided by which of the 3 upload inputs a file was dropped into,
 *   not by inferring it from a filename or an in-file "เลือกแผนก" header.
 * - "pumpFill": กรอกหลังปั๊ม — fixed ค่าขนส่ง/ลิตร, no distance needed, every
 *   liter counts (already กระนวน's B3 rule; now universal).
 *
 * The qty rule below is กระนวน's (≥2,000 ลิตร, no exact-multiple-of-1,000
 * requirement) — the user's explicit choice overriding สามทอง's stricter
 * rule for BOTH existing branches going forward, not just new ones.
 */
export interface ChannelRule {
  minQtyLiters: number;
  requireExactMultiple: boolean;
  qtyMultipleOf: number;
  /** null = look up DEFAULT_FREIGHT_TIERS by distance; a number overrides
   *  the table entirely with a fixed ค่าขนส่ง/ลิตร */
  fixedFreightRate: number | null;
}

export const DELIVERY_ROUTE_RULE: ChannelRule = {
  minQtyLiters: 2000,
  requireExactMultiple: false,
  qtyMultipleOf: 1000,
  fixedFreightRate: null,
};

export const PUMP_FILL_RULE: ChannelRule = {
  minQtyLiters: 0,
  requireExactMultiple: false,
  qtyMultipleOf: 1000,
  fixedFreightRate: 0.1,
};

/**
 * The confirmation page (src/app/confirm) is what "freightMissingBehavior:
 * block" used to mean per-branch — nothing reaches final calculation with
 * an unresolved distance/เซลล์ any more, for any branch, so that toggle no
 * longer exists. commissionEngine.calculateTransaction now always blocks a
 * qualifying row with no resolvable ค่าขนส่ง/ลิตร instead of ever
 * defaulting it to 0.
 */

/** identical across every branch's own approved Incentive-policy reference
 *  (สามทอง/กระนวน/มุกดาหาร/วานรนิวาส all show the same thresholds/rate/split —
 *  same corporate policy, not a coincidence worth re-deriving per branch) */
export const SHARED_THRESHOLDS: CommissionThresholds = { cash: 0.2, credit: 0.3, overdue: 0.6 };
export const SHARED_RATE_PER_LITER = 0.03;
export const SHARED_PENALTY_NEGATIVE_Q_ENABLED = true;
export const SHARED_DOC_PREFIX_TO_SALE_TYPE: Record<string, "cash" | "credit"> = { H: "cash", I: "credit" };

/** one canonical label set — สามทอง/กระนวน's real approved workbooks used
 *  slightly different wording (extra parenthetical, a stray space) for the
 *  same percentages; this is the wording going forward for every branch. */
export const SHARED_TEAM_SPLIT: TeamSplitConfig = {
  roles: [
    { key: "manager", label: "ผู้จัดการ เค.ซี.ปิโตรเลียม", percent: 0.1 },
    { key: "sales", label: "เจ้าหน้าที่การตลาด (เจ้าของยอด)", percent: 0.6, isRemainder: true },
    { key: "admin", label: "ADMIN (บัญชีสาขา,ธุรการ,คลังน้ำมัน)", percent: 0.2 },
    { key: "central", label: "ส่วนกลางการตลาด", percent: 0.1 },
  ],
};
