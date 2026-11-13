import "server-only";
import { formatUsd } from "../../pricing";
import { formatBytes } from "../../storage";
import { xrayHeadline, type XrayReport } from "../../xray";

/**
 * The X-Ray report as a PDF to pass around. Written by hand — text, rectangles and the
 * built-in Helvetica — so the server needs no PDF library or font files for it.
 * File names appear; the contents of files, and any secret found in them, never do.
 */
const WIDTH = 595;
const HEIGHT = 842;
const MARGIN = 48;
const INK: Rgb = [0.11, 0.12, 0.14];
const MUTED: Rgb = [0.42, 0.45, 0.5];
const LINE: Rgb = [0.88, 0.89, 0.91];
const ACCENT: Rgb = [0.15, 0.39, 0.92];
const DANGER: Rgb = [0.8, 0.2, 0.18];
const WARNING: Rgb = [0.78, 0.5, 0.05];
const OK: Rgb = [0.1, 0.55, 0.33];
type Rgb = [number, number, number];

const WIN_ANSI: Record<string, string> = { "€": "\x80", "…": "\x85", "‘": "\x91", "’": "\x92", "“": "\x93", "”": "\x94", "•": "\x95", "–": "\x96", "—": "\x97", "≥": ">=" };

/** A string as a PDF literal in WinAnsi; what the font can't show becomes "?". */
function literal(text: string): string {
  let out = "";
  for (const char of text) {
    const mapped = WIN_ANSI[char] ?? char;
    for (const c of mapped) {
      const code = c.charCodeAt(0);
      if (c === "(" || c === ")" || c === "\\") out += `\\${c}`;
      else if (code < 32 || (code > 126 && code < 160 && !Object.values(WIN_ANSI).includes(c)) || code > 255) out += "?";
      else out += c;
    }
  }
  return `(${out})`;
}

/** Helvetica averages about half an em per character: close enough to fit and right-align. */
const widthOf = (text: string, size: number, bold = false) => text.length * size * (bold ? 0.56 : 0.51);
const fit = (text: string, size: number, width: number) => {
  const max = Math.max(4, Math.floor(width / (size * 0.51)));
  return text.length > max ? `${text.slice(0, Math.floor(max / 2) - 1)}…${text.slice(text.length - Math.ceil(max / 2) + 2)}` : text;
};

function wrap(text: string, size: number, width: number): string[] {
  const max = Math.max(10, Math.floor(width / (size * 0.51)));
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > max) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

class Document {
  private pages: string[][] = [[]];
  /** Distance from the top of the current page. */
  y = MARGIN;

  private get page() {
    return this.pages[this.pages.length - 1];
  }
  newPage() {
    this.pages.push([]);
    this.y = MARGIN;
  }
  /** Starts a new page unless `height` more fits on this one. */
  room(height: number) {
    if (this.y + height > HEIGHT - MARGIN - 18) this.newPage();
  }
  text(x: number, text: string, size = 10, { bold = false, color = INK, right = false }: { bold?: boolean; color?: Rgb; right?: boolean } = {}) {
    const left = right ? x - widthOf(text, size, bold) : x;
    this.page.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${color.join(" ")} rg ${left.toFixed(1)} ${(HEIGHT - this.y - size).toFixed(1)} Td ${literal(text)} Tj ET`);
  }
  rect(x: number, width: number, height: number, color: Rgb, offset = 0) {
    this.page.push(`${color.join(" ")} rg ${x.toFixed(1)} ${(HEIGHT - this.y - offset - height).toFixed(1)} ${width.toFixed(1)} ${height.toFixed(1)} re f`);
  }
  rule() {
    this.rect(MARGIN, WIDTH - 2 * MARGIN, 0.6, LINE);
    this.y += 8;
  }
  heading(title: string) {
    this.room(60);
    this.y += 10;
    this.text(MARGIN, title, 13, { bold: true });
    this.y += 20;
    this.rule();
  }
  paragraph(text: string, size = 9.5, color = MUTED, x = MARGIN, width = WIDTH - 2 * MARGIN) {
    for (const line of wrap(text, size, width)) {
      this.room(size + 4);
      this.text(x, line, size, { color });
      this.y += size + 3.5;
    }
  }

  bytes(footer: string): Uint8Array {
    const objects: string[] = [];
    const add = (body: string) => objects.push(body) - 1 + 1; // 1-based object number
    const fontRegular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const fontBold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const pagesId = objects.length + 1 + this.pages.length * 2;
    const kids: number[] = [];
    this.pages.forEach((ops, index) => {
      const stamp = `BT /F1 8 Tf ${MUTED.join(" ")} rg ${MARGIN} 30 Td ${literal(footer)} Tj ET BT /F1 8 Tf ${MUTED.join(" ")} rg ${WIDTH - MARGIN - 50} 30 Td ${literal(`Page ${index + 1} of ${this.pages.length}`)} Tj ET`;
      const stream = `${ops.join("\n")}\n${stamp}`;
      const content = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
      kids.push(
        add(
          `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${WIDTH} ${HEIGHT}] /Contents ${content} 0 R /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> >>`,
        ),
      );
    });
    add(`<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${kids.length} >>`);
    const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

    let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
    const offsets: number[] = [];
    objects.forEach((body, index) => {
      offsets.push(Buffer.byteLength(out, "latin1"));
      out += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, "latin1");
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
  }
}

const money = (usd: number | null) => (usd === null ? "—" : `${formatUsd(usd)}/mo`);

export function renderXrayPdf(report: XrayReport): Uint8Array {
  const doc = new Document();
  const right = WIDTH - MARGIN;
  const scanned = new Date(report.scannedAt);
  const when = `${scanned.toISOString().slice(0, 10)} ${scanned.toISOString().slice(11, 16)} UTC`;

  // Masthead
  doc.text(MARGIN, "jvinu", 15, { bold: true, color: ACCENT });
  doc.text(right, "Storage X-Ray", 10, { color: MUTED, right: true });
  doc.y += 30;
  doc.text(MARGIN, fit(xrayHeadline(report, formatUsd, formatBytes), 22, WIDTH - 2 * MARGIN), 22, { bold: true });
  doc.y += 32;
  doc.text(MARGIN, fit(`${report.connectionName} · ${report.bucket} · ${report.provider} · scanned ${when}`, 10, WIDTH - 2 * MARGIN), 10, { color: MUTED });
  doc.y += 26;

  // Four figures across
  const cards: [string, string, Rgb][] = [
    ["Stored", formatBytes(report.bytes), INK],
    ["Cost per month", report.monthlyUsd === null ? "—" : `${report.truncated ? ">= " : ""}${formatUsd(report.monthlyUsd)}`, INK],
    ["Waste", report.wasteMonthlyUsd !== null ? money(report.wasteMonthlyUsd) : formatBytes(report.wasteBytes), report.wasteBytes || report.wasteMonthlyUsd ? WARNING : OK],
    ["Possible secrets", String(report.secrets.length), report.secrets.length ? DANGER : OK],
  ];
  const cardWidth = (WIDTH - 2 * MARGIN - 3 * 10) / 4;
  cards.forEach(([label, value, color], index) => {
    const x = MARGIN + index * (cardWidth + 10);
    doc.rect(x, cardWidth, 54, [0.96, 0.965, 0.975]);
    doc.y += 10;
    doc.text(x + 10, label.toUpperCase(), 7.5, { color: MUTED, bold: true });
    doc.y += 14;
    doc.text(x + 10, value, 15, { bold: true, color });
    doc.y -= 24;
  });
  doc.y += 66;
  doc.paragraph(`${report.objects.toLocaleString("en-US")} objects. Storage at list price; requests, downloads and retrieval fees aren't included.`);

  doc.heading("Cost by folder");
  const top = report.folders.slice(0, 14);
  const max = Math.max(...top.map((folder) => folder.bytes), 1);
  for (const folder of top) {
    doc.room(22);
    doc.text(MARGIN, fit(folder.folder || "(files at the top level)", 9.5, 210), 9.5);
    doc.text(right, money(folder.monthlyUsd), 9.5, { right: true, bold: true });
    doc.text(right - 70, formatBytes(folder.bytes), 9.5, { right: true, color: MUTED });
    doc.rect(MARGIN + 220, 150, 5, [0.93, 0.94, 0.95], 3);
    doc.rect(MARGIN + 220, Math.max(1.5, (folder.bytes / max) * 150), 5, ACCENT, 3);
    doc.y += 17;
  }
  if (!top.length) doc.paragraph("This bucket is empty.");

  doc.heading("Hidden waste");
  if (!report.waste.length) doc.paragraph("Nothing found: no unfinished uploads, old versions, duplicates or leftovers.", 9.5, OK);
  for (const finding of report.waste) {
    doc.room(64);
    doc.text(MARGIN, finding.title, 11, { bold: true });
    doc.text(right, finding.monthlyUsd !== null ? money(finding.monthlyUsd) : formatBytes(finding.bytes), 11, { bold: true, color: WARNING, right: true });
    doc.y += 16;
    doc.text(MARGIN, `${finding.objects.toLocaleString("en-US")} ${finding.objects === 1 ? "item" : "items"} · ${formatBytes(finding.bytes)}`, 9, { color: MUTED });
    doc.y += 14;
    doc.paragraph(finding.detail, 9);
    for (const example of finding.examples.slice(0, 5)) {
      doc.room(13);
      doc.text(MARGIN + 10, fit(example.key, 8.5, 380), 8.5);
      doc.text(right, formatBytes(example.bytes), 8.5, { right: true, color: MUTED });
      doc.y += 12;
    }
    doc.y += 8;
  }

  doc.heading("Public access");
  const exposure = report.exposure;
  const [label, color]: [string, Rgb] =
    exposure.state === "public" ? ["Readable by anyone", DANGER] : exposure.state === "private" ? ["Private", OK] : ["Couldn't be confirmed", WARNING];
  doc.text(MARGIN, label, 11, { bold: true, color });
  if (exposure.publicFiles) doc.text(right, `${exposure.publicFiles.toLocaleString("en-US")} files`, 11, { bold: true, color, right: true });
  doc.y += 17;
  for (const reason of exposure.reasons) doc.paragraph(reason, 9.5);

  doc.heading("Possible leaked secrets");
  if (!report.secrets.length) doc.paragraph(`None found in ${report.contentScanned.toLocaleString("en-US")} files opened and every file name checked.`, 9.5, OK);
  else doc.paragraph("File names only. What's inside these files is not in this report. Rotate any credential listed here before deleting the file.");
  for (const secret of report.secrets.slice(0, 60)) {
    doc.room(14);
    doc.rect(MARGIN, 3, 9, secret.severity === "high" ? DANGER : WARNING, 1);
    doc.text(MARGIN + 9, fit(secret.rule, 9, 170), 9, { bold: true });
    doc.text(MARGIN + 185, fit(`${secret.key}${secret.line ? `:${secret.line}` : ""}`, 8.5, secret.public ? 255 : 310), 8.5, { color: MUTED });
    if (secret.public) doc.text(right, "PUBLIC", 8, { bold: true, color: DANGER, right: true });
    doc.y += 13;
  }
  if (report.secrets.length > 60) doc.paragraph(`…and ${report.secrets.length - 60} more.`);

  if (report.notes.length) {
    doc.heading("About this scan");
    for (const note of report.notes) doc.paragraph(`• ${note}`, 9);
  }
  return doc.bytes(`Generated by jvinu · jvinu.com · ${when}`);
}
