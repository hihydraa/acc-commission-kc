export interface RawSalesLine {
  docNo: string; // normalized, e.g. IDA126080014-1
  baseDocNo: string; // suffix stripped, e.g. IDA126080014
  date: string; // as printed, dd/mm/yy (Buddhist Era)
  qty: number;
  qty2: number;
  saleValue: number;
  cost: number;
  customerCode: string;
  productCode: string; // from the current product-header context
  productName: string;
  customerNameRaw: string; // display only, never used for matching
  meterAnnotation: string | null; // e.g. "มิเตอร์ 53" — presence must be surfaced, never auto-decided
  sourceLineNo: number;
}

export interface ProductSubtotal {
  productCode: string;
  productName: string;
  qtyTotal: number;
  valueTotal: number;
  qtyComputed: number;
  valueComputed: number;
  rawLine: string;
}

export interface CustomerSubtotal {
  customerNameRaw: string;
  qtyTotal: number;
  valueTotal: number;
  qtyComputed: number;
  valueComputed: number;
  rawLine: string;
}

export interface FileGrandTotal {
  customerCount: number | null;
  qtyTotal: number;
  valueTotal: number;
  rawLine: string;
}

export interface ParsedSalesReport {
  truckCode: string | null; // "เลือกแผนก" value printed on the report header
  lines: RawSalesLine[];
  productSubtotals: ProductSubtotal[];
  customerSubtotals: CustomerSubtotal[];
  grandTotal: FileGrandTotal | null;
  warnings: string[];
}

export interface ArOutstandingRow {
  baseDocNo: string;
  customerCode: string | null;
  customerNameRaw: string;
  billDate: string | null; // dd/mm/yy as printed
  billAmount: number;
  paidAmount: number;
  outstanding: number;
  meterAnnotation: string | null;
  category: string | null; // e.g. "ลูกค้าหน่วยรถมิเตอร์" — the AR report's own section heading, if any
}

export interface ParsedArReport {
  rows: ArOutstandingRow[];
  asOfDate: string | null;
  warnings: string[];
}

export interface DistanceMasterRow {
  customerCode: string;
  customerName: string;
  productCode: string | null;
  distanceKm: number | null; // null when the source says "-" / has no number
  salesperson: string | null;
  tag: "1สาย1สู้" | "ทางผ่าน" | "";
}

export interface ParsedDistanceMaster {
  rows: DistanceMasterRow[];
  warnings: string[];
}
