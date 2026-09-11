import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParseMod = require("pdf-parse");
const pdfParse = typeof pdfParseMod === "function" ? pdfParseMod : pdfParseMod.default;

const dir = "D:\\Ham's Work\\ACC\\commisssion_system\\File_Commission_ST";
const buf = fs.readFileSync(path.join(dir, "เบอร์ 65_ST_8.69.pdf"));
const result = await pdfParse(buf);
const lines = result.text.split(/\r?\n/);
const idxs = lines.map((l, i) => (l.includes("ST51165") ? i : -1)).filter((i) => i >= 0);
console.log("occurrences at lines:", idxs);
for (const idx of idxs) {
  console.log("--- around line", idx, "---");
  for (let i = Math.max(0, idx - 6); i < idx + 6; i++) console.log(i, JSON.stringify(lines[i]));
}
