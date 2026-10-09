/** Strips characters outside XML 1.0's valid range (keeps tab/LF/CR,
 *  U+0020-U+D7FF, U+E000-U+FFFD — including Thai PUA codepoints, which are
 *  valid XML and handled separately by thaiPuaFix.ts) from text that ends
 *  up in an Excel cell. PDF text extraction occasionally yields stray
 *  low-byte control characters — not a Thai encoding issue, just raw binary
 *  leakage from a font/stream quirk — that ExcelJS writes straight into the
 *  cell's XML unescaped. Excel then refuses to open the file without a
 *  "repair" prompt that silently drops or mangles that string every time.
 */
export function sanitizeXmlText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "");
}
