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
export interface AgentResult { reply: string; toolCalls: AgentToolCall[]; model: string; mode: AgentMode }

export type AgentMode = 'readonly' | 'assist';

export function agentEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

// Mode de l'agent pour un dossier (défaut 'readonly').
export async function getAgentMode(c: Client, dossierId: string): Promise<AgentMode> {
  const { rows } = await c.query('select agent_mode from dossiers where id=$1', [dossierId]);
  return (rows[0]?.agent_mode === 'assist' ? 'assist' : 'readonly');
}

// Bascule du mode — réservée owner/associé (garde en base, fonction SECURITY DEFINER).
export async function setAgentMode(c: Client, dossierId: string, mode: AgentMode): Promise<void> {
  await c.query('select dossier_set_agent_mode($1,$2)', [dossierId, mode]);
}

export async function isDossierAdmin(c: Client, dossierId: string): Promise<boolean> {
  const { rows } = await c.query('select dossier_is_admin($1) as ok', [dossierId]);
  return rows[0]?.ok === true;
}

// --- Contexte dossier (mis en cache dans le system prompt) -------------------

async function dossierContext(c: Client, dossierId: string): Promise<{ text: string; fyId: string | null; currency: string; mode: AgentMode }> {
  const { rows } = await c.query(
    'select raison_sociale, base_currency, country, agent_mode from dossiers where id=$1', [dossierId]);
  const d = rows[0] ?? {};
  const fys = await acc.listFiscalYears(c, dossierId);
  const openFy = fys.find((f: any) => f.status && f.status !== 'closed') ?? fys[fys.length - 1] ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const fyLine = openFy ? `Exercice courant : « ${openFy.label} » (${openFy.start_date} → ${openFy.end_date}), statut ${openFy.status}.` : 'Aucun exercice défini.';
  const text = `DOSSIER : ${d.raison_sociale ?? '—'} — pays ${d.country ?? 'CI'}, devise ${d.base_currency ?? 'XOF'}, référentiel SYSCOHADA révisé (AUDCIF).
${fyLine}
Date du jour : ${today}.`;
  return { text, fyId: openFy?.id ?? null, currency: d.base_currency ?? 'XOF', mode: d.agent_mode === 'assist' ? 'assist' : 'readonly' };
}

const SYSTEM_GUARDRAILS = `Tu es l'assistant comptable de Nova, expert du référentiel OHADA (SYSCOHADA révisé, AUDCIF). Tu aides le comptable/dirigeant à PILOTER l'entreprise en langage naturel.

RÈGLES ABSOLUES :
1. Tu es en LECTURE SEULE. Tu ne crées, ne modifies et ne postes JAMAIS d'écriture. Si on te le demande, explique que la saisie se fait dans les onglets dédiés (l'utilisateur valide toujours).
2. Tu n'inventes AUCUN chiffre. Chaque montant, solde ou statut que tu cites DOIT provenir d'un appel d'outil dans cette conversation. Si tu n'as pas la donnée, appelle l'outil approprié ; si aucun outil ne convient, dis-le franchement.
3. Cite tes sources : mentionne le compte (code + intitulé), le tiers, l'écriture ou la période d'où vient chaque chiffre.
4. Réponds en français, de façon concise et actionnable. Formate les montants avec la devise du dossier. Pour une synthèse, va droit au but (résultat d'abord, détail ensuite).
5. Raisonne comme un expert-comptable OHADA : classes 1-9, partie double, TVA, lettrage, analytique, immobilisations, balance âgée.

Utilise les outils pour obtenir les données réelles avant de conclure. Enchaîne plusieurs outils si nécessaire (ex. balance puis grand livre d'un compte). Ne montre pas le JSON brut des outils : synthétise.`;

// Note ajoutée UNIQUEMENT en mode assisté (l'admin l'a activé).
const ASSIST_NOTE = `
MODE ASSISTÉ ACTIVÉ : tu peux PRÉPARER des BROUILLONS via les outils "preparer_*" (facture de vente, facture fournisseur). Règles impératives :
- Un brouillon n'a AUCUN effet comptable tant que l'humain ne l'émet/comptabilise pas dans l'onglet correspondant. Tu ne fais JAMAIS cette validation toi-même.
- Après avoir créé un brouillon, annonce-le clairement comme un BROUILLON À VALIDER (dans « Facturation » pour une vente, « Achats » pour un achat), et récapitule ce que tu as saisi (tiers, lignes, montants) pour que l'humain vérifie.
- Ne prépare un brouillon que si la demande est explicite et suffisamment précise. Si un élément manque (montant, tiers, compte), demande-le avant de créer.
- Tu ne postes/émets/règles/clôtures JAMAIS. Ces actions restent 100 % humaines.`;

// --- Outils de LECTURE (toujours disponibles) --------------------------------

const READ_TOOLS = [
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

// --- Outils d'ÉCRITURE (mode assisté uniquement) : créent des BROUILLONS ------
// Aucun n'entre au grand livre : l'humain émet/comptabilise dans l'onglet dédié.

const WRITE_TOOLS = [
  {
    name: 'preparer_facture_vente',
    description: 'Prépare une facture de VENTE en BROUILLON (à émettre ensuite par l\'humain dans l\'onglet Facturation). N\'a aucun effet comptable tant qu\'elle n\'est pas émise.',
    input_schema: {
      type: 'object',
      properties: {
        client: { type: 'string', description: 'Nom du client' },
        date: { type: 'string', description: 'Date de facture YYYY-MM-DD (défaut : aujourd\'hui)' },
        echeance: { type: 'string', description: 'Date d\'échéance YYYY-MM-DD (optionnel)' },
        lignes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantite: { type: 'number' },
              prix_unitaire: { type: 'number' },
              taux_tva: { type: 'number', description: 'ex. 0.18 pour 18% (défaut 0.18)' },
              compte: { type: 'string', description: 'Compte de produit classe 7 (défaut 706)' },
              section: { type: 'string', description: 'Code section analytique (optionnel)' },
            },
            required: ['description', 'quantite', 'prix_unitaire'],
          },
        },
      },
      required: ['client', 'lignes'],
    },
  },
  {
    name: 'preparer_facture_achat',
    description: 'Prépare une facture FOURNISSEUR en BROUILLON (à comptabiliser ensuite par l\'humain dans l\'onglet Achats). N\'a aucun effet comptable tant qu\'elle n\'est pas comptabilisée.',
    input_schema: {
      type: 'object',
      properties: {
        fournisseur: { type: 'string' },
        reference: { type: 'string', description: 'N° de facture du fournisseur (optionnel)' },
        date: { type: 'string', description: 'YYYY-MM-DD (défaut aujourd\'hui)' },
        echeance: { type: 'string', description: 'YYYY-MM-DD (optionnel)' },
        lignes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              compte: { type: 'string', description: 'Compte de charge/immo (défaut 601)' },
              montant_ht: { type: 'number' },
              taux_tva: { type: 'number', description: 'ex. 0.18 (défaut 0.18)' },
              section: { type: 'string', description: 'Code section analytique (optionnel)' },
            },
            required: ['description', 'montant_ht'],
          },
        },
      },
      required: ['fournisseur', 'lignes'],
    },
  },
];

const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));

// Tronque une sortie volumineuse pour maîtriser les tokens.
function cap<T>(rows: T[], n = 60): T[] { return Array.isArray(rows) && rows.length > n ? rows.slice(0, n) : rows; }

async function executeTool(c: Client, dossierId: string, fyId: string | null, name: string, input: any, mode: AgentMode): Promise<any> {
  const fy = fyId ?? undefined;
  const today = new Date().toISOString().slice(0, 10);

  // Garde-fou serveur : les outils d'écriture n'existent qu'en mode assisté.
  if (WRITE_TOOL_NAMES.has(name) && mode !== 'assist') {
    return { error: 'Mode lecture seule : la préparation de brouillons est désactivée pour ce dossier.' };
  }

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

    // --- Écriture : BROUILLONS (mode assisté) ---
    case 'preparer_facture_vente': {
      const lignes = Array.isArray(input?.lignes) ? input.lignes : [];
      const { id } = await invoicing.createInvoice(c, dossierId, {
        clientName: String(input?.client ?? '').trim(), invoiceDate: input?.date || today, dueDate: input?.echeance || undefined, docType: 'invoice',
        lines: lignes.map((l: any) => ({ description: l.description, quantity: Number(l.quantite) || 1, unit_price: Number(l.prix_unitaire) || 0, vat_rate: l.taux_tva != null ? Number(l.taux_tva) : 0.18, account_code: l.compte || '706', analytic_axis: l.section || undefined })),
      });
      return { statut: 'brouillon_cree', type: 'facture_vente', brouillon_id: id, a_valider_dans: 'onglet Facturation (bouton Émettre)' };
    }
    case 'preparer_facture_achat': {
      const lignes = Array.isArray(input?.lignes) ? input.lignes : [];
      const { id } = await purchases.createPurchase(c, dossierId, {
        supplierName: String(input?.fournisseur ?? '').trim(), supplierRef: input?.reference || undefined, invoiceDate: input?.date || today, dueDate: input?.echeance || undefined,
        lines: lignes.map((l: any) => ({ description: l.description, accountCode: l.compte || '601', amountHt: Number(l.montant_ht) || 0, vatRate: l.taux_tva != null ? Number(l.taux_tva) : 0.18, analyticAxis: l.section || undefined })),
      });
      return { statut: 'brouillon_cree', type: 'facture_achat', brouillon_id: id, a_valider_dans: 'onglet Achats (bouton Comptabiliser)' };
    }

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
  const { fyId, mode } = await dossierContext(c, dossierId);
  return executeTool(c, dossierId, fyId, name, input, mode);
}

export async function runAgent(c: Client, dossierId: string, history: AgentMessage[]): Promise<AgentResult> {
  if (!agentEnabled()) throw new Error('Assistant IA non configuré (ANTHROPIC_API_KEY absent).');
  const { text: ctx, fyId, mode } = await dossierContext(c, dossierId);
  const tools = mode === 'assist' ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;

  // system : garde-fous statiques (mis en cache) + note de mode + contexte dossier.
  const system = [
    { type: 'text', text: SYSTEM_GUARDRAILS + (mode === 'assist' ? ASSIST_NOTE : ''), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: ctx },
  ];

  // Conversation. Le contenu utilisateur/assistant est du texte simple.
  const messages: any[] = history.slice(-16).map((m) => ({ role: m.role, content: m.content }));

  const toolCalls: AgentToolCall[] = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    const data = await callClaude({
      model: AGENT_MODEL, max_tokens: 2048, system, tools, messages,
    });
    const content: any[] = data.content ?? [];
    messages.push({ role: 'assistant', content });

    if (data.stop_reason === 'tool_use') {
      const toolResults: any[] = [];
      for (const block of content) {
        if (block.type !== 'tool_use') continue;
        toolCalls.push({ name: block.name, input: block.input });
        let result: any;
        try { result = await executeTool(c, dossierId, fyId, block.name, block.input, mode); }
        catch (e: any) { result = { error: String(e?.message ?? e).slice(0, 200) }; }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Réponse finale : concatène les blocs texte.
    const reply = content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return { reply: reply || 'Je n\'ai pas de réponse.', toolCalls, model: AGENT_MODEL, mode };
  }
  return { reply: 'La demande a nécessité trop d\'étapes. Reformulez de façon plus ciblée.', toolCalls, model: AGENT_MODEL, mode };
}
