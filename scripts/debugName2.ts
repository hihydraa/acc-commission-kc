import fs from "fs";
import path from "path";
import { runCommissionPipeline, type InputFile, type ChannelInput } from "../src/lib/pipeline";
import { samthongBranch } from "../src/branches/samthong";

const dir = "D:\\Ham's Work\\ACC\\commisssion_system\\File_Commission_ST";
const ROSTER = ["จุ่น", "อุ้ย"];

async function loadFile(name: string): Promise<InputFile> {
  return { filename: name, buffer: fs.readFileSync(path.join(dir, name)) };
}

async function main() {
  const channelInputs: ChannelInput[] = [
    { channel: "meterTruck", files: await Promise.all(["เบอร์ 55_ST_8.69.pdf", "เบอร์ 65_ST_8.69.pdf", "เบอร์ 69_ST_8.69.pdf", "เบอร์ 71_ST_8.69.pdf"].map(loadFile)) },
    { channel: "trailer", files: await Promise.all(["เทรลเลอร์เบอร์ 73_ST_8.69.pdf", "เทรลเลอร์เบอร์ 74_ST_8.69.pdf"].map(loadFile)) },
  ];
  const arFile = await loadFile("AR_ST_7.9.69.pdf");
  const period = { periodLabel: "8/69", periodLabelThai: "ส.ค. 2569", arAsOfLabel: "7 ก.ย.69", confirmDateLabel: "10 ก.ย.69" };
  const result = await runCommissionPipeline(samthongBranch, channelInputs, arFile, period, ROSTER);

  const st51165 = result.rows.filter((r) => r.customerCode === "ST51165");
  console.log("ST51165 rows:", st51165.length);
  for (const r of st51165.slice(0, 3)) console.log(r.truckLabel, r.customerCode, JSON.stringify(r.customerName));

  const st51163 = result.rows.filter((r) => r.customerCode === "ST51163");
  console.log("ST51163 rows:", st51163.length);
  for (const r of st51163.slice(0, 3)) console.log(r.truckLabel, r.customerCode, JSON.stringify(r.customerName));

  const st600136 = result.rows.filter((r) => r.customerCode === "ST600136");
  console.log("ST600136 rows:", st600136.length);
  for (const r of st600136.slice(0, 3)) console.log(r.truckLabel, r.customerCode, JSON.stringify(r.customerName));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
