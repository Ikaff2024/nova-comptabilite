// Parseur de relevé bancaire (CSV tolérant). Produit des lignes normalisées avec
// un montant SIGNÉ du point de vue du titulaire : + encaissement, − décaissement.

export interface StatementRow { date: string; label: string; amount: number }

function num(s: string): number {
  if (!s) return 0;
  const cleaned = String(s).replace(/[\s  ']/g, '').replace(/,/g, '.').replace(/[^0-9.\-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function splitDelim(line: string): string[] {
  const delim = line.includes(';') ? ';' : line.includes('\t') ? '\t' : ',';
  return line.split(delim).map((s) => s.trim().replace(/^"|"$/g, ''));
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Normalise une date en 'YYYY-MM-DD' depuis YYYY-MM-DD ou DD/MM/YYYY (ou DD-MM-YYYY).
function toIso(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

export function parseStatement(text: string): StatementRow[] {
  const rows = String(text).split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  if (rows.length === 0) return [];

  let map = { date: 0, label: 1, debit: -1, credit: -1, amount: -1 } as Record<string, number>;
  let start = 0;
  const first = splitDelim(rows[0]).map(norm);
  const looksHeader = first.some((h) => /date|libell|intitul|debit|credit|montant|solde|operation/.test(h));
  if (looksHeader) {
    start = 1;
    const find = (...keys: string[]) => first.findIndex((h) => keys.some((k) => h.includes(k)));
    map = {
      date: Math.max(find('date'), 0),
      label: Math.max(find('libell', 'intitul', 'operation', 'nature', 'motif'), 1),
      debit: find('debit', 'retrait'),
      credit: find('credit', 'depot', 'versement'),
      amount: find('montant'),
    };
  }

  const out: StatementRow[] = [];
  for (let i = start; i < rows.length; i++) {
    const cells = splitDelim(rows[i]);
    const date = toIso(cells[map.date] ?? '');
    if (!date) continue; // ignore lignes sans date valide (en-têtes de solde, totaux)
    const label = (cells[map.label] ?? '').trim();
    let amount = 0;
    if (map.debit >= 0 || map.credit >= 0) {
      const d = map.debit >= 0 ? num(cells[map.debit]) : 0;
      const cr = map.credit >= 0 ? num(cells[map.credit]) : 0;
      amount = cr - d; // crédit (entrée) positif, débit (sortie) négatif
    } else if (map.amount >= 0) {
      amount = num(cells[map.amount]);
    }
    if (amount === 0) continue;
    out.push({ date, label: label || '(sans libellé)', amount: Math.round(amount * 100) / 100 });
  }
  return out;
}
