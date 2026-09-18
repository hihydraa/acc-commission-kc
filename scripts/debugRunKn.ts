import fs from "fs";
import path from "path";
import { runCommissionPipeline, type InputFile, type MasterLookup, type ChannelInput } from "../src/lib/pipeline";
import { kranuanBranch } from "../src/branches/kranuan";
import { extractPdfText } from "../src/lib/parser/pdfExtract";
import { parseDistanceMasterText } from "../src/lib/parser/distanceMaster";

const dir = "D:\\Ham's Work\\ACC\\commisssion_system\\File_Commission_KN";

// KN's real roster — no longer hardcoded on the branch config (it now comes
// from the Google Sheet at request time); supplied directly here since this
// script predates Google Sheets integration.
const ROSTER = ["อ้อม", "ต้อม", "วีระ"];

async function loadFile(name: string): Promise<InputFile> {
  return { filename: name, buffer: fs.readFileSync(path.join(dir, name)) };
}

async function buildMasterLookupFromPdf(file: InputFile): Promise<MasterLookup> {
  const text = await extractPdfText(file.buffer);
  const parsed = parseDistanceMasterText(text, ROSTER);
  const byCode = new Map(parsed.rows.map((r) => [r.customerCode, { customerName: r.customerName, distanceKm: r.distanceKm, salesperson: r.salesperson ?? "", tag: r.tag }]));
  // No pump-fill fallback needed here any more — kranuanBranch.pumpFillSalesperson
  // ("อ้อม") now handles that inside runCommissionPipeline itself.
  return { get: (code: string) => byCode.get(code) ?? null };
}

async function main() {
  // A7="เบอร์60"/B7="เบอร์67" -> meterTruck, 68="เทรลเลอร์เบอร์68" -> trailer,
  // B3="กรอกปั๊ม_KN" -> pumpFill — channel is now decided by upload slot, not
  // the file's own "เลือกแผนก" header (still cross-checked as a warning).
  const channelInputs: ChannelInput[] = [
    { channel: "meterTruck", files: await Promise.all(["เบอร์60 ส.ค. 69.pdf", "เบอร์67 ส.ค. 69.pdf"].map(loadFile)) },
    { channel: "trailer", files: [await loadFile("เทรลเลอร์เบอร์68 ส.ค. 69.pdf")] },
    { channel: "pumpFill", files: [await loadFile("กรอกปั๊ม_KN ส.ค.69.pdf")] },
  ];
  const arFile = await loadFile("ลูกหนี้ ณ 7 ก.ย. 69.pdf");
  const masterFile = await loadFile("ระยะทาง + เชลล์ 2.pdf");
  const masterLookup = await buildMasterLookupFromPdf(masterFile);

  const period = { periodLabel: "8/69", periodLabelThai: "ส.ค. 2569", arAsOfLabel: "7 ก.ย.69", confirmDateLabel: "11 ก.ย.69" };
  const result = await runCommissionPipeline(kranuanBranch, channelInputs, arFile, period, ROSTER, masterLookup);
  console.log("SUMMARY", result.summary);

  const byDept = new Map<string, { qualifying: number; blocked: number }>();
  for (const r of result.rows) {
    const e = byDept.get(r.truckLabel) ?? { qualifying: 0, blocked: 0 };
    if (r.calc.qualifiesByQty) e.qualifying++;
    if (r.calc.blocked) e.blocked++;
    byDept.set(r.truckLabel, e);
  }
  console.log("PER TRUCK LABEL (qualifying rows / blocked rows)", Object.fromEntries(byDept));

  const perSalesperson = new Map<string, number>();
  for (const name of ROSTER) {
    const gross = result.rows.filter((r) => r.salesperson === name).reduce((s, r) => s + r.calc.commissionNumeric, 0);
    perSalesperson.set(name, gross);
  }
  console.log("PER SALESPERSON gross commission", Object.fromEntries(perSalesperson));

  const b3Total = result.rows.filter((r) => r.truckLabel === "กรอกหลังปั๊ม" && r.calc.qualifiesByQty).reduce((s, r) => s + r.calc.commissionNumeric, 0);
  console.log("กรอกหลังปั๊ม total commission:", b3Total);

  const debtRows = result.rows.filter((r) => (r.outstandingAmount ?? 0) > 0);
  console.log(
    "DEBT MATCHES:",
    debtRows.map((r) => `${r.docNo} ${r.customerCode} ${r.customerName} outstanding=${r.arOutstandingReference}`)
  );

  console.log(`\n${result.warnings.length} warnings:`);
  result.warnings.forEach((w) => console.log("-", w));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
