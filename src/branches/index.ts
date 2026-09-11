import { samthongBranch } from "./samthong";
import { kranuanBranch } from "./kranuan";

export const BRANCHES = [samthongBranch, kranuanBranch];

export function getBranchById(id: string) {
  return BRANCHES.find((b) => b.id === id) ?? null;
}
