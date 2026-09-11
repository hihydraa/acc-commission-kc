import fs from "fs";
import path from "path";
import { extractPdfText } from "../src/lib/parser/pdfExtract";
import { parseDistanceMasterText } from "../src/lib/parser/distanceMaster";
import { samthongBranch } from "../src/branches/samthong";

async function main() {
  const dir = "D:\\Ham's Work\\ACC\\commisssion_system\\File_Commission_ST";
  const buf = fs.readFileSync(path.join(dir, "ระยะทาง และ พนักงานขาย.pdf"));
  const text = await extractPdfText(buf);
  const parsed = parseDistanceMasterText(text, samthongBranch.salespersonRoster);
  console.log("rows:", parsed.rows.length);
  for (const r of parsed.rows) console.log(r.customerCode, r.productCode, r.distanceKm, r.salesperson, r.tag);
  console.log("warnings:", parsed.warnings);
  console.log("has ST579612:", parsed.rows.some((r) => r.customerCode === "ST579612"));
}
main();
