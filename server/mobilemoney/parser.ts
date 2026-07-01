// ============================================================================
// Parseur de relevés Mobile Money (Wave, Orange Money, MTN MoMo, Moov).
// Transforme un export CSV (ou un copier-coller) en transactions normalisées,
// puis en propositions d'écritures pré-catégorisées. Comme la capture IA :
// ça PROPOSE — la validation repasse par postEntry (équilibre, dédup, RLS).
// ============================================================================

export type MMProvider = 'wave' | 'om' | 'momo' | 'moov';

export interface MMTransaction {
  externalRef: string;
  date: string;        // YYYY-MM-DD
  direction: 'in' | 'out';
  amount: number;
  counterparty?: string;
  description: string;
  channel: MMProvider;
}

const PROVIDER_LABEL: Record<MMProvider, string> = {
  wave: 'Wave', om: 'Orange Money', momo: 'MTN MoMo', moov: 'Moov Money',
};

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

const IN_KW = /(recu|recue|received|depot|deposit|encaiss|credit|entrant|recharge|transfert recu|paiement recu)/;
const OUT_KW = /(envoy|sent|retrait|withdraw|paiement|payment|achat|decaiss|debit|sortant|frais|fee|transfert envoye)/;

function detectDelimiter(line: string): string {
  const counts = [[';', (line.match(/;/g) || []).length], [',', (line.match(/,/g) || []).length], ['\t', (line.match(/\t/g) || []).length]] as [string, number][];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (ch === delim && !inQ) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseAmount(raw: string): number {
  let s = String(raw).replace(/[^\d.,-]/g, '').trim();
  if (!s) return NaN;
  const neg = s.startsWith('-');
  s = s.replace(/^-/, '');
  const hasDot = s.includes('.'), hasComma = s.includes(',');
  if (hasDot && hasComma) {
    // le séparateur le plus à droite est décimal
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    const dec = s.split(',').pop() ?? '';
    s = dec.length === 2 ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}

function parseDate(raw: string): string {
  const s = String(raw).trim();
  let m = s.match(/(\d{4})[-/](\d{2})[-/](\d{2})/);          // YYYY-MM-DD
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{2})[-/](\d{2})[-/](\d{4})/);              // DD/MM/YYYY
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

function findCol(headers: string[], re: RegExp): number {
  return headers.findIndex((h) => re.test(norm(h)));
}

export function parseStatement(content: string, provider: MMProvider): MMTransaction[] {
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const delim = detectDelimiter(lines[0]);
  const headers = splitCsvLine(lines[0], delim);
  const looksLikeHeader = headers.some((h) => /[a-z]/i.test(h)) && findCol(headers, /date|montant|amount/) !== -1;

  const txs: MMTransaction[] = [];

  if (looksLikeHeader && headers.length > 1) {
    const cDate = findCol(headers, /date|jour/);
    const cAmount = findCol(headers, /montant|amount|valeur/);
    const cType = findCol(headers, /type|sens|operation|nature|transaction/);
    const cParty = findCol(headers, /nom|contrepartie|recipient|sender|destinataire|expediteur|client|tiers|libell|description|motif/);
    const cRef = findCol(headers, /(^id$)|ref|reference|txn|identifiant/);

    for (let i = 1; i < lines.length; i++) {
      const cols = splitCsvLine(lines[i], delim);
      if (cols.length < 2) continue;
      const amountRaw = cAmount >= 0 ? cols[cAmount] : '';
      const amount = parseAmount(amountRaw);
      if (!Number.isFinite(amount) || amount === 0) continue;

      const typeStr = norm([cType >= 0 ? cols[cType] : '', cParty >= 0 ? cols[cParty] : ''].join(' '));
      // IN testé avant OUT : « paiement reçu » est un encaissement (recu prime sur paiement).
      let direction: 'in' | 'out';
      if (amount < 0) direction = 'out';
      else if (IN_KW.test(typeStr)) direction = 'in';
      else if (OUT_KW.test(typeStr)) direction = 'out';
      else direction = 'in';

      const party = cParty >= 0 ? cols[cParty] : undefined;
      const ref = cRef >= 0 && cols[cRef] ? cols[cRef] : `${parseDate(cDate >= 0 ? cols[cDate] : '')}-${Math.abs(amount)}-${i}`;
      txs.push({
        externalRef: `${provider}:${ref}`,
        date: parseDate(cDate >= 0 ? cols[cDate] : ''),
        direction,
        amount: Math.abs(amount),
        counterparty: party || undefined,
        description: `${PROVIDER_LABEL[provider]} — ${direction === 'in' ? 'encaissement' : 'décaissement'}${party ? ' ' + party : ''}`,
        channel: provider,
      });
    }
  } else {
    // Repli texte libre : une transaction par ligne, on extrait montant + sens.
    lines.forEach((line, i) => {
      const amount = parseAmount((line.match(/-?[\d .,]+\d/) || [''])[0]);
      if (!Number.isFinite(amount) || amount === 0) return;
      const n = norm(line);
      const direction: 'in' | 'out' = IN_KW.test(n) ? 'in' : OUT_KW.test(n) ? 'out' : 'in';
      txs.push({
        externalRef: `${provider}:${i}-${Math.abs(amount)}`,
        date: parseDate(line),
        direction,
        amount: Math.abs(amount),
        description: `${PROVIDER_LABEL[provider]} — ${line.slice(0, 60)}`,
        channel: provider,
      });
    });
  }

  return txs.slice(0, 500);
}

// Pré-catégorisation : compte de contrepartie suggéré par défaut.
export function suggestCounterAccount(tx: MMTransaction): string {
  if (tx.direction === 'in') return '701';                    // vente / encaissement
  if (/frais|fee|commission/.test(norm(tx.description))) return '631'; // frais bancaires
  return '6056';                                              // achat / dépense
}
