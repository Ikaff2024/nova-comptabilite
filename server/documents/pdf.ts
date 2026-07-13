import PDFDocument from 'pdfkit';

// ============================================================================
// Génération de PDF côté serveur (pdfkit, pur JS — accents FR via Helvetica).
// Un helper générique « tableau » sert les documents de paie (livre, bulletins,
// déclarations) et pourra servir d'autres restitutions.
// ============================================================================

export interface PdfColumn { label: string; width: number; align?: 'left' | 'right' }
export interface TablePdf {
  title: string;
  subtitle?: string;
  meta?: string[];          // lignes d'entête (employeur, période, identifiants…)
  columns: PdfColumn[];
  rows: string[][];
  totals?: string[];        // ligne de totaux (mêmes colonnes)
  footNote?: string;
}

export function tablePdf(spec: TablePdf): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const bottom = doc.page.height - doc.page.margins.bottom;

    // Entête
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(16).text(spec.title, left, doc.y);
    if (spec.subtitle) { doc.moveDown(0.2); doc.font('Helvetica').fontSize(10).fillColor('#666').text(spec.subtitle); }
    if (spec.meta?.length) { doc.moveDown(0.4); doc.font('Helvetica').fontSize(9).fillColor('#444'); for (const line of spec.meta) doc.text(line); }
    doc.moveDown(0.8);

    const totalW = spec.columns.reduce((s, c) => s + c.width, 0);
    const scale = (right - left) / totalW; // ajuste à la largeur utile
    const widths = spec.columns.map((c) => c.width * scale);
    const xs: number[] = []; let acc = left; for (const w of widths) { xs.push(acc); acc += w; }

    const drawRow = (cells: string[], opts: { bold?: boolean; fill?: string; line?: 'top' | 'none' } = {}) => {
      const rowH = 18;
      if (doc.y + rowH > bottom) { doc.addPage(); doc.y = doc.page.margins.top; drawHeader(); }
      const y = doc.y;
      if (opts.fill) { doc.rect(left, y, right - left, rowH).fill(opts.fill); }
      if (opts.line === 'top') { doc.moveTo(left, y).lineTo(right, y).strokeColor('#ccc').lineWidth(0.5).stroke(); }
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor('#111');
      spec.columns.forEach((col, i) => {
        const cell = cells[i] ?? '';
        doc.text(cell, xs[i] + 3, y + 5, { width: widths[i] - 6, align: col.align ?? 'left', lineBreak: false });
      });
      doc.y = y + rowH;
    };

    function drawHeader() {
      drawRow(spec.columns.map((c) => c.label), { bold: true, fill: '#f0f0f0' });
    }

    drawHeader();
    for (const r of spec.rows) drawRow(r);
    if (spec.totals) drawRow(spec.totals, { bold: true, line: 'top' });

    if (spec.footNote) { doc.moveDown(1); doc.font('Helvetica').fontSize(8).fillColor('#666').text(spec.footNote, left, doc.y, { width: right - left }); }

    doc.end();
  });
}

// --- Gabarit « sections » (label/valeur) : bulletins, fiches ----------------
export interface PdfSection { heading: string; rows: [string, string][]; total?: [string, string] }
export interface SectionsPdf { title: string; subtitle?: string; meta?: string[]; sections: PdfSection[]; grandTotal?: [string, string]; footNote?: string }

export function sectionsPdf(spec: SectionsPdf): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const bottom = doc.page.height - doc.page.margins.bottom;
    const valX = right - 130;

    doc.fillColor('#111').font('Helvetica-Bold').fontSize(16).text(spec.title, left, doc.y);
    if (spec.subtitle) { doc.moveDown(0.2); doc.font('Helvetica').fontSize(10).fillColor('#666').text(spec.subtitle); }
    if (spec.meta?.length) { doc.moveDown(0.4); doc.font('Helvetica').fontSize(9).fillColor('#444'); for (const line of spec.meta) doc.text(line); }
    doc.moveDown(0.6);

    const line = (label: string, value: string, opts: { bold?: boolean; heading?: boolean; top?: boolean } = {}) => {
      const h = opts.heading ? 22 : 16;
      if (doc.y + h > bottom) { doc.addPage(); doc.y = doc.page.margins.top; }
      const y = doc.y;
      if (opts.top) { doc.moveTo(left, y).lineTo(right, y).strokeColor('#ccc').lineWidth(0.5).stroke(); }
      if (opts.heading) {
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111').text(label, left, y + 6);
      } else {
        doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#111');
        doc.text(label, left + 6, y + 4, { width: valX - left - 12, lineBreak: false });
        doc.text(value, valX, y + 4, { width: right - valX, align: 'right', lineBreak: false });
      }
      doc.y = y + h;
    };

    for (const s of spec.sections) {
      line(s.heading, '', { heading: true });
      for (const [l, v] of s.rows) line(l, v);
      if (s.total) line(s.total[0], s.total[1], { bold: true, top: true });
      doc.moveDown(0.3);
    }
    if (spec.grandTotal) line(spec.grandTotal[0], spec.grandTotal[1], { bold: true, top: true });

    if (spec.footNote) { doc.moveDown(1); doc.font('Helvetica').fontSize(8).fillColor('#666').text(spec.footNote, left, doc.y, { width: right - left }); }
    doc.end();
  });
}
