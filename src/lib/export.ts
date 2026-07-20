// Exports transversaux : CSV (Excel) et PDF (fenêtre d'impression), sans dépendance.

// --- CSV (séparateur ; + BOM UTF-8 : s'ouvre proprement dans Excel FR) ---
export function downloadCsv(filename: string, rows: (string | number)[][]): void {
  const esc = (v: string | number) => {
    const s = String(v ?? '');
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map((r) => r.map(esc).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, filename.endsWith('.csv') ? filename : `${filename}.csv`);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- PDF : ouvre un document imprimable propre (Ctrl+P -> Enregistrer en PDF) ---
export function printDocument(title: string, subtitle: string, bodyHtml: string): void {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>
    *{font-family:Arial,Helvetica,sans-serif;color:#111}
    body{margin:24px;font-size:11px}
    h1{font-size:16px;margin:0 0 2px} .sub{color:#555;margin-bottom:12px;font-size:11px}
    table{width:100%;border-collapse:collapse}
    th,td{padding:3px 6px;border-bottom:1px solid #ddd}
    th{background:#f3f3f3;text-align:left;font-size:10px;text-transform:uppercase}
    td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
    tr.grp td{background:#eee;font-weight:bold;border-top:1px solid #999}
    tr.tot td{font-weight:bold;border-top:2px solid #111}
    @media print{body{margin:10mm}}
  </style></head><body>
    <h1>${esc(title)}</h1><div class="sub">${esc(subtitle)}</div>
    ${bodyHtml}
    <p style="color:#888;margin-top:18px;font-size:9px">Généré par Nova Comptabilité</p>
  </body></html>`;
  // Impression via un IFRAME CACHÉ plutôt qu'un onglet : window.open laissait
  // une page « about:blank » ouverte après l'aperçu, et se faisait bloquer par
  // les bloqueurs de pop-ups. Ici, rien n'apparaît et tout se nettoie seul.
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);

  const win = frame.contentWindow;
  if (!win) { frame.remove(); return; }
  win.document.open();
  win.document.write(html);
  win.document.close();

  let cleaned = false;
  const cleanup = () => { if (cleaned) return; cleaned = true; setTimeout(() => frame.remove(), 300); };
  win.onafterprint = cleanup;

  setTimeout(() => {
    try { win.focus(); win.print(); } catch { cleanup(); return; }
    // Filet de sécurité : certains navigateurs ne déclenchent pas onafterprint.
    setTimeout(cleanup, 60000);
  }, 250);
}

export function nowStamp(): string { return new Date().toLocaleDateString('fr-FR'); }
