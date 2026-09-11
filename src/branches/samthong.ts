import { DEFAULT_FREIGHT_TIERS } from "@/lib/calc/freightTable";
import type { BranchConfig } from "./types";

/**
 * สาขาสามทอง/โลจิสติกส์ — the branch marketing-commission-calc SKILL.md was
 * built from and regression-tested against (ST_8.69, ส.ค. 2569, approved).
 */
export const samthongBranch: BranchConfig = {
  id: "samthong",
  label: "สามทอง/โลจิสติกส์",
  companyName: "หจก.สามทองบริการ",

  periodLabel: "8/69",
  periodLabelThai: "ส.ค. 2569",
  dataFolderLabel: "ST_8.69",
  masterFileLabel: "ระยะทาง และ พนักงานขาย.pdf",
  arAsOfLabel: "7 ก.ย.69",
  confirmDateLabel: "10 ก.ย.69",

  fuelProductCodes: ["DS", "G91", "G95"],
  minQtyLiters: 2000,
  requireExactMultiple: true,
  qtyMultipleOf: 1000,

  docPrefixToSaleType: { H: "cash", I: "credit" },

  thresholds: { cash: 0.2, credit: 0.3, overdue: 0.6 },
  ratePerLiter: 0.03,
  penaltyNegativeQEnabled: true,

  freightTiers: DEFAULT_FREIGHT_TIERS,
  freightMissingBehavior: "defaultZero",
  debtDeductionMode: "auto",

  salespersonRoster: ["จุ่น", "อุ้ย"],

  excludedCustomers: [
    { customerCode: "ST57039", customerName: "ATA ปิโตรเลียม", reason: "เป็นลูกค้าของพนักงานขับรถมิเตอร์ ไม่ใช่ลูกค้าของเซลล์การตลาด" },
  ],

  // Confirmed with the user during the ST_8.69 (ส.ค. 2569) build — these 5
  // customers had a qualifying transaction but were missing from
  // "ระยะทาง และ พนักงานขาย.pdf" that month. Carried forward here so a future
  // run doesn't need to re-ask unless the master PDF itself gets updated.
  masterOverrides: [
    { customerCode: "ST600116", customerName: "มณฑิรา ภิบาลจอมมี", distanceKm: 52, salesperson: "จุ่น" },
    { customerCode: "ST600136", customerName: "หจก.บุญตะวัน2023", distanceKm: 100, salesperson: "จุ่น" },
    { customerCode: "KCL680214", customerName: "จิรัฐพัฒนาการเกษตร", distanceKm: 41, salesperson: "อุ้ย" },
    { customerCode: "KCL690125", customerName: "ทรัพย์ทวี", distanceKm: 105, salesperson: "จุ่น" },
    { customerCode: "ST57220", customerName: "แขวงทางหลวงชนบทกาฬสินธุ์", distanceKm: 20, salesperson: "จุ่น", reuseFromCustomerCode: "ST579612" },
  ],

  teamSplit: {
    roles: [
      { key: "manager", label: "ผู้จัดการ เค.ซี.ปิโตรเลียม", percent: 0.1 },
      { key: "sales", label: "เจ้าหน้าที่การตลาด (เจ้าของยอด)", percent: 0.6, isRemainder: true },
      { key: "admin", label: "ADMIN (บัญชีสาขา,ธุรการ,คลังน้ำมัน)", percent: 0.2 },
      { key: "central", label: "ส่วนกลางการตลาด", percent: 0.1 },
    ],
  },

  standingNotes: [
    "บทลงโทษกำไรต่อลิตรติดลบ (หัก 3 สต./ลิตร) ไม่ได้เขียนไว้ในประกาศ Incentive — เป็นแนวปฏิบัติภายในที่ยึดตามข้อมูลจริง (มิ.ย./ส.ค. 2569)",
    "ประกาศ Incentive ข้อ 6-7: ลูกหนี้ค้างชำระเกิน Credit Term ที่ยังไม่จ่าย ให้ตัดค่าคอมเหลือ 50% (เต็ม 100% ถ้าตกลงผ่อนตามตาราง) — ระบบนี้ยังไม่ได้คำนวณส่วนนี้อัตโนมัติ ฝ่ายบัญชีต้องปรับเองนอกระบบเมื่อมีลูกค้าถูกระบุเงื่อนไขนี้",
    "รายการที่มีหมายเหตุ 'มิเตอร์ NN' ต่อท้ายรหัสลูกค้า ไม่ใช่สัญญาณให้ตัดค่าคอมอัตโนมัติ — ต้องตรวจสอบกับผู้ใช้ทุกครั้งว่านับเป็นยอดของเซลล์จริงหรือไม่ (ดูชีทหมายเหตุสำหรับรายการที่พบในรอบนี้)",
  ],
};

