import type { BranchConfig } from "./types";

/**
 * สาขาวานรนิวาส. Real reference data exists (File_Commission_VRN: เดือน
 * ส.ค. 2569, approved "ค่าคอมการตลาดวานร เดือนสิงหาคม69_17.09.2569.pdf") —
 * confirmed from that reference: team-split 10/60/20/10 (identical to every
 * other branch), plain DS/G91/G95 product codes (no branch suffix, unlike
 * มุกดาหาร), roster อุ้ย/ต้อม, and a "รถนอกส่ง" (externally-contracted
 * delivery truck) channel that uses the exact same rules as รถมิเตอร์/
 * เทรลเลอร์ — no new channel type needed, it just belongs in the shared
 * "deliveryRoute" bucket alongside them.
 */
export const wanonniwatBranch: BranchConfig = {
  id: "wanonniwat",
  label: "วานรนิวาส",
  // Confirmed with the user 2026-09-18 — matches the real approved
  // reference PDF's letterhead/signatures exactly (a บริษัท/Co.,Ltd, not a
  // หจก. — corrects an earlier verbal name that didn't match the documents).
  companyName: "บริษัท เค.ซี.กรีน เอ็นเนอร์จี จำกัด",
  sheetTabName: "VRN",

  // Confirmed from the real เดือน ส.ค. 2569 sales-summary PDFs across every
  // channel checked (มิเตอร์เบอร์58/66, เทรลเลอร์เบอร์70, กรอกหลังปั๊ม) — all
  // show plain "DS"/"G91"/"G95", no branch suffix (unlike มุกดาหาร's "-MUK").
  fuelProductCodes: ["DS", "G91", "G95"],

  // Unlike กระนวน, วานรนิวาส's กรอกหลังปั๊ม is confirmed SPLIT between two
  // sellers (real เดือน ส.ค. 2569 data: อุ้ย 130,000ล. / ต้อม 23,000ล.) — never
  // set this to a single fixed name for this branch, it must keep resolving
  // per customer via the Google Sheet / confirmation page like other channels.
  pumpFillSalesperson: null,

  excludedCustomers: [],

  standingNotes: [
    "2026-09-18: สาขาใหม่ สร้างจาก File_Commission_VRN (เดือน ส.ค. 2569, อนุมัติแล้ว) — ยืนยันแล้ว: อัตราแบ่งทีม 10/60/20/10 ตรงกับสาขาอื่นทุกประการ, รหัสสินค้าเป็น DS/G91/G95 แบบไม่มี suffix, เซลล์ 2 คนคือ อุ้ย/ต้อม, ชื่อนิติบุคคลตรงกับเอกสารจริง (บริษัท เค.ซี.กรีน เอ็นเนอร์จี จำกัด)",
    "รถนอกส่ง (externally-contracted delivery truck, พบจริงเดือน ส.ค. 2569 — 40,000 ล. ทั้งหมดของ อุ้ย) ใช้กฎเดียวกับรถมิเตอร์/เทรลเลอร์ทุกประการ (ตารางค่าขนส่งตามระยะทางเดียวกัน) — ให้ผู้ใช้อัปโหลดไฟล์นี้เข้าช่อง 'รถมิเตอร์' หรือ 'รถเทรลเลอร์' ก็ได้ (แค่กำหนด label เองว่าเป็น 'รถนอก' ตอนตั้งชื่อชีท), ไม่ต้องมีช่อง upload แยกสำหรับ 'รถนอก' โดยเฉพาะ",
    "พบการหักหนี้พิเศษ 'หนี้เก่าคุณพฤกษ์+ดาบชาติ 20%' ในไฟล์อ้างอิงเดือน ส.ค. 2569 (คนละแบบกับการจับคู่หนี้ค้างชำระอัตโนมัติ) — เป็นการปรับด้วยมือของฝ่ายบัญชีนอกระบบ ไม่ใช่กฎที่ต้อง automate เพิ่ม (เหมือนกรณี 50%/100% ของประกาศ Incentive ข้อ 6-7)",
  ],
};
