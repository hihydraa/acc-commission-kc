import fs from "fs";
import path from "path";
import { runCommissionPipeline, type InputFile } from "../src/lib/pipeline";
import { kranuanBranch } from "../src/branches/kranuan";

const dir = "D:\\Ham's Work\\ACC\\commisssion_system\\File_Commission";

async function loadFile(name: string): Promise<InputFile> {
  return { filename: name, buffer: fs.readFileSync(path.join(dir, name)) };
}

async function main() {
  const salesNames = ["เบอร์60 ส.ค. 69.pdf", "เบอร์67 ส.ค. 69.pdf", "เทรลเลอร์เบอร์68 ส.ค. 69.pdf", "กรอกปั๊ม_KN ส.ค.69.pdf"];
  const salesFiles = await Promise.all(salesNames.map(loadFile));
  const arFile = await loadFile("ลูกหนี้ ณ 7 ก.ย. 69.pdf");
  const masterFile = await loadFile("ระยะทาง + เชลล์ 2.pdf");

  const result = await runCommissionPipeline(kranuanBranch, salesFiles, arFile, masterFile);
  console.log("SUMMARY", result.summary);

  const byDept = new Map<string, { qualifying: number; blocked: number }>();
  for (const r of result.rows) {
    const e = byDept.get(r.truckLabel) ?? { qualifying: 0, blocked: 0 };
    if (r.calc.qualifiesByQty) e.qualifying++;
    if (r.calc.blocked) e.blocked++;
    byDept.set(r.truckLabel, e);
  }
  console.log("PER DEPARTMENT (qualifying rows / blocked rows)", Object.fromEntries(byDept));

  const perSalesperson = new Map<string, number>();
  for (const name of kranuanBranch.salespersonRoster) {
    const gross = result.rows.filter((r) => r.salesperson === name).reduce((s, r) => s + r.calc.commissionNumeric, 0);
    perSalesperson.set(name, gross);
  }
  console.log("PER SALESPERSON gross commission", Object.fromEntries(perSalesperson));

  const b3Total = result.rows.filter((r) => r.truckLabel === "กรอกหลังปั๊ม" && r.calc.qualifiesByQty).reduce((s, r) => s + r.calc.commissionNumeric, 0);
  console.log("B3 (กรอกหลังปั๊ม) total commission:", b3Total);

  const debtRows = result.rows.filter((r) => (r.outstandingAmount ?? 0) > 0);
  console.log(
    "DEBT MATCHES:",
    debtRows.map((r) => `${r.docNo} ${r.customerCode} ${r.customerName} outstanding=${r.arOutstandingReference}`)
  );

  // NOTE: the spec's own §8 reference numbers (25/31/4/13 qualifying rows,
  // ฿1,079.1075 for B3) predate two user-confirmed corrections (14 ก.ย.69):
  // กรอกหลังปั๊ม has no per-line qty threshold at all (count every liter
  // filled, not just lines >=1,000L), and the file's DSKN/G91KN/G95KN/B20KN
  // product codes are real fuel SKUs that must be included — both raise
  // B3's numbers well above that old reference. A7/B7/68's 25/31/4 rows and
  // สามทอง's own regression numbers are unaffected and still the right
  // check for those. Only sanity-check A7/B7/68 counts and "blocked among
  // qualifying" (should stay 0) against the old reference here.
  console.log("\n=== still-valid checks from spec §8 ===");
  console.log("qualifying rows: A7=25 B7=31 68=4 (B3 no longer comparable — see note above)");

  console.log(`\n${result.warnings.length} warnings:`);
  result.warnings.forEach((w) => console.log("-", w));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
