// ============================================================================
// Extraction d'un RELEVÉ BANCAIRE (PDF ou photo) par IA — multi-transactions.
// Distinct de la Capture (1 pièce = 1 écriture) : ici on lit la LISTE des
// opérations pour alimenter le rapprochement. On ne comptabilise rien
// automatiquement — l'utilisateur vérifie les lignes extraites.
//
// Module autonome (n'utilise pas les helpers privés de provider.ts). Il accepte
// les MÊMES fournisseurs que la Capture — Claude, Gemini, OpenRouter — et c'est
// délibéré : le scanner ne connaissait que Claude et OpenRouter, si bien qu'une
// installation configurée en Gemini voyait le bouton « Scanner un relevé » et se
// heurtait à un refus du serveur. Le rapprochement paraissait alors n'accepter
// que le CSV, alors que le chemin PDF existait depuis toujours.
// ============================================================================

const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001';
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.0-flash-001';

export interface StatementTx { date: string; label: string; debit: number; credit: number }
export interface StatementExtraction {
  transactions: StatementTx[];
  openingBalance: number | null;
  closingBalance: number | null;
  currency: string | null;
  confidence: number;
  boucle: { verifiable: boolean; ok: boolean; ecart: number };
  warnings: string[];
}

export function statementExtractionAvailable(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY);
}

/** Fournisseur retenu, pour que l'écran puisse le dire au lieu d'un refus sec. */
export function statementProvider(): string {
  if (process.env.ANTHROPIC_API_KEY) return `claude:${CLAUDE_MODEL}`;
  if (process.env.GEMINI_API_KEY) return `gemini:${GEMINI_MODEL}`;
  if (process.env.OPENROUTER_API_KEY) return `openrouter:${OPENROUTER_MODEL}`;
  return 'demo';
}

const STATEMENT_SYSTEM = [
  'Tu lis un RELEVÉ DE COMPTE BANCAIRE (PDF ou image). Extrais TOUTES les lignes d’opérations, dans l’ordre du relevé.',
  'Règles :',
  '- Une ligne = une opération : date, libellé, et le montant soit en DÉBIT (sortie/retrait), soit en CRÉDIT (entrée/dépôt). Jamais les deux.',
  '- N’invente aucune ligne. N’inclus PAS les lignes de solde, de report, ni les totaux.',
  '- Dates au format AAAA-MM-JJ. Montants en nombres positifs, sans séparateur de milliers ni symbole.',
  '- Donne aussi le solde d’ouverture (openingBalance) et le solde de clôture (closingBalance) s’ils figurent, sinon null.',
].join('\n');

const STATEMENT_SCHEMA = {
  type: 'object',
  properties: {
    currency: { type: ['string', 'null'] },
    openingBalance: { type: ['number', 'null'] },
    closingBalance: { type: ['number', 'null'] },
    confidence: { type: 'number' },
    transactions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'AAAA-MM-JJ' },
          label: { type: 'string' },
          debit: { type: 'number', description: 'sortie (0 si crédit)' },
          credit: { type: 'number', description: 'entrée (0 si débit)' },
        },
        required: ['date', 'label'],
      },
    },
  },
  required: ['transactions'],
} as const;

// Gemini n'accepte pas les types union (`type: ['string','null']`) : son schéma
// suit un sous-ensemble d'OpenAPI où l'absence se déclare par `nullable`.
const STATEMENT_SCHEMA_GEMINI = {
  type: 'object',
  properties: {
    currency: { type: 'string', nullable: true },
    openingBalance: { type: 'number', nullable: true },
    closingBalance: { type: 'number', nullable: true },
    confidence: { type: 'number' },
    transactions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'AAAA-MM-JJ' },
          label: { type: 'string' },
          debit: { type: 'number', description: 'sortie (0 si crédit)' },
          credit: { type: 'number', description: 'entrée (0 si débit)' },
        },
        required: ['date', 'label'],
      },
    },
  },
  required: ['transactions'],
} as const;

const abs = (v: any) => { const n = Number(v); return Number.isFinite(n) ? Math.abs(n) : 0; };

async function withTimeout(ms: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(t) };
}

function normalize(raw: any): StatementExtraction {
  const tx = Array.isArray(raw?.transactions) ? raw.transactions : [];
  const transactions: StatementTx[] = tx
    .map((t: any) => ({ date: String(t?.date ?? '').slice(0, 10), label: String(t?.label ?? '').trim(), debit: abs(t?.debit), credit: abs(t?.credit) }))
    .filter((t: StatementTx) => /^\d{4}-\d{2}-\d{2}$/.test(t.date) && (t.debit > 0 || t.credit > 0));

  const opening = raw?.openingBalance == null ? null : Number(raw.openingBalance);
  const closing = raw?.closingBalance == null ? null : Number(raw.closingBalance);
  const mouvement = transactions.reduce((s, t) => s + t.credit - t.debit, 0);
  const verifiable = opening != null && closing != null && Number.isFinite(opening) && Number.isFinite(closing);
  const ecart = verifiable ? Math.round((opening! + mouvement - closing!) * 100) / 100 : 0;
  const warnings: string[] = [];
  if (verifiable && Math.abs(ecart) > 1) warnings.push(`Le solde ne boucle pas (écart ${ecart}) : vérifiez les lignes extraites, une opération a pu être manquée ou mal lue.`);
  if (!transactions.length) warnings.push('Aucune opération lisible extraite du relevé.');

  return {
    transactions, openingBalance: opening, closingBalance: closing,
    currency: raw?.currency ?? null,
    confidence: Math.max(0, Math.min(1, Number(raw?.confidence) || 0.6)),
    boucle: { verifiable, ok: verifiable ? Math.abs(ecart) <= 1 : true, ecart },
    warnings,
  };
}

// CSV normalisé (en-tête reconnu par parseStatement) : réutilise le moteur de
// rapprochement existant, sans le modifier.
export function statementToCsv(ext: StatementExtraction): string {
  const esc = (s: string) => (/[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const body = ext.transactions.map((t) => [t.date, esc(t.label), t.debit || '', t.credit || ''].join(';'));
  return ['Date;Libellé;Débit;Crédit', ...body].join('\n');
}

export async function extractStatement(input: { mimeType: string; dataBase64: string }): Promise<StatementExtraction> {
  const hasClaude = !!process.env.ANTHROPIC_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;
  const hasOR = !!process.env.OPENROUTER_API_KEY;

  // Ordre de repli : un fournisseur qui tombe ne doit pas renvoyer l'utilisateur
  // au CSV. On essaie les suivants avant d'abandonner.
  const chaine: { nom: string; appel: () => Promise<any> }[] = [];
  if (hasClaude) chaine.push({ nom: 'Claude', appel: () => viaClaude(input) });
  if (hasGemini) chaine.push({ nom: 'Gemini', appel: () => viaGemini(input) });
  if (hasOR) chaine.push({ nom: 'OpenRouter', appel: () => viaOpenRouter(input) });

  if (chaine.length > 0) {
    let derniere: any;
    for (let i = 0; i < chaine.length; i++) {
      try {
        const r = normalize(await chaine[i].appel());
        if (i > 0) r.warnings.push(`${chaine[0].nom} indisponible — extraction par ${chaine[i].nom}.`);
        return r;
      } catch (e) { derniere = e; }
    }
    throw derniere;
  }

  // Sans aucune clé : jeu d'essai, pour que le parcours reste démontrable.
  const demo = normalize({
    transactions: [
      { date: '2026-07-03', label: 'VIREMENT CLIENT AWA', credit: 380000 },
      { date: '2026-07-06', label: 'ACHAT GROSSISTE ADJAME', debit: 180000 },
      { date: '2026-07-10', label: 'LOYER BOUTIQUE', debit: 120000 },
    ], openingBalance: 0, closingBalance: 80000, currency: 'XOF', confidence: 0.9,
  });
  demo.warnings.push("Aucun fournisseur d'IA configuré : opérations de démonstration, à ne pas prendre pour votre relevé.");
  return demo;
}

// --- Gemini (generateContent, responseSchema JSON) ---------------------------
// Même endpoint que la Capture : Gemini lit nativement un PDF comme une image.
async function viaGemini(input: { mimeType: string; dataBase64: string }): Promise<any> {
  const key = process.env.GEMINI_API_KEY!;
  const body = {
    systemInstruction: { parts: [{ text: STATEMENT_SYSTEM }] },
    contents: [{
      role: 'user',
      parts: [
        { text: 'Extrais toutes les opérations de ce relevé bancaire.' },
        { inline_data: { mime_type: input.mimeType || 'application/pdf', data: input.dataBase64 } },
      ],
    }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: STATEMENT_SCHEMA_GEMINI, temperature: 0.1 },
  };
  const { signal, done } = await withTimeout(60000);
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
  } finally { done(); }
  if (!res.ok) throw new Error(`Gemini indisponible (${res.status}) ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data: any = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') ?? '';
  try { return JSON.parse(text); } catch { throw new Error('Réponse Gemini illisible'); }
}

async function viaClaude(input: { mimeType: string; dataBase64: string }): Promise<any> {
  const key = process.env.ANTHROPIC_API_KEY!;
  const isPdf = input.mimeType === 'application/pdf';
  const mediaBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.dataBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: input.mimeType || 'image/jpeg', data: input.dataBase64 } };
  const body = {
    model: CLAUDE_MODEL, max_tokens: 4096, system: STATEMENT_SYSTEM,
    tools: [{ name: 'enregistrer_releve', description: 'Enregistre les opérations extraites du relevé.', input_schema: STATEMENT_SCHEMA }],
    tool_choice: { type: 'tool', name: 'enregistrer_releve' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Extrais toutes les opérations de ce relevé bancaire.' }, mediaBlock] }],
  };
  const { signal, done } = await withTimeout(60000);
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body), signal,
    });
  } finally { done(); }
  if (!res.ok) throw new Error(`Claude indisponible (${res.status}) ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data: any = await res.json();
  const tool = (data.content ?? []).find((cc: any) => cc.type === 'tool_use' && cc.name === 'enregistrer_releve');
  if (!tool) throw new Error('Réponse Claude sans extraction de relevé');
  return tool.input;
}

async function viaOpenRouter(input: { mimeType: string; dataBase64: string }): Promise<any> {
  const key = process.env.OPENROUTER_API_KEY!;
  const dataUri = `data:${input.mimeType || 'image/jpeg'};base64,${input.dataBase64}`;
  const body = {
    model: OPENROUTER_MODEL, response_format: { type: 'json_object' }, temperature: 0.1, max_tokens: 4096,
    messages: [
      { role: 'system', content: STATEMENT_SYSTEM + '\n\nRéponds UNIQUEMENT par un JSON strict : { currency, openingBalance, closingBalance, confidence, transactions: [{ date, label, debit, credit }] }.' },
      { role: 'user', content: [{ type: 'text', text: 'Extrais toutes les opérations de ce relevé bancaire.' }, { type: 'image_url', image_url: { url: dataUri } }] },
    ],
  };
  const { signal, done } = await withTimeout(60000);
  let res: Response;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal,
    });
  } finally { done(); }
  if (!res.ok) throw new Error(`OpenRouter indisponible (${res.status})`);
  const data: any = await res.json();
  try { return JSON.parse(data?.choices?.[0]?.message?.content ?? '{}'); }
  catch { throw new Error('Réponse OpenRouter illisible'); }
}
