import fs from "fs";
import path from "path";
import { runCommissionPipeline, type InputFile } from "../src/lib/pipeline";
import { samthongBranch } from "../src/branches/samthong";

const dir = "D:\\Ham's Work\\ACC\\commisssion_system\\File_Commission_ST";

async function loadFile(name: string): Promise<InputFile> {
  return { filename: name, buffer: fs.readFileSync(path.join(dir, name)) };
}

async function main() {
  const salesNames = [
    "เบอร์ 55_ST_8.69.pdf",
    "เบอร์ 65_ST_8.69.pdf",
    "เบอร์ 69_ST_8.69.pdf",
    "เบอร์ 71_ST_8.69.pdf",
    "เทรลเลอร์เบอร์ 73_ST_8.69.pdf",
    "เทรลเลอร์เบอร์ 74_ST_8.69.pdf",
  ];
  const salesFiles = await Promise.all(salesNames.map(loadFile));
  const arFile = await loadFile("AR_ST_7.9.69.pdf");
  const masterFile = await loadFile("ระยะทาง และ พนักงานขาย.pdf");

  const result = await runCommissionPipeline(samthongBranch, salesFiles, arFile, masterFile);
  console.log("SUMMARY", result.summary);

  const roster = new Set(samthongBranch.salespersonRoster);
  const qualifying = result.rows.filter((r) => r.calc.qualifiesByQty && r.salesperson && roster.has(r.salesperson));

  const perTruck = new Map<string, { liters: number; commission: number; count: number }>();
  for (const r of qualifying) {
    const agg = perTruck.get(r.truckLabel) ?? { liters: 0, commission: 0, count: 0 };
    agg.liters += r.qty;
    agg.commission += r.calc.commissionNumeric;
    agg.count += 1;
    perTruck.set(r.truckLabel, agg);
  }
  console.log("PER TRUCK", Object.fromEntries(perTruck));

  console.log("QUALIFYING ROWS (" + qualifying.length + "):");
  for (const r of qualifying) {
    console.log(
      `${r.truckLabel}\t${r.customerCode}\t${r.productCode}\t${r.qty}\t${r.saleType}\t${r.salesperson}\tdist=${r.distanceKm}\tcomm=${r.calc.commissionNumeric}\tflags=${r.calc.flags.join("|")}`
    );
  }

  // also show near-miss rows: fuel product, qty>=2000, but NOT multiple of 1000 (to sanity check the round-thousand filter),
  // and rows that ARE qty-qualifying but salesperson missing/not on roster
  const nearMiss = result.rows.filter(
    (r) => samthongBranch.fuelProductCodes.includes(r.productCode) && r.qty >= 2000 && !(r.qty % 1000 === 0)
  );
  console.log("NEAR-MISS (qty>=2000 but not round-1000), count=" + nearMiss.length);
  for (const r of nearMiss.slice(0, 20)) {
    console.log(`${r.truckLabel}\t${r.customerCode}\t${r.productCode}\t${r.qty}\t${r.docNo}\t${r.docDate}`);
  }

  const allQtyQualifying = result.rows.filter((r) => r.calc.qualifiesByQty);
  const allQtyQualifyingExclST57039 = allQtyQualifying.filter((r) => r.customerCode !== "ST57039");
  console.log(
    "ALL qty-qualifying rows:",
    allQtyQualifying.length,
    "customers:",
    new Set(allQtyQualifying.map((r) => r.customerCode)).size,
    "liters:",
    allQtyQualifying.reduce((s, r) => s + r.qty, 0)
  );
  console.log(
    "  excluding ST57039:",
    allQtyQualifyingExclST57039.length,
    "customers:",
    new Set(allQtyQualifyingExclST57039.map((r) => r.customerCode)).size,
    "liters:",
    allQtyQualifyingExclST57039.reduce((s, r) => s + r.qty, 0)
  );

  const qualByQtyNoRoster = result.rows.filter((r) => r.calc.qualifiesByQty && (!r.salesperson || !roster.has(r.salesperson)));
  console.log("QUALIFIES-BY-QTY BUT NOT COUNTED (no/unknown salesperson), count=" + qualByQtyNoRoster.length);
  for (const r of qualByQtyNoRoster.slice(0, 30)) {
    console.log(`${r.truckLabel}\t${r.customerCode}\t${r.productCode}\t${r.qty}\t${r.docNo}\tsalesperson=${r.salesperson}\tflags=${r.calc.flags.join("|")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
