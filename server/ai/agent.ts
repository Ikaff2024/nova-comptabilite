import type { Client } from '../db.js';
import * as acc from '../domain/accounting.js';
import * as analytic from '../domain/analytic.js';
import * as relances from '../domain/relances.js';
import * as purchases from '../domain/purchases.js';
import * as forecast from '../domain/forecast.js';
import * as tax from '../domain/tax.js';
import * as invoicing from '../domain/invoicing.js';
import * as dash from '../domain/dossierdashboard.js';

// ============================================================================
// Assistant comptable agentique (LECTURE SEULE).
// Un agent conversationnel qui répond aux questions de pilotage en interrogeant
// la comptabilité du dossier via des OUTILS = fonctions domaine sûres, exécutées
// dans le périmètre RLS du client `c`. L'agent ne poste JAMAIS d'écriture et
// n'invente aucun chiffre : tout montant vient d'un appel d'outil.
// Boucle tool-use maison sur l'API Messages d'Anthropic (cohérent avec provider.ts).
// ============================================================================

const AGENT_MODEL = process.env.AGENT_MODEL ?? 'claude-opus-4-8';
const MAX_STEPS = 6;

export interface AgentMessage { role: 'user' | 'assistant'; content: string }
export interface AgentToolCall { name: string; input: any }
export interface AgentResult { reply: string; toolCalls: AgentToolCall[]; model: string }

export function agentEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

// --- Contexte dossier (mis en cache dans le system prompt) -------------------

async function dossierContext(c: Client, dossierId: string): Promise<{ text: string; fyId: string | null }> {
  const { rows } = await c.query(
    'select raison_sociale, base_currency, country from dossiers where id=$1', [dossierId]);
  const d = rows[0] ?? {};
  const fys = await acc.listFiscalYears(c, dossierId);
  const openFy = fys.find((f: any) => f.status && f.status !== 'closed') ?? fys[fys.length - 1] ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const fyLine = openFy ? `Exercice courant : « ${openFy.label} » (${openFy.start_date} → ${openFy.end_date}), statut ${openFy.status}.` : 'Aucun exercice défini.';
  const text = `DOSSIER : ${d.raison_sociale ?? '—'} — pays ${d.country ?? 'CI'}, devise ${d.base_currency ?? 'XOF'}, référentiel SYSCOHADA révisé (AUDCIF).
${fyLine}
Date du jour : ${today}.`;
  return { text, fyId: openFy?.id ?? null };
}

const SYSTEM_GUARDRAILS = `Tu es l'assistant comptable de Nova, expert du référentiel OHADA (SYSCOHADA révisé, AUDCIF). Tu aides le comptable/dirigeant à PILOTER l'entreprise en langage naturel.

RÈGLES ABSOLUES :
1. Tu es en LECTURE SEULE. Tu ne crées, ne modifies et ne postes JAMAIS d'écriture. Si on te le demande, explique que la saisie se fait dans les onglets dédiés (l'utilisateur valide toujours).
2. Tu n'inventes AUCUN chiffre. Chaque montant, solde ou statut que tu cites DOIT provenir d'un appel d'outil dans cette conversation. Si tu n'as pas la donnée, appelle l'outil approprié ; si aucun outil ne convient, dis-le franchement.
3. Cite tes sources : mentionne le compte (code + intitulé), le tiers, l'écriture ou la période d'où vient chaque chiffre.
4. Réponds en français, de façon concise et actionnable. Formate les montants avec la devise du dossier. Pour une synthèse, va droit au but (résultat d'abord, détail ensuite).
5. Raisonne comme un expert-comptable OHADA : classes 1-9, partie double, TVA, lettrage, analytique, immobilisations, balance âgée.

Utilise les outils pour obtenir les données réelles avant de conclure. Enchaîne plusieurs outils si nécessaire (ex. balance puis grand livre d'un compte). Ne montre pas le JSON brut des outils : synthétise.`;

// --- Définition des outils (lecture seule) -----------------------------------

const TOOLS = [
  { name: 'situation_generale', description: 'Tableau de bord du dossier : trésorerie, résultat, créances/dettes, activité récente. À utiliser pour une vue d\'ensemble.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'balance_generale', description: 'Balance générale (par compte : à-nouveaux, mouvements, soldes). Pour analyser les soldes de comptes.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'grand_livre', description: 'Détail des écritures d\'un compte donné (grand livre). Fournir le code du compte.', input_schema: { type: 'object', properties: { compte: { type: 'string', description: 'Code du compte SYSCOHADA, ex. 411, 521, 601' } }, required: ['compte'] } },
  { name: 'etats_financiers', description: 'États financiers de synthèse : bilan et compte de résultat.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'resultat_analytique', description: 'Résultat par section analytique (centres de coût / points de vente) : produits, charges, résultat.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'detail_analytique', description: 'Détail des charges/produits d\'une section analytique donnée (par son code).', input_schema: { type: 'object', properties: { section: { type: 'string', description: 'Code de la section analytique, ex. COCODY' } }, required: ['section'] } },
  { name: 'creances_clients', description: 'Balance âgée clients : qui doit de l\'argent, montants et ancienneté (0-30, 31-60, 61-90, +90 jours).', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'dettes_fournisseurs', description: 'Balance âgée fournisseurs : ce que l\'entreprise doit, par tiers et ancienneté.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'previsionnel_tresorerie', description: 'Prévision de trésorerie sur les prochaines semaines (encaissements/décaissements attendus).', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'tva', description: 'Situation de TVA (collectée, déductible, à payer/crédit) sur une période. Fournir les dates de début et fin (YYYY-MM-DD).', input_schema: { type: 'object', properties: { debut: { type: 'string', description: 'YYYY-MM-DD' }, fin: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['debut', 'fin'] } },
  { name: 'factures_ventes', description: 'Liste des factures de vente (optionnellement filtrées par statut : draft, issued, paid).', input_schema: { type: 'object', properties: { statut: { type: 'string' } }, required: [] } },
  { name: 'factures_achats', description: 'Liste des factures fournisseurs (optionnellement filtrées par statut : draft, recorded, paid).', input_schema: { type: 'object', properties: { statut: { type: 'string' } }, required: [] } },
];

// Tronque une sortie volumineuse pour maîtriser les tokens.
function cap<T>(rows: T[], n = 60): T[] { return Array.isArray(rows) && rows.length > n ? rows.slice(0, n) : rows; }

async function executeTool(c: Client, dossierId: string, fyId: string | null, name: string, input: any): Promise<any> {
  const fy = fyId ?? undefined;
  switch (name) {
    case 'situation_generale': return await dash.dossierDashboard(c, dossierId, fy);
    case 'balance_generale': return cap(await acc.trialBalance(c, dossierId, fy), 120);
    case 'grand_livre': return cap(await acc.generalLedger(c, dossierId, { fiscalYearId: fy, accountCode: String(input?.compte ?? '') }), 100);
    case 'etats_financiers': return await acc.financialStatements(c, dossierId, fy);
    case 'resultat_analytique': return await analytic.analyticReport(c, dossierId, fy);
    case 'detail_analytique': return await analytic.analyticDetail(c, dossierId, String(input?.section ?? ''), fy);
    case 'creances_clients': return await relances.overdueClients(c, dossierId);
    case 'dettes_fournisseurs': return await purchases.supplierAging(c, dossierId);
    case 'previsionnel_tresorerie': return await forecast.cashForecast(c, dossierId, {});
    case 'tva': return await tax.vatDeclaration(c, dossierId, String(input?.debut ?? ''), String(input?.fin ?? ''));
    case 'factures_ventes': return cap(await invoicing.listInvoices(c, dossierId, input?.statut, 'invoice'), 50);
    case 'factures_achats': return cap(await purchases.listPurchases(c, dossierId, input?.statut), 50);
    default: return { error: `Outil inconnu : ${name}` };
  }
}

// --- Boucle agentique --------------------------------------------------------

async function callClaude(body: any): Promise<any> {
  const key = process.env.ANTHROPIC_API_KEY!;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 60000);
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body), signal: controller.signal,
    });
  } finally { clearTimeout(t); }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Assistant indisponible (${res.status}) ${detail.slice(0, 200)}`);
  }
  return res.json();
}

// Exécute un outil isolément (pour vérification déterministe, sans appel LLM).
export async function runToolForTest(c: Client, dossierId: string, name: string, input: any = {}): Promise<any> {
  const { fyId } = await dossierContext(c, dossierId);
  return executeTool(c, dossierId, fyId, name, input);
}

export async function runAgent(c: Client, dossierId: string, history: AgentMessage[]): Promise<AgentResult> {
  if (!agentEnabled()) throw new Error('Assistant IA non configuré (ANTHROPIC_API_KEY absent).');
  const { text: ctx, fyId } = await dossierContext(c, dossierId);

  // system : garde-fous statiques (mis en cache) + contexte dossier.
  const system = [
    { type: 'text', text: SYSTEM_GUARDRAILS, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: ctx },
  ];

  // Conversation. Le contenu utilisateur/assistant est du texte simple.
  const messages: any[] = history.slice(-16).map((m) => ({ role: m.role, content: m.content }));

  const toolCalls: AgentToolCall[] = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    const data = await callClaude({
      model: AGENT_MODEL, max_tokens: 2048, system, tools: TOOLS, messages,
    });
    const content: any[] = data.content ?? [];
    messages.push({ role: 'assistant', content });

    if (data.stop_reason === 'tool_use') {
      const toolResults: any[] = [];
      for (const block of content) {
        if (block.type !== 'tool_use') continue;
        toolCalls.push({ name: block.name, input: block.input });
        let result: any;
        try { result = await executeTool(c, dossierId, fyId, block.name, block.input); }
        catch (e: any) { result = { error: String(e?.message ?? e).slice(0, 200) }; }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Réponse finale : concatène les blocs texte.
    const reply = content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return { reply: reply || 'Je n\'ai pas de réponse.', toolCalls, model: AGENT_MODEL };
  }
  return { reply: 'La demande a nécessité trop d\'étapes. Reformulez de façon plus ciblée.', toolCalls, model: AGENT_MODEL };
}
