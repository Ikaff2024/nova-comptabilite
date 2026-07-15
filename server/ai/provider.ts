// ============================================================================
// Extraction de pièce comptable par IA multimodale.
// Contrat : l'IA PROPOSE une écriture (compte SYSCOHADA, TVA, tiers). Elle ne
// valide JAMAIS : la proposition repasse par postEntry (équilibre, immuabilité).
//
// Fournisseur abstrait, sélectionnable par AI_PROVIDER (claude | gemini | openrouter | demo).
// Par défaut "auto" : Claude si ANTHROPIC_API_KEY, sinon Gemini, sinon OpenRouter,
// sinon mode démo.
// Résilience : si OPENROUTER_API_KEY est présent, un échec du fournisseur principal
// bascule automatiquement sur OpenRouter (gateway multi-modèles, compatible OpenAI).
// ⚠️ Confidentialité : OpenRouter est un intermédiaire — activer « no logging/no
// training » côté OpenRouter et router vers un modèle à bonne politique de données.
// ============================================================================

export interface CaptureContext {
  country: string;
  currency: string;
  accountingSystem: string;
  /** Secteur/nature d'activité du dossier : oriente l'imputation (immo vs marchandise…). */
  activity?: string;
  /** Mémoire de codification du dossier (libellé/tiers -> compte), apprise des validations. */
  mappings?: { keyword: string; accountCode: string }[];
  /** Règles manuelles du cabinet : priorité absolue. */
  rules?: { keyword: string; accountCode: string }[];
  /** Plan comptable réel du dossier (classes 4-7) : l'IA DOIT choisir parmi ces codes. */
  chart?: { code: string; label: string }[];
}

export interface ProposedLine {
  accountCode: string;
  accountLabel?: string;
  debit?: number;
  credit?: number;
  label?: string;
}

export interface CaptureProposal {
  description: string;
  entryDate?: string;
  journalCode?: string;
  counterpartyName?: string;
  currency: string;
  confidence: number;
  lines: ProposedLine[];
  warnings?: string[];
}

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.0-flash-001';

const SYSTEM_PROMPT = `Tu es un expert-comptable OHADA (SYSCOHADA révisé, AUDCIF). On te donne l'image d'une pièce (reçu, facture, ticket).
Extrais une écriture comptable EN PARTIE DOUBLE, équilibrée (somme débits = somme crédits), dans la devise du dossier.

RÈGLE ABSOLUE : tu DOIS choisir chaque compte UNIQUEMENT dans le « PLAN COMPTABLE DU DOSSIER » fourni dans le message, en prenant le compte dont l'INTITULÉ correspond le mieux à la nature réelle de l'opération. N'utilise jamais un code absent de cette liste. N'applique PAS les conventions du Plan Comptable Français : seuls les intitulés SYSCOHADA fournis font foi (ex. en SYSCOHADA, les télécommunications ne sont PAS en 626).

Logique de l'écriture :
- ACHAT / dépense : débit du/des compte(s) de charge (classe 6, selon l'intitulé exact) pour le HT ; débit du compte de TVA récupérable (classe 4) pour la TVA ; crédit du moyen de paiement (trésorerie classe 5) si payé, sinon du compte fournisseurs (classe 4).
- VENTE / encaissement : crédit du/des compte(s) de produit (classe 7) pour le HT ; crédit du compte de TVA facturée (classe 4) ; débit du moyen de paiement (classe 5) ou du compte clients (classe 4).
- journalCode : 'AC' pour un achat, 'VE' pour une vente, 'BQ'/'CA' si purement trésorerie.
- Si la TVA n'est pas visible, n'invente pas de ligne de TVA.
- entryDate au format YYYY-MM-DD. confidence entre 0 et 1.

IMPUTATION SELON L'ACTIVITÉ (déterminant) : la nature d'un même bien dépend de l'ACTIVITÉ de l'entreprise (fournie dans le message).
- Un bien destiné à être REVENDU dans le cadre de l'activité est une MARCHANDISE (achat en classe 601/stocks classe 3), PAS une immobilisation. Ex. : un véhicule acheté par un concessionnaire/garage automobile = marchandise ; du matériel informatique acheté par un revendeur d'informatique = marchandise.
- Le MÊME bien, s'il sert durablement l'exploitation (pas revendu), est une IMMOBILISATION (classe 2). Ex. : un véhicule utilisé par un cabinet de services = immobilisation (2451) ; un ordinateur utilisé au bureau = immobilisation (2444).
- Matières premières/intrants transformés par l'activité = classe 602/stocks. Consommables non stockés = classe 60/61/62 selon l'intitulé.
En cas de doute, choisis l'imputation cohérente avec l'activité déclarée et signale-le dans un warning.`;

// Schéma partagé : responseSchema Gemini ET input_schema de l'outil Claude.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    entryDate: { type: 'string', description: 'YYYY-MM-DD' },
    journalCode: { type: 'string' },
    counterpartyName: { type: 'string' },
    currency: { type: 'string' },
    confidence: { type: 'number' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          accountCode: { type: 'string' },
          accountLabel: { type: 'string' },
          debit: { type: 'number' },
          credit: { type: 'number' },
          label: { type: 'string' },
        },
        required: ['accountCode'],
      },
    },
  },
  required: ['description', 'currency', 'lines'],
};

type Provider = 'claude' | 'gemini' | 'openrouter' | 'demo';

function selectProvider(): Provider {
  const pref = (process.env.AI_PROVIDER ?? '').toLowerCase();
  if (pref === 'claude') return process.env.ANTHROPIC_API_KEY ? 'claude' : 'demo';
  if (pref === 'gemini') return process.env.GEMINI_API_KEY ? 'gemini' : 'demo';
  if (pref === 'openrouter') return process.env.OPENROUTER_API_KEY ? 'openrouter' : 'demo';
  if (pref === 'demo') return 'demo';
  if (process.env.ANTHROPIC_API_KEY) return 'claude';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  return 'demo';
}

// OpenRouter sert de secours quand il est configuré et n'est pas déjà le principal.
function fallbackEnabled(primary: Provider): boolean {
  return !!process.env.OPENROUTER_API_KEY && primary !== 'openrouter' && primary !== 'demo';
}

function callProvider(provider: Provider, input: { mimeType: string; dataBase64: string; context: CaptureContext }): Promise<any> {
  if (provider === 'claude') return extractViaClaude(input);
  if (provider === 'gemini') return extractViaGemini(input);
  return extractViaOpenRouter(input);
}

export function aiProvider(): string {
  const p = selectProvider();
  const label = p === 'claude' ? `claude:${CLAUDE_MODEL}` : p === 'gemini' ? `gemini:${GEMINI_MODEL}` : p === 'openrouter' ? `openrouter:${OPENROUTER_MODEL}` : 'demo';
  return fallbackEnabled(p) ? `${label} (+fallback openrouter)` : label;
}

const userText = (ctx: CaptureContext) => {
  let t = `Dossier : pays ${ctx.country}, devise ${ctx.currency}, système ${ctx.accountingSystem}. Extrais l'écriture de cette pièce.`;
  if (ctx.activity?.trim()) {
    t += `\n\nACTIVITÉ DE L'ENTREPRISE (déterminante pour l'imputation immobilisation vs marchandise/stock) : ${ctx.activity.trim()}. Impute chaque bien en cohérence avec cette activité (voir la règle « IMPUTATION SELON L'ACTIVITÉ »).`;
  }
  if (ctx.rules?.length) {
    const rules = ctx.rules.map((r) => `- "${r.keyword}" => ${r.accountCode}`).join('\n');
    t += `\n\nRÈGLES DE CODIFICATION DU CABINET — PRIORITÉ ABSOLUE. Si le libellé ou le tiers de la pièce correspond à l'une de ces règles, tu DOIS utiliser le compte indiqué (elles priment sur tout le reste) :\n${rules}`;
  }
  if (ctx.chart?.length) {
    const plan = ctx.chart.map((a) => `${a.code}\t${a.label}`).join('\n');
    t += `\n\nPLAN COMPTABLE DU DOSSIER (SYSCOHADA — code<TAB>intitulé). Choisis chaque compte dans cette liste, celui dont l'intitulé correspond le mieux :\n${plan}`;
  }
  if (ctx.mappings?.length) {
    const lines = ctx.mappings.slice(0, 40).map((m) => `- "${m.keyword}" -> ${m.accountCode}`).join('\n');
    t += `\n\nCODIFICATION HABITUELLE DE CE DOSSIER (apprise des écritures validées, PRIORITAIRE). Quand le libellé ou le tiers de la pièce correspond à l'une de ces entrées, RÉUTILISE le même compte :\n${lines}`;
  }
  return t;
};

async function withTimeout(ms: number): Promise<{ signal: AbortSignal; done: () => void }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(t) };
}

export async function extractDocument(
  input: { mimeType: string; dataBase64: string; context: CaptureContext },
): Promise<CaptureProposal> {
  const primary = selectProvider();
  if (primary === 'demo') return demoProposal(input.context);
  try {
    return normalize(await callProvider(primary, input), input.context);
  } catch (e: any) {
    if (!fallbackEnabled(primary)) throw e;
    // Bascule automatique sur OpenRouter (quota/panne du fournisseur principal).
    const p = normalize(await extractViaOpenRouter(input), input.context);
    p.warnings = [...(p.warnings ?? []), `Fournisseur principal indisponible (${String(e?.message ?? '').slice(0, 80)}) — bascule automatique sur OpenRouter (${OPENROUTER_MODEL}).`];
    return p;
  }
}

// --- OpenRouter (gateway multi-modèles, API compatible OpenAI) ---------------

async function extractViaOpenRouter(
  input: { mimeType: string; dataBase64: string; context: CaptureContext },
): Promise<any> {
  const key = process.env.OPENROUTER_API_KEY!;
  const dataUri = `data:${input.mimeType || 'image/jpeg'};base64,${input.dataBase64}`;
  const body = {
    model: OPENROUTER_MODEL,
    response_format: { type: 'json_object' },
    temperature: 0.1,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT + '\n\nRéponds UNIQUEMENT par un objet JSON strict : { description, entryDate (YYYY-MM-DD), journalCode, counterpartyName, currency, confidence (0-1), lines: [{ accountCode, accountLabel, debit, credit, label }] }.' },
      { role: 'user', content: [{ type: 'text', text: userText(input.context) }, { type: 'image_url', image_url: { url: dataUri } }] },
    ],
  };

  const { signal, done } = await withTimeout(45000);
  let res: Response;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'HTTP-Referer': 'https://nova-comptabilite.app', 'X-Title': 'Nova Comptabilite' },
      body: JSON.stringify(body), signal,
    });
  } finally { done(); }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OpenRouter indisponible (${res.status}) ${detail.slice(0, 200)}`);
  }
  const data: any = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? '';
  try { return JSON.parse(text); }
  catch { throw new Error('Réponse OpenRouter illisible'); }
}

// --- Claude (Messages API, sortie structurée via tool use) -------------------

async function extractViaClaude(
  input: { mimeType: string; dataBase64: string; context: CaptureContext },
): Promise<any> {
  const key = process.env.ANTHROPIC_API_KEY!;
  const isPdf = input.mimeType === 'application/pdf';
  const mediaBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.dataBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: input.mimeType || 'image/jpeg', data: input.dataBase64 } };

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [{ name: 'enregistrer_ecriture', description: 'Enregistre l\'écriture comptable extraite de la pièce.', input_schema: RESPONSE_SCHEMA }],
    tool_choice: { type: 'tool', name: 'enregistrer_ecriture' },
    messages: [{ role: 'user', content: [{ type: 'text', text: userText(input.context) }, mediaBlock] }],
  };

  const { signal, done } = await withTimeout(45000);
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body), signal,
    });
  } finally { done(); }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Claude indisponible (${res.status}) ${detail.slice(0, 200)}`);
  }
  const data: any = await res.json();
  const tool = (data.content ?? []).find((c: any) => c.type === 'tool_use' && c.name === 'enregistrer_ecriture');
  if (!tool?.input) throw new Error('Réponse Claude sans écriture structurée');
  return tool.input;
}

// --- Gemini (generateContent, responseSchema JSON) ---------------------------

async function extractViaGemini(
  input: { mimeType: string; dataBase64: string; context: CaptureContext },
): Promise<any> {
  const key = process.env.GEMINI_API_KEY!;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{
      role: 'user',
      parts: [
        { text: userText(input.context) },
        { inline_data: { mime_type: input.mimeType, data: input.dataBase64 } },
      ],
    }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, temperature: 0.1 },
  };

  const { signal, done } = await withTimeout(45000);
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  } finally { done(); }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini indisponible (${res.status}) ${detail.slice(0, 200)}`);
  }
  const data: any = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') ?? '';
  try { return JSON.parse(text); }
  catch { throw new Error('Réponse Gemini illisible'); }
}

// --- Normalisation commune ---------------------------------------------------

function normalize(parsed: any, ctx: CaptureContext): CaptureProposal {
  return {
    description: parsed.description ?? 'Pièce capturée',
    entryDate: parsed.entryDate,
    journalCode: parsed.journalCode,
    counterpartyName: parsed.counterpartyName,
    currency: parsed.currency || ctx.currency,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    lines: (parsed.lines ?? []).map((l: any) => ({
      accountCode: String(l.accountCode ?? ''),
      accountLabel: l.accountLabel,
      debit: l.debit ? Number(l.debit) : undefined,
      credit: l.credit ? Number(l.credit) : undefined,
      label: l.label,
    })),
    warnings: parsed.warnings,
  };
}

// Mode démo (sans clé) : proposition plausible pour valider le flux de bout en bout.
function demoProposal(ctx: CaptureContext): CaptureProposal {
  return {
    description: 'Achat fournitures de bureau (démo)',
    entryDate: new Date().toISOString().slice(0, 10),
    journalCode: 'AC',
    counterpartyName: 'Librairie Papeterie',
    currency: ctx.currency,
    confidence: 0.5,
    lines: [
      { accountCode: '6056', accountLabel: 'Achats de fournitures', debit: 25000, label: 'Fournitures de bureau' },
      { accountCode: '445', accountLabel: 'TVA récupérable', debit: 4500, label: 'TVA 18%' },
      { accountCode: '571', accountLabel: 'Caisse', credit: 29500, label: 'Réglé en espèces' },
    ],
    warnings: ['Mode démo : aucune clé IA configurée (ANTHROPIC_API_KEY ou GEMINI_API_KEY). Proposition fictive — vérifiez les montants.'],
  };
}
