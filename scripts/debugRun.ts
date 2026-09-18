import fs from "fs";
import path from "path";
import { runCommissionPipeline, type InputFile, type MasterLookup, type ChannelInput } from "../src/lib/pipeline";
import { samthongBranch } from "../src/branches/samthong";
import { extractPdfText } from "../src/lib/parser/pdfExtract";
import { parseDistanceMasterText } from "../src/lib/parser/distanceMaster";

const dir = "D:\\Ham's Work\\ACC\\commisssion_system\\File_Commission_ST";

// ST_8.69's real roster — no longer hardcoded on the branch config (it now
// comes from the Google Sheet at request time); supplied directly here
// since this script predates Google Sheets integration.
const ROSTER = ["จุ่น", "อุ้ย"];

async function loadFile(name: string): Promise<InputFile> {
  return { filename: name, buffer: fs.readFileSync(path.join(dir, name)) };
}

// These 5 were confirmed with the user during the original ST_8.69 build
// (previously hardcoded as samthong.ts's masterOverrides, now removed —
// master data lives in the Google Sheet + confirmation page instead).
// Layered on top here purely to reproduce the ST_8.69 reference total for
// this regression check.
const HISTORICAL_OVERRIDES: Record<string, { customerName: string; distanceKm: number | null; salesperson: string; tag: "1สาย1สู้" | "ทางผ่าน" | "" }> = {
  ST600116: { customerName: "มณฑิรา ภิบาลจอมมี", distanceKm: 52, salesperson: "จุ่น", tag: "" },
  ST600136: { customerName: "หจก.บุญตะวัน2023", distanceKm: 100, salesperson: "จุ่น", tag: "" },
  KCL680214: { customerName: "จิรัฐพัฒนาการเกษตร", distanceKm: 41, salesperson: "อุ้ย", tag: "" },
  KCL690125: { customerName: "ทรัพย์ทวี", distanceKm: 105, salesperson: "จุ่น", tag: "" },
  ST57220: { customerName: "แขวงทางหลวงชนบทกาฬสินธุ์", distanceKm: 20, salesperson: "จุ่น", tag: "" },
};

async function buildMasterLookupFromPdf(file: InputFile): Promise<MasterLookup> {
  const text = await extractPdfText(file.buffer);
  const parsed = parseDistanceMasterText(text, ROSTER);
  const byCode = new Map(parsed.rows.map((r) => [r.customerCode, { customerName: r.customerName, distanceKm: r.distanceKm, salesperson: r.salesperson ?? "", tag: r.tag }]));
  return { get: (code: string) => byCode.get(code) ?? HISTORICAL_OVERRIDES[code] ?? null };
}

async function main() {
  const meterTruckNames = ["เบอร์ 55_ST_8.69.pdf", "เบอร์ 65_ST_8.69.pdf", "เบอร์ 69_ST_8.69.pdf", "เบอร์ 71_ST_8.69.pdf"];
  const trailerNames = ["เทรลเลอร์เบอร์ 73_ST_8.69.pdf", "เทรลเลอร์เบอร์ 74_ST_8.69.pdf"];
  const channelInputs: ChannelInput[] = [
    { channel: "meterTruck", files: await Promise.all(meterTruckNames.map(loadFile)) },
    { channel: "trailer", files: await Promise.all(trailerNames.map(loadFile)) },
  ];
  const arFile = await loadFile("AR_ST_7.9.69.pdf");
  const masterFile = await loadFile("ระยะทาง และ พนักงานขาย.pdf");
  const masterLookup = await buildMasterLookupFromPdf(masterFile);

  const period = { periodLabel: "8/69", periodLabelThai: "ส.ค. 2569", arAsOfLabel: "7 ก.ย.69", confirmDateLabel: "10 ก.ย.69" };
  const result = await runCommissionPipeline(samthongBranch, channelInputs, arFile, period, ROSTER, masterLookup);
  console.log("SUMMARY", result.summary);

  const roster = new Set(ROSTER);
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

  const nearMiss = result.rows.filter((r) => samthongBranch.fuelProductCodes.includes(r.productCode) && r.qty >= 2000 && !(r.qty % 1000 === 0));
  console.log("NEAR-MISS (qty>=2000 but not round-1000, NOW EXPECTED TO QUALIFY under the 2026-09-18 unified rule), count=" + nearMiss.length);
  for (const r of nearMiss.slice(0, 20)) {
    console.log(`${r.truckLabel}\t${r.customerCode}\t${r.productCode}\t${r.qty}\t${r.docNo}\t${r.docDate}\tqualifiesByQty=${r.calc.qualifiesByQty}`);
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
