import type { BranchConfig } from "./types";

/**
 * สาขาสามทอง/โลจิสติกส์ — the branch marketing-commission-calc SKILL.md was
 * originally built from (ST_8.69, ส.ค. 2569, approved). As of 2026-09-18 the
 * qty rule, freight handling, and team-split % that used to live here are
 * unified across every branch in `src/lib/calc/channelRules.ts` — this file
 * only keeps what's genuinely specific to this legal entity.
 */
export const samthongBranch: BranchConfig = {
  id: "samthong",
  label: "สามทอง/โลจิสติกส์",
  companyName: "หจก.สามทองบริการ",
  sheetTabName: "ST",

  // DS2/DSB20 and the DSKN/G91KN/G95KN/B20KN pump-SKU variants are included
  // speculatively, NOT verified against real ST data — สามทอง's own
  // กรอกหลังปั๊ม channel has never had a real month's PDF to check against.
  // กระนวน's B3 pump uses a "KN" SKU suffix (confirmed real); if สามทอง's own
  // pump uses a DIFFERENT suffix, these codes won't match and the pipeline's
  // own unrecognized-product-code warning will surface it the first time a
  // real file is uploaded — check that warning and extend this list rather
  // than assuming it's already right.
  fuelProductCodes: ["DS", "G91", "G95", "DS2", "DSB20", "DSKN", "G91KN", "G95KN", "B20KN"],

  // สามทองมีช่องกรอกหลังปั๊มเหมือนกระนวน แต่ไม่เคยมีไฟล์จริงมาตรวจสอบว่าเซลล์
  // ประจำคือใคร (14 ก.ย.69) — เว้นว่างไว้จนกว่าจะยืนยัน ตั้งค่าได้ที่ /settings
  pumpFillSalesperson: null,

  excludedCustomers: [
    { customerCode: "ST57039", customerName: "ATA ปิโตรเลียม", reason: "เป็นลูกค้าของพนักงานขับรถมิเตอร์ ไม่ใช่ลูกค้าของเซลล์การตลาด" },
  ],

  standingNotes: [
    "บทลงโทษกำไรต่อลิตรติดลบ (หัก 3 สต./ลิตร) ไม่ได้เขียนไว้ในประกาศ Incentive — เป็นแนวปฏิบัติภายในที่ยึดตามข้อมูลจริง (มิ.ย./ส.ค. 2569)",
    "ประกาศ Incentive ข้อ 6-7: ลูกหนี้ค้างชำระเกิน Credit Term ที่ยังไม่จ่าย ให้ตัดค่าคอมเหลือ 50% (เต็ม 100% ถ้าตกลงผ่อนตามตาราง) — ระบบนี้ยังไม่ได้คำนวณส่วนนี้อัตโนมัติ ฝ่ายบัญชีต้องปรับเองนอกระบบเมื่อมีลูกค้าถูกระบุเงื่อนไขนี้",
    "รายการที่มีหมายเหตุ 'มิเตอร์ NN' ต่อท้ายรหัสลูกค้า ไม่ใช่สัญญาณให้ตัดค่าคอมอัตโนมัติ — ต้องตรวจสอบกับผู้ใช้ทุกครั้งว่านับเป็นยอดของเซลล์จริงหรือไม่ (ดูชีทหมายเหตุสำหรับรายการที่พบในรอบนี้)",
    "2026-09-18: เกณฑ์ปริมาณเปลี่ยนจาก '≥2,000 ลิตร และลงท้ายพันพอดี' เป็น '≥2,000 ลิตร เฉยๆ' (รวมกับกระนวนเป็นกฎเดียว ตามคำยืนยันของผู้ใช้) — เดือนก่อนหน้าที่เคยตัดรายการไม่ลงท้ายพันออกจะได้ยอดต่างจากเดิม โดยตั้งใจ ไม่ใช่บั๊ก",
    "2026-09-18: การจัดประเภทไฟล์ (รถมิเตอร์/เทรลเลอร์/กรอกหลังปั๊ม) เปลี่ยนจากการเดาจากชื่อไฟล์/รหัสแผนก 'B4' ในไฟล์ เป็นการเลือกช่อง upload ตรงๆ ในหน้าเว็บแทน — ผู้ใช้ต้องเลือกให้ถูกช่องเอง ระบบไม่เดาให้อีกต่อไป",
  ],
};
