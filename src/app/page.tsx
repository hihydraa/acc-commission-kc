"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { BRANCHES } from "@/branches";

const TH_MONTHS_ABBR = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

/** One calendar month, expressed in every label format this page's 3 period
 *  fields use — derived from a single {monthIdx, buddhistYear} pair so
 *  periodLabel/periodLabelThai/arAsOfLabel can never silently disagree with
 *  each other the way 3 independent free-text boxes could (e.g. "8/69"
 *  typed next to "ก.ย. 2569" — wrong month, easy typo, previously had no
 *  guard at all). */
interface MonthOption {
  key: string; // "2026-7" (Gregorian year-month, 0-indexed month) — stable <option> value
  /** "8/69" — matches periodLabel's existing format exactly */
  periodLabel: string;
  /** "ส.ค. 2569" — matches periodLabelThai's existing format exactly */
  periodLabelThai: string;
  /** "7 ก.ย.69" if THIS month is picked as the AR report's own month —
   *  matches arAsOfLabel's existing format exactly. When the AR dropdown's
   *  default is computed from the sales period instead, that's a separate
   *  "pick next month's key" step (see periodKey's onChange below), not
   *  baked into this field — this field is always just "the 7th, in this
   *  same month", regardless of why a given MonthOption got selected. */
  arAsOfLabelThisMonth: string;
}

function buildMonthOptions(): MonthOption[] {
  const now = new Date();
  const currentBuddhistYear = now.getFullYear() + 543;
  const options: MonthOption[] = [];
  // The current Buddhist year plus the next one (e.g. 2569/70) — this
  // branch only ever processes the current fiscal year's own periods, so a
  // multi-year rolling-back window was just clutter. One extra trailing
  // month (Jan of year+2) so the "วันที่รายงานลูกหนี้" dropdown's own
  // auto-default (always the NEXT month after งวด, see nextMonthKey below)
  // still resolves for a งวด of December in the later of the two years,
  // instead of silently coming up empty right at the year boundary.
  for (let buddhistYear = currentBuddhistYear; buddhistYear <= currentBuddhistYear + 2; buddhistYear++) {
    const gYear = buddhistYear - 543;
    const yy = String(buddhistYear).slice(-2);
    const lastMonth = buddhistYear === currentBuddhistYear + 2 ? 0 : 11; // only January for the trailing extra year
    for (let month = 0; month <= lastMonth; month++) {
      options.push({
        key: `${gYear}-${month}`,
        periodLabel: `${month + 1}/${yy}`,
        periodLabelThai: `${TH_MONTHS_ABBR[month]} ${buddhistYear}`,
        arAsOfLabelThisMonth: `7 ${TH_MONTHS_ABBR[month]}${yy}`,
      });
    }
  }
  return options;
}

/** The AR report is always dated the 7th of the month AFTER the sales
 *  period, per the Incentive policy's own reporting cycle — used only to
 *  pick a sensible DEFAULT when the period dropdown changes; the AR
 *  dropdown stays independently editable afterward. */
function nextMonthKey(key: string): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m + 1, 1);
  return `${d.getFullYear()}-${d.getMonth()}`;
}

type ChannelKey = "meterTruck" | "trailer" | "pumpFill";
const CHANNEL_LABEL_TH: Record<ChannelKey, string> = { meterTruck: "รถมิเตอร์", trailer: "เทรลเลอร์", pumpFill: "กรอกหลังปั๊ม" };

type ResolvedMasterEntry = { customerName: string; distanceKm: number | null; salesperson: string; tag: "1สาย1สู้" | "ทางผ่าน" | "" };

interface QualifyingCustomerPreview {
  customerCode: string;
  customerName: string;
  truckLabels: string[];
  channels: ChannelKey[];
  truckLabelsByChannel: Partial<Record<ChannelKey, string[]>>;
  resolvedByChannel: Partial<Record<ChannelKey, ResolvedMasterEntry | null>>;
}

function resolvedEntriesEqual(a: ResolvedMasterEntry | null, b: ResolvedMasterEntry | null): boolean {
  if (a === null || b === null) return a === b;
  return a.distanceKm === b.distanceKm && a.tag === b.tag && a.salesperson === b.salesperson;
}

/** Builds the confirm-page row(s) for one qualifying customer. Collapsing a
 *  multi-channel customer into a single shared row is only safe when every
 *  channel actually resolves to the SAME Sheet entry — confirmedCustomers
 *  (handleFinalize) has no other way to carry a per-channel distinction
 *  once submitted, so a customer whose channels resolve DIFFERENTLY (e.g.
 *  charged by distance on รถมิเตอร์ but ทางผ่าน on เทรลเลอร์) must be
 *  auto-split here — otherwise the single row's value (arbitrarily the
 *  first channel's) would silently get applied to every channel at
 *  calculation time, including ones the Sheet says should differ. */
function buildRowsForCustomer(c: QualifyingCustomerPreview): ConfirmRow[] {
  const firstResolved = c.resolvedByChannel[c.channels[0]] ?? null;
  const allSame = c.channels.every((ch) => resolvedEntriesEqual(c.resolvedByChannel[ch] ?? null, firstResolved));
  const channelsToEmit: (ChannelKey | "")[] = c.channels.length <= 1 || allSame ? [""] : c.channels;
  return channelsToEmit.map((channel) => {
    const resolved = (channel ? c.resolvedByChannel[channel] : firstResolved) ?? null;
    const name = resolved?.customerName || c.customerName;
    const distance = resolved?.distanceKm != null ? String(resolved.distanceKm) : "";
    const tag = resolved?.tag ?? "";
    const salesperson = resolved?.salesperson ?? "";
    return {
      customerCode: c.customerCode,
      customerName: name,
      truckLabels: (channel ? c.truckLabelsByChannel[channel] : null) ?? c.truckLabels,
      channel,
      distanceKm: distance,
      tag,
      salesperson,
      fromSheet: resolved !== null,
      originalCustomerName: name,
      originalDistanceKm: distance,
      originalTag: tag,
      originalSalesperson: salesperson,
      allChannels: c.channels,
      resolvedByChannel: c.resolvedByChannel,
      truckLabelsByChannel: c.truckLabelsByChannel,
    };
  });
}

interface ConfirmRow {
  customerCode: string;
  customerName: string;
  truckLabels: string[];
  /** "" = this row covers every channel (the common, unsplit case — most
   *  customers). A specific channel means "แยกตามช่องทาง" was used — this
   *  row is only that channel's override; its siblings (same customerCode,
   *  other channels) are separate rows elsewhere in `rows`. */
  channel: ChannelKey | "";
  distanceKm: string; // kept as string for the input box; "" = blank
  tag: "1สาย1สู้" | "ทางผ่าน" | "";
  salesperson: string;
  fromSheet: boolean; // true if the Sheet already had this customer/channel
  // Snapshot of what the Sheet actually had (or "" for a brand-new
  // customer) — compared against the live fields above at submit time to
  // decide whether this row needs writing back, so an unedited prefilled
  // row (e.g. distance "84" that came straight from the Sheet) is never
  // mistaken for an edit just because its field isn't blank.
  originalCustomerName: string;
  originalDistanceKm: string;
  originalTag: "1สาย1สู้" | "ทางผ่าน" | "";
  originalSalesperson: string;
  // Carried along from the /api/resolve preview purely so the "แยกตาม
  // ช่องทาง" button can expand this one row into N — not sent to the
  // server (see handleFinalize's confirmedCustomers mapping).
  allChannels: ChannelKey[];
  resolvedByChannel: Partial<Record<ChannelKey, ResolvedMasterEntry | null>>;
  truckLabelsByChannel: Partial<Record<ChannelKey, string[]>>;
}

interface CalcSummary {
  truckCount: number;
  qualifyingTransactionCount: number;
  qualifyingCustomerCount: number;
  qualifyingLiters: number;
  grossCommission: number;
  debtDeduction: number;
  netCommission: number;
  matchedDebtFlagged: number;
}

interface CalcResponse {
  filename: string;
  fileBase64: string;
  summary: CalcSummary;
  warnings: string[];
}

function baht(n: number): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type Step = "upload" | "confirm" | "result";

/** File input that ADDS newly picked files to what's already selected
 *  (native <input type=file> replaces the whole selection on every pick)
 *  and lets each file be removed individually before submitting. */
function FileListInput({ label, files, onChange }: { label: string; files: File[]; onChange: (files: File[]) => void }) {
  function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    if (picked.length > 0) {
      const existingKeys = new Set(files.map((f) => `${f.name}|${f.size}|${f.lastModified}`));
      const deduped = picked.filter((f) => !existingKeys.has(`${f.name}|${f.size}|${f.lastModified}`));
      onChange([...files, ...deduped]);
    }
    e.target.value = ""; // allow re-picking the same file later
  }
  function remove(idx: number) {
    onChange(files.filter((_, i) => i !== idx));
  }
  return (
    <div>
      <label className="block text-sm font-medium">{label}</label>
      <input type="file" accept="application/pdf" multiple className="mt-1 w-full text-sm" onChange={handlePick} />
      {files.length > 0 && (
        <ul className="mt-2 space-y-1">
          {files.map((f, idx) => (
            <li key={`${f.name}|${f.size}|${f.lastModified}`} className="flex items-center justify-between rounded bg-neutral-100 px-2 py-1 text-xs">
              <span className="truncate">{f.name}</span>
              <button type="button" onClick={() => remove(idx)} className="ml-2 shrink-0 text-red-700 hover:underline">
                ลบ
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Home() {
  const [step, setStep] = useState<Step>("upload");
  const [branchId, setBranchId] = useState(BRANCHES[0]?.id ?? "");
  const [meterTruckFiles, setMeterTruckFiles] = useState<File[]>([]);
  const [trailerFiles, setTrailerFiles] = useState<File[]>([]);
  const [pumpFillFiles, setPumpFillFiles] = useState<File[]>([]);
  const [arFile, setArFile] = useState<File | null>(null);

  const monthOptions = useMemo(() => buildMonthOptions(), []);
  const [periodKey, setPeriodKey] = useState(""); // drives periodLabel + periodLabelThai together
  const [arAsOfKey, setArAsOfKey] = useState(""); // its own dropdown — defaults to periodKey's next month, but independently editable after that
  const periodOption = monthOptions.find((o) => o.key === periodKey) ?? null;
  const arAsOfOption = monthOptions.find((o) => o.key === arAsOfKey) ?? null;
  const periodLabel = periodOption?.periodLabel ?? "";
  const periodLabelThai = periodOption?.periodLabelThai ?? "";
  const arAsOfLabel = arAsOfOption?.arAsOfLabelThisMonth ?? "";

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CalcResponse | null>(null);
  const [resolveWarnings, setResolveWarnings] = useState<string[]>([]);

  const [roster, setRoster] = useState<string[]>([]);
  const [rows, setRows] = useState<ConfirmRow[]>([]);

  const branch = BRANCHES.find((b) => b.id === branchId);

  function collectFormFiles(): FormData {
    const form = new FormData();
    form.set("branchId", branchId);
    meterTruckFiles.forEach((f) => form.append("meterTruckFiles", f));
    trailerFiles.forEach((f) => form.append("trailerFiles", f));
    pumpFillFiles.forEach((f) => form.append("pumpFillFiles", f));
    return form;
  }

  async function handleResolve(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const hasAnyFile = meterTruckFiles.length + trailerFiles.length + pumpFillFiles.length > 0;
    if (!hasAnyFile) {
      setError("กรุณาแนบไฟล์อย่างน้อย 1 ไฟล์ (รถมิเตอร์/รถเทรลเลอร์/กรอกหลังปั๊ม)");
      return;
    }
    if (!arFile) {
      setError("กรุณาเลือกไฟล์รายงานลูกหนี้ค้างชำระ (AR)");
      return;
    }
    if (!periodLabel || !periodLabelThai || !arAsOfLabel) {
      setError("กรุณากรอกข้อมูลงวด (เดือน/ปี และวันที่รายงานลูกหนี้)");
      return;
    }
    setLoading(true);
    try {
      const form = collectFormFiles();
      const res = await fetch("/api/resolve", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "ตรวจสอบข้อมูลไม่สำเร็จ");
        return;
      }
      setRoster(data.roster as string[]);
      setResolveWarnings(data.warnings as string[]);
      setRows((data.customers as QualifyingCustomerPreview[]).flatMap(buildRowsForCustomer));
      setStep("confirm");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function updateRow(idx: number, field: keyof ConfirmRow, value: string) {
    setRows((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value } as ConfirmRow;
      return next;
    });
  }

  /** Replaces one unsplit row (channel "") with one row PER channel the
   *  customer actually appears in — each pre-filled with that channel's own
   *  already-resolved value (which may just be the same general value if no
   *  Sheet override exists yet for it), independently editable from here on.
   *  See ConfirmRow.channel's doc comment for why this exists. */
  function splitRowByChannel(idx: number) {
    setRows((prev) => {
      const row = prev[idx];
      const splitRows: ConfirmRow[] = row.allChannels.map((channel) => {
        const resolved = row.resolvedByChannel[channel] ?? null;
        const name = resolved?.customerName || row.customerName;
        const distance = resolved?.distanceKm != null ? String(resolved.distanceKm) : "";
        const tag = resolved?.tag ?? "";
        const salesperson = resolved?.salesperson ?? "";
        return {
          ...row,
          channel,
          customerName: name,
          truckLabels: row.truckLabelsByChannel[channel] ?? row.truckLabels,
          distanceKm: distance,
          tag,
          salesperson,
          fromSheet: resolved !== null,
          originalCustomerName: name,
          originalDistanceKm: distance,
          originalTag: tag,
          originalSalesperson: salesperson,
        };
      });
      return [...prev.slice(0, idx), ...splitRows, ...prev.slice(idx + 1)];
    });
  }

  const missingCount = rows.filter((r) => !r.salesperson.trim() || (r.tag === "" && !r.distanceKm.trim())).length;
  const missingSalespersonCount = rows.filter((r) => !r.salesperson.trim()).length;

  async function handleFinalize() {
    setError(null);
    if (missingSalespersonCount > 0) {
      setError(`มีลูกค้า ${missingSalespersonCount} รายที่ยังไม่ได้ระบุเซลล์ — กรุณากรอกให้ครบก่อนคำนวณ`);
      return;
    }
    setLoading(true);
    try {
      const form = collectFormFiles();
      if (arFile) form.set("arFile", arFile);
      form.set(
        "period",
        JSON.stringify({ periodLabel, periodLabelThai, arAsOfLabel, confirmDateLabel: new Date().toLocaleDateString("th-TH") })
      );
      // Union with whatever salesperson names actually got typed on this
      // confirmation page — a name not yet in the Sheet (e.g. the first
      // อุ้ย customer for a branch whose Sheet only has จุ่น so far) must
      // still count as a recognized เซลล์ for THIS run, or
      // commissionEngine's roster check would zero her commission out.
      const finalRoster = [...new Set([...roster, ...rows.map((r) => r.salesperson.trim()).filter(Boolean)])];
      form.set("roster", JSON.stringify(finalRoster));
      form.set(
        "confirmedCustomers",
        JSON.stringify(
          rows.map((r) => ({
            customerCode: r.customerCode,
            customerName: r.customerName,
            channel: r.channel,
            distanceKm: r.tag ? null : r.distanceKm.trim() ? Number(r.distanceKm) : null,
            tag: r.tag,
            salesperson: r.salesperson.trim(),
            edited:
              !r.fromSheet ||
              r.customerName !== r.originalCustomerName ||
              r.distanceKm !== r.originalDistanceKm ||
              r.tag !== r.originalTag ||
              r.salesperson.trim() !== r.originalSalesperson,
          }))
        )
      );
      const res = await fetch("/api/calculate", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "คำนวณไม่สำเร็จ");
        return;
      }
      setResult(data as CalcResponse);
      setStep("result");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function downloadFile() {
    if (!result) return;
    const byteChars = atob(result.fileBase64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    const blob = new Blob([new Uint8Array(byteNumbers)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = result.filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function startOver() {
    setStep("upload");
    setResult(null);
    setRows([]);
    setMeterTruckFiles([]);
    setTrailerFiles([]);
    setPumpFillFiles([]);
    setArFile(null);
  }

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-10 text-neutral-900">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">ระบบคำนวณค่าคอมมิชชั่นฝ่ายการตลาด</h1>
            <p className="mt-1 text-sm text-neutral-600">
              เลือกสาขา → อัปโหลดไฟล์แยกตามช่องทาง → ตรวจสอบ/แก้ไขข้อมูลลูกค้า → คำนวณและดาวน์โหลดไฟล์ Excel
            </p>
          </div>
          <Link href="/settings" className="whitespace-nowrap text-sm text-neutral-600 underline">
            ตั้งค่าลูกค้ายกเว้น →
          </Link>
        </header>

        {step === "upload" && (
          <form onSubmit={handleResolve} className="space-y-5 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
            <div>
              <label className="block text-sm font-medium">สาขา / BU</label>
              <select className="mt-1 w-full rounded border border-neutral-300 px-3 py-2 text-sm" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                {BRANCHES.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.companyName} — {b.label}
                  </option>
                ))}
              </select>
              {branch && <p className="mt-1 text-xs text-neutral-500">สินค้าที่นับ: {branch.fuelProductCodes.join(", ")} · เกณฑ์ ≥2,000 ลิตร (ทุกสาขาใช้กฎเดียวกัน)</p>}
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium">งวด (เช่น 8/69)</label>
                <select
                  required
                  className="mt-1 w-full rounded border border-neutral-300 px-2 py-2 text-sm"
                  value={periodKey}
                  onChange={(e) => {
                    const key = e.target.value;
                    setPeriodKey(key);
                    // Smart default, not a lock — the AR dropdown right next
                    // to this one stays independently editable afterward.
                    if (key) setArAsOfKey(nextMonthKey(key));
                  }}
                >
                  <option value="" disabled>
                    เลือกงวด
                  </option>
                  {monthOptions.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.periodLabel}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium">งวด (ไทย)</label>
                <select required className="mt-1 w-full rounded border border-neutral-300 px-2 py-2 text-sm" value={periodKey} onChange={(e) => setPeriodKey(e.target.value)}>
                  <option value="" disabled>
                    เลือกงวด
                  </option>
                  {monthOptions.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.periodLabelThai}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium">วันที่รายงานลูกหนี้</label>
                <select required className="mt-1 w-full rounded border border-neutral-300 px-2 py-2 text-sm" value={arAsOfKey} onChange={(e) => setArAsOfKey(e.target.value)}>
                  <option value="" disabled>
                    เลือกวันที่
                  </option>
                  {monthOptions.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.arAsOfLabelThisMonth}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <FileListInput label="รถมิเตอร์ (เลือกได้หลายไฟล์)" files={meterTruckFiles} onChange={setMeterTruckFiles} />
            <FileListInput label="รถเทรลเลอร์ (เลือกได้หลายไฟล์)" files={trailerFiles} onChange={setTrailerFiles} />
            <FileListInput label="กรอกหลังปั๊ม (เลือกได้หลายไฟล์)" files={pumpFillFiles} onChange={setPumpFillFiles} />
            <div>
              <label className="block text-sm font-medium">รายงานลูกหนี้ค้างชำระ *</label>
              <input type="file" accept="application/pdf" className="mt-1 w-full text-sm" onChange={(e) => setArFile(e.target.files?.[0] ?? null)} />
            </div>

            <button type="submit" disabled={loading} className="w-full rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {loading ? "กำลังตรวจสอบข้อมูล..." : "ตรวจสอบข้อมูล"}
            </button>
          </form>
        )}

        {step === "confirm" && (
          <div className="space-y-4 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
            <h2 className="font-semibold">
              ยืนยันข้อมูลลูกค้าก่อนคำนวณ ({rows.length} ราย{missingCount > 0 ? ` — ยังขาดข้อมูล ${missingCount} ราย` : ""})
            </h2>
            <p className="text-xs text-neutral-500">
              แถวสีเหลืองคือลูกค้าที่ยังไม่มีข้อมูลใน Google Sheet — กรุณากรอกระยะทาง/แท็ก/เซลล์ให้ครบ การแก้ไขที่นี่จะถูกบันทึกกลับเข้า Google Sheet เมื่อกดคำนวณ
            </p>
            <div className="max-h-[28rem] overflow-auto rounded border border-neutral-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-neutral-100">
                  <tr className="text-left text-xs text-neutral-600">
                    <th className="p-2">รหัส</th>
                    <th className="p-2">ชื่อลูกค้า</th>
                    <th className="p-2">ไฟล์</th>
                    <th className="p-2">ระยะทาง(กม.)</th>
                    <th className="p-2">Tag</th>
                    <th className="p-2">เซลล์</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, idx) => (
                    <tr key={`${r.customerCode}::${r.channel || "all"}`} className={`border-t border-neutral-100 ${r.fromSheet ? "" : "bg-amber-50"}`}>
                      <td className="p-2 font-mono text-xs">{r.customerCode}</td>
                      <td className="p-2">
                        <input className="w-40 rounded border border-neutral-300 px-1 py-0.5 text-xs" value={r.customerName} onChange={(e) => updateRow(idx, "customerName", e.target.value)} />
                      </td>
                      <td className="p-2 text-xs text-neutral-500">
                        {r.truckLabels.join(", ")}
                        {r.channel && <div className="mt-0.5 font-medium text-neutral-700">เฉพาะ {CHANNEL_LABEL_TH[r.channel]}</div>}
                        {!r.channel && r.allChannels.length > 1 && (
                          <button
                            type="button"
                            onClick={() => splitRowByChannel(idx)}
                            className="mt-0.5 block text-left text-sky-700 underline decoration-dotted"
                            title="ลูกค้ารายนี้ส่งด้วยหลายช่องทาง — แยกกรอกระยะทาง/Tag/เซลล์เป็นรายช่องทางได้ถ้าต่างกัน"
                          >
                            แยกตามช่องทาง ({r.allChannels.map((c) => CHANNEL_LABEL_TH[c]).join("/")})
                          </button>
                        )}
                      </td>
                      <td className="p-2">
                        <input
                          className="w-20 rounded border border-neutral-300 px-1 py-0.5 text-xs"
                          value={r.distanceKm}
                          disabled={r.tag !== ""}
                          onChange={(e) => updateRow(idx, "distanceKm", e.target.value)}
                        />
                      </td>
                      <td className="p-2">
                        <select className="rounded border border-neutral-300 px-1 py-0.5 text-xs" value={r.tag} onChange={(e) => updateRow(idx, "tag", e.target.value)}>
                          <option value="">—</option>
                          <option value="1สาย1สู้">1สาย1สู้</option>
                          <option value="ทางผ่าน">ทางผ่าน</option>
                        </select>
                      </td>
                      <td className="p-2">
                        <input
                          list="roster-options"
                          className="w-24 rounded border border-neutral-300 px-1 py-0.5 text-xs"
                          value={r.salesperson}
                          onChange={(e) => updateRow(idx, "salesperson", e.target.value)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <datalist id="roster-options">
                {roster.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
            {resolveWarnings.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-amber-700">คำเตือนจากการอ่านไฟล์ ({resolveWarnings.length})</summary>
                <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto rounded bg-amber-50 p-2">
                  {resolveWarnings.map((w, i) => (
                    <li key={i}>• {w}</li>
                  ))}
                </ul>
              </details>
            )}
            <div className="flex gap-2">
              <button onClick={() => setStep("upload")} className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium">
                ← กลับไปแก้ไฟล์
              </button>
              <button onClick={handleFinalize} disabled={loading} className="flex-1 rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {loading ? "กำลังคำนวณ..." : "ยืนยันและคำนวณ"}
              </button>
            </div>
          </div>
        )}

        {error && <div className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800">{error}</div>}

        {step === "result" && result && (
          <div className="space-y-4 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
            <h2 className="font-semibold">ผลการคำนวณ</h2>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-neutral-500">รายการเข้าเกณฑ์</dt>
                <dd className="font-medium">{result.summary.qualifyingTransactionCount.toLocaleString()} รายการ</dd>
              </div>
              <div>
                <dt className="text-neutral-500">จำนวนลูกค้า</dt>
                <dd className="font-medium">{result.summary.qualifyingCustomerCount.toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-neutral-500">ลิตรรวม (เข้าเกณฑ์)</dt>
                <dd className="font-medium">{result.summary.qualifyingLiters.toLocaleString()} ลิตร</dd>
              </div>
              <div>
                <dt className="text-neutral-500">ค่าคอมรวม (ก่อนหักหนี้)</dt>
                <dd className="font-medium">฿{baht(result.summary.grossCommission)}</dd>
              </div>
              <div>
                <dt className="text-neutral-500">หักหนี้ค้างชำระ</dt>
                <dd className="font-medium">฿{baht(result.summary.debtDeduction)}</dd>
              </div>
              <div>
                <dt className="text-neutral-500">ค่าคอมสุทธิ</dt>
                <dd className="font-medium">฿{baht(result.summary.netCommission)}</dd>
              </div>
            </dl>

            <button onClick={downloadFile} className="w-full rounded bg-emerald-700 px-4 py-2 text-sm font-medium text-white">
              ดาวน์โหลดไฟล์ Excel ({result.filename})
            </button>
            <button onClick={startOver} className="w-full rounded border border-neutral-300 px-4 py-2 text-sm font-medium">
              คำนวณรอบใหม่
            </button>

            {result.warnings.length > 0 && (
              <details className="text-sm" open>
                <summary className="cursor-pointer font-medium text-amber-700">คำเตือน / สิ่งที่ต้องตรวจสอบก่อนส่งมอบ ({result.warnings.length})</summary>
                <ul className="mt-2 max-h-80 space-y-1 overflow-y-auto rounded bg-amber-50 p-3 text-xs text-amber-900">
                  {result.warnings.map((w, i) => (
                    <li key={i}>• {w}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
