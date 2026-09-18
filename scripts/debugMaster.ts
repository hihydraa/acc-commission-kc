import fs from "fs";
import path from "path";
import { extractPdfText } from "../src/lib/parser/pdfExtract";
import { parseDistanceMasterText } from "../src/lib/parser/distanceMaster";

// ST's real roster — no longer hardcoded on the branch config (see
// samthong.ts) now that it comes from the Google Sheet at request time.
const ROSTER = ["จุ่น", "อุ้ย"];

async function main() {
  const dir = "D:\\Ham's Work\\ACC\\commisssion_system\\File_Commission_ST";
  const buf = fs.readFileSync(path.join(dir, "ระยะทาง และ พนักงานขาย.pdf"));
  const text = await extractPdfText(buf);
  const parsed = parseDistanceMasterText(text, ROSTER);
  console.log("rows:", parsed.rows.length);
  for (const r of parsed.rows) console.log(r.customerCode, r.productCode, r.distanceKm, r.salesperson, r.tag);
  console.log("warnings:", parsed.warnings);
  console.log("has ST579612:", parsed.rows.some((r) => r.customerCode === "ST579612"));
}
main();
