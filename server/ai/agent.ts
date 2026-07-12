import type { Client } from '../db.js';
import * as acc from '../domain/accounting.js';
import * as analytic from '../domain/analytic.js';
import * as relances from '../domain/relances.js';
import * as lettrage from '../domain/lettrage.js';
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

// Routage à deux niveaux : modèle rapide/économique pour la navigation et les
// questions simples ; modèle profond pour l'analyse (résultat, clôture,
// diagnostic, incohérences). Coupe fortement le coût sans perdre en qualité
// là où elle compte. AGENT_ROUTING=0 force le modèle profond partout.
const MODEL_DEEP = process.env.AGENT_MODEL ?? 'claude-opus-4-8';
const MODEL_FAST = process.env.AGENT_MODEL_FAST ?? 'claude-haiku-4-5';
const ROUTING = (process.env.AGENT_ROUTING ?? '1') !== '0';
const MAX_STEPS = 6;

// Intentions d'analyse → modèle profond. Sinon (lecture/navigation) → rapide.
const DEEP_HINTS = /pourquoi|analys|diagnos|cl[oô]tur|incoh[ée]ren|[ée]cart|compar|pr[ée]vision|optimis|conseil|recommand|rentab|marge|fiscal|redress|justifi|baisse|hausse|[ée]volu|tendance|anomal|strat[ée]g/i;

function pickModel(history: AgentMessage[]): string {
  if (!ROUTING) return MODEL_DEEP;
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const text = (lastUser?.content ?? '').trim();
  if (text.length > 240) return MODEL_DEEP;     // demande étoffée
  if (DEEP_HINTS.test(text)) return MODEL_DEEP; // intention d'analyse
  return MODEL_FAST;                            // navigation / lecture simple
}

export interface AgentMessage { role: 'user' | 'assistant'; content: string }
export interface AgentToolCall { name: string; input: any }
export interface AgentResult { reply: string; toolCalls: AgentToolCall[]; model: string; mode: AgentMode }

export type AgentMode = 'readonly' | 'assist' | 'assist_plus';
const MODES: AgentMode[] = ['readonly', 'assist', 'assist_plus'];

export function agentEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

// Mode de l'agent pour un dossier (défaut 'readonly').
export async function getAgentMode(c: Client, dossierId: string): Promise<AgentMode> {
  const { rows } = await c.query('select agent_mode from dossiers where id=$1', [dossierId]);
  const m = rows[0]?.agent_mode;
  return MODES.includes(m) ? m : 'readonly';
}

// Bascule du mode — réservée owner/associé (garde en base, fonction SECURITY DEFINER).
export async function setAgentMode(c: Client, dossierId: string, mode: AgentMode): Promise<void> {
  await c.query('select dossier_set_agent_mode($1,$2)', [dossierId, mode]);
}

export async function isDossierAdmin(c: Client, dossierId: string): Promise<boolean> {
  const { rows } = await c.query('select dossier_is_admin($1) as ok', [dossierId]);
  return rows[0]?.ok === true;
}

// --- Mémoire de Lexa (auto-apprentissage par dossier) ------------------------
export async function listMemories(c: Client, dossierId: string): Promise<any[]> {
  const { rows } = await c.query(
    "select id, content, source, to_char(created_at,'YYYY-MM-DD') as created_at from lexa_memory where dossier_id=$1 order by created_at desc", [dossierId]);
  return rows;
}
export async function addMemory(c: Client, dossierId: string, content: string, source = 'lexa'): Promise<{ id: string }> {
  const t = String(content ?? '').trim();
  if (!t) throw new Error('Contenu vide.');
  const { rows } = await c.query('insert into lexa_memory(dossier_id, content, source) values ($1,$2,$3) returning id', [dossierId, t.slice(0, 500), source]);
  return { id: rows[0].id };
}
export async function deleteMemory(c: Client, dossierId: string, id: string): Promise<void> {
  await c.query('delete from lexa_memory where dossier_id=$1 and id=$2', [dossierId, id]);
}

// --- Conversations (continuité par dossier + utilisateur) --------------------
export async function loadHistory(c: Client, dossierId: string, userId: string, limit = 20): Promise<AgentMessage[]> {
  const { rows } = await c.query(
    'select role, content from lexa_messages where dossier_id=$1 and user_id=$2 order by created_at desc limit $3', [dossierId, userId, limit]);
  return rows.reverse().map((r: any) => ({ role: r.role, content: r.content }));
}
export async function saveTurns(c: Client, dossierId: string, userId: string, turns: AgentMessage[]): Promise<void> {
  for (const t of turns) {
    if (!t?.content?.trim()) continue;
    await c.query('insert into lexa_messages(dossier_id, user_id, role, content) values ($1,$2,$3,$4)', [dossierId, userId, t.role, t.content]);
  }
}

// --- Contexte dossier (mis en cache dans le system prompt) -------------------

const ROLE_FR: Record<string, string> = { owner: 'propriétaire', associe: 'associé(e)', collaborateur: 'collaborateur(trice)', comptable: 'comptable', client: 'client', lecture: 'accès lecture' };

async function dossierContext(c: Client, dossierId: string): Promise<{ text: string; fyId: string | null; currency: string; mode: AgentMode }> {
  // to_jsonb : lit toutes les colonnes présentes sans coupler ce chemin critique
  // à une migration précise (les champs du profil fiscal absents = simplement
  // undefined tant que la migration 0044 n'est pas appliquée — aucune panne).
  const { rows } = await c.query('select to_jsonb(dd) as j from dossiers dd where id=$1', [dossierId]);
  const d: any = rows[0]?.j ?? {};
  const fys = await acc.listFiscalYears(c, dossierId);
  const openFy = fys.find((f: any) => f.status && f.status !== 'closed') ?? fys[fys.length - 1] ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const fyLine = openFy ? `Exercice courant : « ${openFy.label} » (${openFy.start_date} → ${openFy.end_date}), statut ${openFy.status}.` : 'Aucun exercice défini.';

  // Équipe du cabinet + personne avec qui Lexa échange (pour un comportement de collaboratrice).
  let team: any[] = []; let me: any = null;
  try { const { rows: t } = await c.query('select * from cabinet_members_list($1)', [d.cabinet_id]); team = t; } catch { /* ignore */ }
  try { const { rows: u } = await c.query('select * from get_user(app_current_user_id())'); me = u[0]; } catch { /* ignore */ }
  const teamLine = team.length
    ? `Équipe du cabinet/entreprise : ${team.map((m) => `${m.name || (m.email ? String(m.email).split('@')[0] : 'membre')} (${ROLE_FR[m.role] ?? m.role})`).join(', ')}.`
    : '';
  const meName = me?.name || (me?.email ? String(me.email).split('@')[0] : null);
  const myRole = team.find((m) => me && (m.email === me.email))?.role;
  const meLine = meName ? `Tu échanges en ce moment avec ${meName}${myRole ? ` (${ROLE_FR[myRole] ?? myRole})` : ''} — adresse-toi à cette personne par son nom.` : '';

  // Mémoire de Lexa : faits appris sur cette entreprise (injectés en contexte).
  let memText = '';
  try {
    const { rows: mem } = await c.query('select content from lexa_memory where dossier_id=$1 order by created_at desc limit 40', [dossierId]);
    if (mem.length) memText = `\n\nCE QUE TU AS APPRIS SUR CETTE ENTREPRISE (ta mémoire — tiens-en compte) :\n${mem.map((r: any) => `- ${r.content}`).join('\n')}`;
  } catch { /* ignore */ }

  // Identité fiscale/légale + obligations dérivées du régime (culture comptable).
  const REGIME_FR: Record<string, string> = { reel_normal: 'réel normal', reel_simplifie: 'réel simplifié', synthetique: 'impôt synthétique' };
  const OBLIG: Record<string, string> = {
    reel_normal: 'assujettie à la TVA (déclaration mensuelle), acomptes d\'IS, DSF (états financiers) système normal en fin d\'exercice.',
    reel_simplifie: 'assujettie à la TVA (déclaration mensuelle), IS/BIC au réel simplifié, DSF système normal en fin d\'exercice.',
    synthetique: 'relève de l\'impôt synthétique (pas de TVA à collecter) ; obligations déclaratives allégées.',
  };
  const idBits: string[] = [];
  if (d.forme_juridique) idBits.push(`forme ${d.forme_juridique}`);
  if (d.regime_fiscal) idBits.push(`régime fiscal ${REGIME_FR[d.regime_fiscal] ?? d.regime_fiscal}`);
  idBits.push(`système comptable SYSCOHADA ${d.accounting_system === 'smt' ? 'minimal de trésorerie (SMT)' : 'normal'}`);
  if (d.tax_id) idBits.push(`NCC/IFU ${d.tax_id}`);
  if (d.rccm) idBits.push(`RCCM ${d.rccm}`);
  if (d.bank_name || d.rib) idBits.push(`banque ${d.bank_name ?? '—'}${d.rib ? `, RIB ${d.rib}` : ''}`);
  const idLine = idBits.length ? `IDENTITÉ FISCALE : ${idBits.join(' ; ')}.` : '';
  const obligLine = d.regime_fiscal && OBLIG[d.regime_fiscal] ? `OBLIGATIONS : l'entreprise est ${OBLIG[d.regime_fiscal]}` : '';

  const text = `ENTREPRISE : ${d.raison_sociale ?? '—'} — pays ${d.country ?? 'CI'}, devise ${d.base_currency ?? 'XOF'}, référentiel SYSCOHADA révisé (AUDCIF). Tu es LEUR comptable IA (Lexa), pas un outil générique.
${idLine}
${obligLine}
${fyLine}
${teamLine}
${meLine}
Date du jour : ${today}.${memText}`;
  return { text, fyId: openFy?.id ?? null, currency: d.base_currency ?? 'XOF', mode: MODES.includes(d.agent_mode) ? d.agent_mode : 'readonly' };
}

const SYSTEM_GUARDRAILS = `Tu es **Lexa**, la comptable IA de Nova — une véritable collaboratrice de l'entreprise du dossier, experte du référentiel OHADA (SYSCOHADA révisé, AUDCIF). Tu n'es pas un chatbot générique : tu connais l'entreprise, son équipe et la personne avec qui tu échanges (voir le contexte). Adresse-toi aux gens par leur nom, avec le ton d'une collègue de confiance : professionnelle, chaleureuse, concise.

RÈGLES ABSOLUES :
1. Tu es en LECTURE SEULE. Tu ne crées, ne modifies et ne postes JAMAIS d'écriture. Si on te le demande, explique que la saisie se fait dans les onglets dédiés (l'utilisateur valide toujours).
2. Tu n'inventes AUCUN chiffre. Chaque montant, solde ou statut que tu cites DOIT provenir d'un appel d'outil dans cette conversation. Si tu n'as pas la donnée, appelle l'outil approprié ; si aucun outil ne convient, dis-le franchement.
3. Cite tes sources : mentionne le compte (code + intitulé), le tiers, l'écriture ou la période d'où vient chaque chiffre.
4. Réponds en français, de façon concise et actionnable. Formate les montants avec la devise du dossier. Pour une synthèse, va droit au but (résultat d'abord, détail ensuite).
5. Raisonne comme un expert-comptable OHADA : classes 1-9, partie double, TVA, lettrage, analytique, immobilisations, balance âgée.
6. ALTITUDE : pour un diagnostic (ex. « pourquoi le résultat baisse ? »), structure ta réponse en CONSTAT (le chiffre) → CAUSE (d'où il vient, comptes/périodes) → RECOMMANDATION (action concrète), puis propose d'approfondir. Distingue toujours clairement un constat, une recommandation et une action à valider.
7. ADAPTE-TOI À L'INTERLOCUTEUR (voir son profil dans le contexte) : à un dirigeant/non-comptable, va à l'essentiel en langage clair et cache le jargon (donne le compte entre parenthèses si utile) ; à un comptable/DAF/expert-comptable, sois technique et précis (codes de comptes, mécanismes). En cas de doute, reste simple et propose d'entrer dans le détail.
8. IDENTITÉ FISCALE : tu connais la forme juridique, le régime fiscal, le NCC/IFU, le RCCM et la banque du dossier (voir contexte). Raisonne selon le régime (ex. n'évoque la TVA à collecter que si l'entreprise y est assujettie ; sous l'impôt synthétique, il n'y a pas de TVA), rappelle les obligations et échéances pertinentes, et cite ces références (NCC, RCCM…) quand c'est utile (déclarations, courriers officiels).

Utilise les outils pour obtenir les données réelles avant de conclure. Enchaîne plusieurs outils si nécessaire (ex. balance puis grand livre d'un compte). Ne montre pas le JSON brut des outils : synthétise.

RÉPONDS D'ABORD À LA QUESTION POSÉE. Ne déballe jamais le point du jour quand on te demande autre chose.
- Si on te demande qui tu es / ce que tu sais faire : présente-toi brièvement (Lexa, comptable IA du dossier, en lecture seule ici), sans appeler d'outil ni citer de chiffres, puis propose de faire le point si la personne le souhaite.
- Si on te salue SANS autre demande (« bonjour », « ça va ? ») : salue par le prénom, et propose — sans l'imposer — de faire un point rapide.
- PROACTIVITÉ (comportement d'employée) : c'est seulement quand on te demande explicitement un point/une synthèse, ou après un simple bonjour, que tu appelles « situation_generale » pour signaler ce qui mérite l'attention (brouillons à valider, TVA à déclarer, créances de +90 j, dotations dues, exercice échu…). Sois brève : 1 à 3 points priorisés, puis demande par quoi commencer.

MÉMOIRE (auto-apprentissage) : tu as une mémoire propre à cette entreprise. Quand tu apprends un fait DURABLE et utile — une préférence de codification, une spécificité de l'activité, une correction qu'on te donne, le nom/rôle d'un interlocuteur clé, une habitude de l'entreprise — enregistre-le avec l'outil « memoriser » pour t'en souvenir aux prochaines sessions et t'améliorer. N'enregistre jamais d'information sensible (mots de passe, données personnelles inutiles) ni éphémère. Tiens compte de ta mémoire (fournie dans le contexte) dans tes réponses.`;

// Note ajoutée en mode assisté (brouillons).
const ASSIST_NOTE = `
MODE ASSISTÉ ACTIVÉ : tu peux PRÉPARER des BROUILLONS via les outils "preparer_*" (facture de vente, facture fournisseur). Règles impératives :
- Un brouillon n'a AUCUN effet comptable tant que l'humain ne l'émet/comptabilise pas dans l'onglet correspondant. Tu ne fais JAMAIS cette validation toi-même.
- Après avoir créé un brouillon, annonce-le clairement comme un BROUILLON À VALIDER (dans « Facturation » pour une vente, « Achats » pour un achat), et récapitule ce que tu as saisi (tiers, lignes, montants) pour que l'humain vérifie.
- Ne prépare un brouillon que si la demande est explicite et suffisamment précise. Si un élément manque (montant, tiers, compte), demande-le avant de créer.
- Tu ne postes/émets/règles/clôtures JAMAIS. Ces actions restent 100 % humaines.`;

// Note supplémentaire pour le palier 'assist_plus' (actions réversibles hors ledger).
const PLUS_NOTE = `
ACTIONS RÉVERSIBLES AUTORISÉES (palier assisté+) :
- "lettrer_automatiquement" : rapproche automatiquement, par tiers, les factures et leurs règlements qui s'annulent (lettrage). C'est RÉVERSIBLE (délettrable) et n'affecte PAS le grand livre. Annonce combien de lettrages/lignes ont été rapprochés.
- "preparer_relance_client" : produit le texte d'une lettre de relance pour un client en retard (ne l'envoie pas). L'humain décide de l'envoi.
Ces actions restent hors du grand livre immuable. Tu ne postes/émets/règles/clôtures toujours JAMAIS.`;

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
  { name: 'memoriser', description: 'Enregistre dans ta mémoire un fait DURABLE et utile sur cette entreprise (préférence, spécificité, correction, interlocuteur clé) pour t\'en souvenir plus tard. À utiliser quand tu apprends quelque chose d\'important à retenir.', input_schema: { type: 'object', properties: { fait: { type: 'string', description: 'Le fait à retenir, formulé de façon concise et durable' } }, required: ['fait'] } },
];

// --- Outils BROUILLON (paliers assist et assist_plus) ------------------------
// Aucun n'entre au grand livre : l'humain émet/comptabilise dans l'onglet dédié.

const DRAFT_TOOLS = [
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

const DRAFT_TOOL_NAMES = new Set(DRAFT_TOOLS.map((t) => t.name));

// --- Outils RÉVERSIBLES (palier assist_plus uniquement) ----------------------
// Mutations hors grand livre, annulables (lettrage) ou sans effet comptable (relance).

const REVERSIBLE_TOOLS = [
  {
    name: 'lettrer_automatiquement',
    description: 'Rapproche automatiquement (lettrage), par tiers, les factures et règlements qui s\'annulent sur les comptes de tiers. Réversible, sans effet sur le grand livre. Optionnel : limiter à un compte (ex. 411 clients, 401 fournisseurs).',
    input_schema: { type: 'object', properties: { compte: { type: 'string', description: 'Compte de tiers à lettrer (optionnel : tous si omis)' } }, required: [] },
  },
  {
    name: 'preparer_relance_client',
    description: 'Produit le texte d\'une lettre de relance pour un client en retard de paiement (postes ouverts, montant, niveau suggéré). N\'envoie rien : l\'humain décide.',
    input_schema: { type: 'object', properties: { client: { type: 'string', description: 'Nom du client à relancer' } }, required: ['client'] },
  },
];
const REVERSIBLE_TOOL_NAMES = new Set(REVERSIBLE_TOOLS.map((t) => t.name));

// Tronque une sortie volumineuse pour maîtriser les tokens.
function cap<T>(rows: T[], n = 60): T[] { return Array.isArray(rows) && rows.length > n ? rows.slice(0, n) : rows; }

async function executeTool(c: Client, dossierId: string, fyId: string | null, name: string, input: any, mode: AgentMode): Promise<any> {
  const fy = fyId ?? undefined;
  const today = new Date().toISOString().slice(0, 10);

  // Gardes-fous serveur par palier.
  if (DRAFT_TOOL_NAMES.has(name) && mode === 'readonly') {
    return { error: 'Mode lecture seule : la préparation de brouillons est désactivée pour ce dossier.' };
  }
  if (REVERSIBLE_TOOL_NAMES.has(name) && mode !== 'assist_plus') {
    return { error: 'Action réversible non autorisée : activez le mode « assisté + actions » (réservé aux administrateurs).' };
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
    case 'memoriser': { await addMemory(c, dossierId, String(input?.fait ?? ''), 'lexa'); return { statut: 'memorise', note: 'Fait enregistré dans ta mémoire pour les prochaines sessions.' }; }

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

    // --- Actions RÉVERSIBLES (palier assist_plus) ---
    case 'lettrer_automatiquement': {
      const r = await lettrage.autoLettrage(c, dossierId, input?.compte ? String(input.compte) : undefined);
      return { statut: 'lettrage_effectue', lettrages: r.groups, lignes_rapprochees: r.linesLettered, reversible: true, note: 'Rapprochement réversible (délettrable dans l\'onglet Tiers), sans effet sur le grand livre.' };
    }
    case 'preparer_relance_client': {
      const nom = String(input?.client ?? '').trim().toLowerCase();
      const overdue = await relances.overdueClients(c, dossierId);
      const match = overdue.find((o: any) => String(o.name ?? '').toLowerCase().includes(nom));
      if (!match) return { error: `Aucun client en retard correspondant à « ${input?.client} ».`, clients_en_retard: overdue.map((o: any) => o.name) };
      const letter = await relances.relanceLetter(c, dossierId, match.counterpartyId);
      return { statut: 'relance_preparee', client: match.name, montant_du: letter.total, niveau_suggere: letter.suggestedLevel, postes_ouverts: letter.open, note: 'Lettre préparée — non envoyée. L\'humain décide de l\'envoi.' };
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
  const tools = mode === 'assist_plus' ? [...READ_TOOLS, ...DRAFT_TOOLS, ...REVERSIBLE_TOOLS]
    : mode === 'assist' ? [...READ_TOOLS, ...DRAFT_TOOLS]
    : READ_TOOLS;
  const note = mode === 'assist_plus' ? ASSIST_NOTE + PLUS_NOTE : mode === 'assist' ? ASSIST_NOTE : '';

  // system : garde-fous statiques (mis en cache) + note de palier + contexte dossier.
  const system = [
    { type: 'text', text: SYSTEM_GUARDRAILS + note, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: ctx },
  ];

  // Conversation. Le contenu utilisateur/assistant est du texte simple.
  const messages: any[] = history.slice(-16).map((m) => ({ role: m.role, content: m.content }));

  const model = pickModel(history);
  const toolCalls: AgentToolCall[] = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    const data = await callClaude({
      model, max_tokens: 2048, system, tools, messages,
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
    return { reply: reply || 'Je n\'ai pas de réponse.', toolCalls, model, mode };
  }
  return { reply: 'La demande a nécessité trop d\'étapes. Reformulez de façon plus ciblée.', toolCalls, model, mode };
}
