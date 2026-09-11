import Decimal from "decimal.js";
import { roundHalfUp2 } from "./rounding";

/**
 * Team-split ratios are per-branch config (marketing-commission-calc SKILL:
 * "ตัวอย่างสาขาสามทอง/โลจิสติกส์: ผู้จัดการ 10% / เจ้าของยอด 60% / ADMIN 20% /
 * ส่วนกลาง 10% — สาขาอื่นสัดส่วนอาจไม่เหมือนกัน"). Exactly one role is the
 * "remainder" role (เจ้าหน้าที่การตลาด / เจ้าของยอด) that receives
 * `net - sum(other rounded shares)` rather than `round(net * its own %)` —
 * rounding every share independently can drift the total by a few สตางค์
 * away from net; giving one role the remainder guarantees the shares always
 * sum to net exactly.
 */
export interface TeamSplitRole {
  key: string;
  label: string;
  percent: number; // ignored for the remainder role
  isRemainder?: boolean;
}

export interface TeamSplitConfig {
  roles: TeamSplitRole[];
}

export interface TeamSplitResult {
  net: number;
  shares: { key: string; label: string; amount: number }[];
}

export function splitTeam(netRounded: number, config: TeamSplitConfig): TeamSplitResult {
  const net = new Decimal(netRounded);
  const remainderRole = config.roles.find((r) => r.isRemainder);
  if (!remainderRole) {
    throw new Error("TeamSplitConfig ต้องมี role ที่ isRemainder=true พอดี 1 รายการ");
  }

  let sumOfFixedShares = new Decimal(0);
  const shares: { key: string; label: string; amount: number }[] = [];
  for (const role of config.roles) {
    if (role.isRemainder) continue;
    const amount = roundHalfUp2(net.times(role.percent));
    sumOfFixedShares = sumOfFixedShares.plus(amount);
    shares.push({ key: role.key, label: role.label, amount });
  }
  const remainderAmount = roundHalfUp2(net.minus(sumOfFixedShares));
  shares.push({ key: remainderRole.key, label: remainderRole.label, amount: remainderAmount });

  // restore config order (remainder role may not have been last in config.roles)
  const orderedShares = config.roles.map((r) => shares.find((s) => s.key === r.key)!);

  return { net: netRounded, shares: orderedShares };
}
