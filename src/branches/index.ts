import { samthongBranch } from "./samthong";
import { kranuanBranch } from "./kranuan";
import { mukdahanBranch } from "./mukdahan";
import { wanonniwatBranch } from "./wanonniwat";

export const BRANCHES = [samthongBranch, kranuanBranch, mukdahanBranch, wanonniwatBranch];

export function getBranchById(id: string) {
  return BRANCHES.find((b) => b.id === id) ?? null;
}
