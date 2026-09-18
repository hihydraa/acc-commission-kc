import type { BranchConfig } from "./types";

/**
 * สาขามุกดาหาร — ห้างหุ้นส่วนจำกัด เค.ซี.จี.ปิโตรเลียม. Real reference data
 * exists (File_Commission_MUK: เดือน ก.ค. 2569, approved "ค่าคอมมิชชั่น ทีม
 * 07-2569.pdf") — this branch is NOT a blank placeholder, but two things
 * found while reading that reference are still unresolved (see standingNotes)
 * and must be confirmed with the user before this branch's numbers can be
 * trusted, per the marketing-commission-calc SKILL's "never assume for a new
 * branch" rule.
 */
export const mukdahanBranch: BranchConfig = {
  id: "mukdahan",
  label: "มุกดาหาร",
  companyName: "หจก.เค.ซี.จี.ปิโตรเลียม",
  sheetTabName: "MUK",

  // Confirmed from the real เดือน ก.ค. 2569 sales-summary PDF (หมวด : น้ำมันใส
  // แสดง "ดีเซลB7 /DS-MUK" และ "แก๊สโซฮอล์ 95 /G95-MU[K]") — this branch's
  // sales system prints branch-suffixed SKU codes, NOT the plain DS/G91/G95
  // that สามทอง/กระนวน/วานรนิวาส use. G91-MUK is included speculatively
  // (never seen in the one real month checked so far, which had no G91
  // sales at all that month) — the pipeline's own unrecognized-product-code
  // warning will surface it immediately if a real file's G91 rows use a
  // different suffix than guessed here.
  fuelProductCodes: ["DS-MUK", "G91-MUK", "G95-MUK"],

  // Not yet confirmed whether this branch even has a กรอกหลังปั๊ม channel or
  // who runs it — set at /settings once confirmed.
  pumpFillSalesperson: null,

  excludedCustomers: [],

  standingNotes: [
    "2026-09-18: สาขาใหม่ สร้างจาก File_Commission_MUK (เดือน ก.ค. 2569, อนุมัติแล้ว) — ยืนยันแล้ว: อัตราแบ่งทีม 10/60/20/10 ตรงกับสาขาอื่นทุกประการ, รหัสสินค้าใช้ suffix '-MUK' คนละชุดกับสาขาอื่น",
      "ยังไม่ยืนยัน (ต้องถามผู้ใช้ก่อนใช้งานจริง): ไฟล์ 'ระยะทาง + เชลล์ 2.pdf' ที่อยู่ในโฟลเดอร์ File_Commission_MUK เป็นข้อมูลของสาขากระนวนจริงๆ (รหัสลูกค้า KCL/KN ไม่ตรงกับรหัสลูกค้าจริงของมุกดาหารที่เป็น KCG-prefix ในไฟล์ค่าคอม/ลูกหนี้เดือนเดียวกัน) — ห้ามใช้ไฟล์นี้เป็น master ของมุกดาหาร ต้องขอไฟล์ระยะทาง/เซลล์ที่ถูกต้องจากผู้ใช้เพื่อกรอกลง Google Sheet แท็บ MUK",
    "ยังไม่ยืนยัน: รายชื่อเซลล์ของสาขานี้ไม่ชัดเจนจากตารางในไฟล์ค่าคอมทีม (คอลัมน์ชื่อ 'พัน' และ 'ผจก.สิทธิ' อ่านได้ไม่แน่ใจว่าเป็นชื่อเซลล์จริงกี่คน) — ต้องถามผู้ใช้ก่อนกรอกรายชื่อเซลล์ลง Google Sheet แท็บ MUK",
  ],
};
