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
import * as alerts from '../domain/alerts.js';
import * as ratios from '../domain/ratios.js';
import * as controls from '../domain/controls.js';
import * as budget from '../domain/budget.js';
import * as budgetcopilot from '../domain/budgetcopilot.js';
import * as clotureworks from '../domain/clotureworks.js';
import * as assets from '../domain/assets.js';
import * as tiers from '../domain/tiers.js';
import * as bank from '../domain/bank.js';
import * as payroll from '../domain/payroll.js';
import * as reporting from '../domain/reporting.js';
import * as recurring from '../domain/recurring.js';
import * as recinv from '../domain/recurringinvoices.js';
import * as accdocs from '../documents/accounting-docs.js';
import * as csv from '../documents/csv.js';
import * as audit from '../domain/audit.js';
import * as usage from '../domain/usage.js';
import * as mail from '../email/provider.js';
import { upcomingDeadlines } from '../domain/fiscalcalendar.js';

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
const DEEP_HINTS = /pourquoi|analys|diagnos|cl[oô]tur|incoh[ée]ren|[ée]cart|compar|pr[ée]vision|optimis|conseil|recommand|rentab|marge|fiscal|redress|justifi|baisse|hausse|[ée]volu|tendance|anomal|strat[ée]g|pr[ée]par|envoi|envoy|email|e-mail|bulletin|d[ée]clar|livre de paie/i;

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

// Réglage de la voix (fournisseur + voix), par dossier. Lecture tolérante au schéma.
export async function getVoice(c: Client, dossierId: string): Promise<{ provider: string; voiceId: string | null }> {
  const { rows } = await c.query('select to_jsonb(dd) as j from dossiers dd where id=$1', [dossierId]);
  const j: any = rows[0]?.j ?? {};
  return { provider: j.voice_provider ?? 'elevenlabs', voiceId: j.voice_id ?? null };
}
export async function setVoice(c: Client, dossierId: string, provider: string | null, voiceId: string | null): Promise<void> {
  await c.query('select dossier_set_voice($1,$2,$3)', [dossierId, provider, voiceId]);
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

  // Veille : échéances fiscales/sociales imminentes (≤ 15 jours).
  let echeanceLine = '';
  try {
    const dls = upcomingDeadlines({ regimeFiscal: d.regime_fiscal, accountingSystem: d.accounting_system, fiscalYearEnd: openFy?.end_date ?? null, horizonDays: 15 });
    if (dls.length) echeanceLine = `ÉCHÉANCES PROCHES (≤ 15 j) : ${dls.slice(0, 3).map((x) => `${x.label} — ${x.dueDate}`).join(' ; ')}. Signale-les à propos si utile.`;
  } catch { /* ignore */ }

  const text = `ENTREPRISE : ${d.raison_sociale ?? '—'} — pays ${d.country ?? 'CI'}, devise ${d.base_currency ?? 'XOF'}, référentiel SYSCOHADA révisé (AUDCIF). Tu es LEUR comptable IA (Lexa), pas un outil générique.
${idLine}
${obligLine}
${echeanceLine}
${fyLine}
${teamLine}
${meLine}
Date du jour : ${today}.${memText}`;
  return { text, fyId: openFy?.id ?? null, currency: d.base_currency ?? 'XOF', mode: MODES.includes(d.agent_mode) ? d.agent_mode : 'readonly' };
}

const SYSTEM_GUARDRAILS = `Tu es **Lexa**, la comptable IA de Nova — une véritable collaboratrice de l'entreprise du dossier, experte du référentiel OHADA (SYSCOHADA révisé, AUDCIF). Tu n'es pas un chatbot générique : tu connais l'entreprise, son équipe et la personne avec qui tu échanges (voir le contexte). REGISTRE (identique sur TOUS les canaux — application, email, Telegram, WhatsApp) : appelle toujours la personne par son PRÉNOM (voir contexte), TUTOIE-la (« tu », jamais « vous »), ton de collègue de confiance : chaleureuse, directe, concise. Ne bascule jamais vers un registre distant/formel selon le canal.

RÈGLES ABSOLUES :
1. Tu es en LECTURE SEULE. Tu ne crées, ne modifies et ne postes JAMAIS d'écriture. Si on te le demande, explique que la saisie se fait dans les onglets dédiés (l'utilisateur valide toujours).
2. Tu n'inventes AUCUN chiffre. Chaque montant, solde ou statut que tu cites DOIT provenir d'un appel d'outil dans cette conversation. Si tu n'as pas la donnée, appelle l'outil approprié ; si aucun outil ne convient, dis-le franchement.
3. Cite tes sources : mentionne le compte (code + intitulé), le tiers, l'écriture ou la période d'où vient chaque chiffre.
4. Réponds en français, de façon concise et actionnable. Formate les montants avec la devise du dossier, **en entier** (ex. « 650 000 XOF ») ou en toutes lettres (« 650 mille », « 2,3 millions ») — jamais d'abréviation « k » ou « M », qui se lit mal à voix haute. Pour une synthèse, va droit au but (résultat d'abord, détail ensuite).
5. Raisonne comme un expert-comptable OHADA : classes 1-9, partie double, TVA, lettrage, analytique, immobilisations, balance âgée.
6. ALTITUDE : pour un diagnostic (ex. « pourquoi le résultat baisse ? »), structure ta réponse en CONSTAT (le chiffre) → CAUSE (d'où il vient, comptes/périodes) → RECOMMANDATION (action concrète), puis propose d'approfondir. Distingue toujours clairement un constat, une recommandation et une action à valider.
7. ADAPTE-TOI À L'INTERLOCUTEUR (voir son profil dans le contexte) : à un dirigeant/non-comptable, va à l'essentiel en langage clair et cache le jargon (donne le compte entre parenthèses si utile) ; à un comptable/DAF/expert-comptable, sois technique et précis (codes de comptes, mécanismes). En cas de doute, reste simple et propose d'entrer dans le détail.
8. IDENTITÉ FISCALE : tu connais la forme juridique, le régime fiscal, le NCC/IFU, le RCCM et la banque du dossier (voir contexte). Raisonne selon le régime (ex. n'évoque la TVA à collecter que si l'entreprise y est assujettie ; sous l'impôt synthétique, il n'y a pas de TVA), rappelle les obligations et échéances pertinentes, et cite ces références (NCC, RCCM…) quand c'est utile (déclarations, courriers officiels).
9. REPORTING MENSUEL : pour un « point du mois » / « reporting », appuie-toi sur « analyse_mensuelle » (résultat vs M-1, cumul, ratios, principales charges) — c'est plus riche qu'une simple lecture. Commente en pilotage : ce qui bouge et pourquoi (postes de charges/produits qui varient), les ratios, la trésorerie, puis des recommandations concrètes. Si on te le demande, tu peux joindre le « rapport_mensuel » en PDF par email.

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

ACTIONS À EFFET RÉEL (palier assisté+) — tu peux exécuter des tâches de bout en bout :
- "preparer_livre_paie" : calcule la paie d'une période (bulletins BROUILLONS de tous les salariés, absences/heures sup/avances incluses). Cela n'entre PAS au grand livre : la comptabilisation de l'OD reste une validation humaine dans l'onglet Paie. Après exécution, récapitule (nombre de bulletins, masse salariale brute, net, coût employeur).
- "envoyer_email" : envoie un email, avec une ou plusieurs PIÈCES JOINTES PDF via pieces_jointes = [ { document, annee, mois, … }, … ] (livre de paie, bulletin +salarie, déclaration CNPS/DGI/TVA, rapport mensuel, ou restitutions de l'exercice — balance, grand livre +compte, états financiers). RÈGLE ABSOLUE : si le corps dit « ci-joint » / « fichiers joints », les documents DOIVENT être dans pieces_jointes — ne prétends JAMAIS joindre un fichier sans le joindre réellement. C'EST IRRÉVERSIBLE. N'envoie QUE si on te l'a clairement demandé. AVANT d'envoyer : confirme le destinataire et récapitule le contenu ; ne devine jamais une adresse. Après envoi, confirme à qui, quoi, et les pièces jointes.

- "envoyer_relance_client" : relance un client en retard PAR EMAIL (lettre + relevé de compte PDF), et journalise la relance (niveau auto-incrémenté). IRRÉVERSIBLE. Il te faut le nom du client et l'adresse email du destinataire — demande-la si tu ne l'as pas (le tiers n'a pas forcément d'email en fiche). Confirme avant d'envoyer.
- "relance_groupee" : relance d'un coup tous les clients en retard au-delà d'un seuil (défaut 90 j) qui ont un email en fiche. IRRÉVERSIBLE et potentiellement massif : confirme le périmètre (nombre de clients, seuil) AVANT de lancer, puis récapitule les envois et les clients ignorés faute d'email.

- "generer_recurrences" : génère les échéances dues des modèles d'écritures récurrentes (loyers, abonnements…). Les écritures proviennent de modèles PRÉ-VALIDÉS par l'humain, tu ne fais qu'appliquer un échéancier déjà décidé. Montre d'abord ce qui va être généré (recurrences_dues) et confirme avant. Tu ne crées jamais toi-même un nouveau modèle récurrent.
- "comptabiliser_tva" : passe l'écriture de liquidation de TVA du mois (opération MÉCANIQUE et déterministe : solde 443/445, constate 4441/4449). Montre d'abord la situation TVA du mois (outil tva) et CONFIRME avant de comptabiliser.
- "comptabiliser_dotations_dues" : poste les dotations aux amortissements DUES (681 → 28x), montants DÉTERMINISTES issus du plan d'amortissement. Montre d'abord le détail (travaux_de_cloture) et CONFIRME avant.
Ces seules écritures au grand livre (récurrences validées, liquidation TVA mécanique, dotations d'amortissement déterministes) sont autorisées après confirmation ; pour tout le reste, tu ne postes/émets/règles/clôtures JAMAIS toi-même — tu prépares des brouillons que l'humain valide.

TRAVAUX DE FIN D'EXERCICE / CLÔTURE — méthode « plan → approbation → exécution » :
1. VÉRIFIE d'abord le grand livre avec "travaux_de_cloture" (brouillons, dotations dues, comptes d'attente 47x, caisse, TVA, créances anciennes, résultat provisoire).
2. PRÉSENTE un PLAN numéroté, étape par étape : pour chaque point → CONSTAT (le chiffre) · ACTION recommandée · qui l'exécute (toi via un outil, ou l'utilisateur dans un onglet). Distingue clairement ce que tu peux faire de ce qui reste manuel (émission de factures, cut-off, provisions, clôture de l'exercice = 100 % humain).
3. DEMANDE l'approbation avant d'exécuter quoi que ce soit.
4. EXÉCUTE seulement les étapes automatisables et approuvées (ex. comptabiliser_dotations_dues, comptabiliser_tva, lettrer_automatiquement), une par une, en récapitulant après chaque. Renvoie ensuite l'état mis à jour et ce qu'il reste à faire manuellement.

Tu peux ENCHAÎNER ces outils pour accomplir une consigne dictée (ex. « prépare le livre de paie de juillet et envoie-le-moi » → preparer_livre_paie, puis — après confirmation du destinataire — envoyer_email avec piece_jointe { document: "livre_paie", annee, mois } et une courte synthèse dans le corps). Tu ne postes/émets/règles/clôtures d'écritures au grand livre JAMAIS toi-même.`;

// --- Outils de LECTURE (toujours disponibles) --------------------------------

const READ_TOOLS = [
  { name: 'situation_generale', description: 'Tableau de bord du dossier : trésorerie, résultat, créances/dettes, activité récente. À utiliser pour une vue d\'ensemble.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'alertes', description: 'Points d\'attention priorisés du dossier (trésorerie négative, créances anciennes, TVA à payer, écritures en brouillon, échéances fiscales/sociales imminentes). À utiliser quand on te demande « qu\'est-ce qui nécessite mon attention ? », « quoi de neuf ? », pour un point du mois, ou de façon proactive.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'balance_generale', description: 'Balance générale (par compte : à-nouveaux, mouvements, soldes). Pour analyser les soldes de comptes.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'grand_livre', description: 'Détail des écritures d\'un compte donné (grand livre). Fournir le code du compte.', input_schema: { type: 'object', properties: { compte: { type: 'string', description: 'Code du compte SYSCOHADA, ex. 411, 521, 601' } }, required: ['compte'] } },
  { name: 'etats_financiers', description: 'États financiers de synthèse : bilan et compte de résultat.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'ratios_financiers', description: 'Analyse financière : ratios de liquidité, autonomie/endettement, rentabilité et marges, + grandes masses (BFR, fonds de roulement, trésorerie nette). Pour un diagnostic financier ou du conseil sur la structure et la performance.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'controles_coherence', description: 'Contrôles de cohérence comptable (révision automatisée) : détecte les soldes anormaux au sens SYSCOHADA (fournisseur 401 débiteur, client 411 créditeur, caisse négative, comptes d\'attente 47 non soldés, TVA inversée…). Pour un contrôle qualité / une révision avant clôture.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'resultat_analytique', description: 'Résultat par section analytique (centres de coût / points de vente) : produits, charges, résultat.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'detail_analytique', description: 'Détail des charges/produits d\'une section analytique donnée (par son code).', input_schema: { type: 'object', properties: { section: { type: 'string', description: 'Code de la section analytique, ex. COCODY' } }, required: ['section'] } },
  { name: 'creances_clients', description: 'Balance âgée clients : qui doit de l\'argent, montants et ancienneté (0-30, 31-60, 61-90, +90 jours).', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'dettes_fournisseurs', description: 'Balance âgée fournisseurs : ce que l\'entreprise doit, par tiers et ancienneté.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'previsionnel_tresorerie', description: 'Prévision de trésorerie sur les prochaines semaines (encaissements/décaissements attendus).', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'echeancier', description: "Échéancier : factures de VENTE à encaisser (créances) et factures d'ACHAT à payer (dettes) NON RÉGLÉES, avec leur date d'échéance réelle et le nombre de jours restants (ou le retard). Résumé : total à encaisser/à payer, montants échus, à encaisser/à payer sous 30 jours, solde net à 30 j. Pour répondre « qu'est-ce que je dois encaisser/payer et quand ? », prioriser le recouvrement et anticiper les paiements.", input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'balance_agee', description: "Balance âgée : antériorité des créances clients et des dettes fournisseurs, agrégée PAR TIERS et par tranche de retard (à échoir, 1-30 j, 31-60 j, 61-90 j, > 90 j). Pour identifier les tiers à relancer en priorité (créances anciennes), mesurer la qualité du poste client et suivre le risque d'impayé. Le total et les sous-totaux par tranche sont fournis.", input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'tva', description: 'Situation de TVA (collectée, déductible, à payer/crédit) sur une période. Fournir les dates de début et fin (YYYY-MM-DD).', input_schema: { type: 'object', properties: { debut: { type: 'string', description: 'YYYY-MM-DD' }, fin: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['debut', 'fin'] } },
  { name: 'factures_ventes', description: 'Liste des factures de vente (optionnellement filtrées par statut : draft, issued, paid).', input_schema: { type: 'object', properties: { statut: { type: 'string' } }, required: [] } },
  { name: 'factures_achats', description: 'Liste des factures fournisseurs (optionnellement filtrées par statut : draft, recorded, paid).', input_schema: { type: 'object', properties: { statut: { type: 'string' } }, required: [] } },
  { name: 'memoriser', description: 'Enregistre dans ta mémoire un fait DURABLE et utile sur cette entreprise (préférence, spécificité, correction, interlocuteur clé) pour t\'en souvenir plus tard. À utiliser quand tu apprends quelque chose d\'important à retenir.', input_schema: { type: 'object', properties: { fait: { type: 'string', description: 'Le fait à retenir, formulé de façon concise et durable' } }, required: ['fait'] } },
  { name: 'personnel', description: 'Liste des salariés du dossier (matricule, nom, poste, catégorie, salaire de base).', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'livre_paie', description: 'Registre de paie d\'une période : par salarié (brut, net, coût employeur) et statut de comptabilisation. Fournir année et mois (mois 0-11, ou 1-12 : sois explicite).', input_schema: { type: 'object', properties: { annee: { type: 'number' }, mois: { type: 'number', description: 'Mois en clair 1-12' } }, required: ['annee', 'mois'] } },
  { name: 'etat_rh', description: 'État RH courant : absences non payées enregistrées et avances/prêts en cours (avec restant dû).', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'profil_entreprise', description: 'Identité fiscale et légale du dossier : forme juridique, régime fiscal, NCC/IFU, RCCM, banque/RIB. À citer dans les courriers/déclarations.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'echeances_fiscales', description: 'Prochaines échéances fiscales et sociales du dossier (TVA, impôts sur salaires/état 301, CNPS, DSF) dérivées du régime fiscal, avec leurs dates. Pour rappeler proactivement ce qui arrive à échéance.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'analyse_mensuelle', description: 'Analyse comparée d\'un mois pour le reporting : chiffre d\'affaires, produits, charges et résultat du mois vs mois précédent (avec variations), cumul annuel, ratios (marge nette, taux de charges), situation (trésorerie, créances, dettes) et principales charges du mois. À commenter (constat → cause → recommandation). Fournir année et mois (1-12).', input_schema: { type: 'object', properties: { annee: { type: 'number' }, mois: { type: 'number', description: 'Mois en clair 1-12' } }, required: ['annee', 'mois'] } },
  { name: 'budget', description: 'Budget vs réalisé de l\'exercice courant : par compte (classes 6 et 7) et totaux charges/produits, avec écarts et taux de réalisation (%). Pour répondre au « pourcentage du budget réalisé », prends les produits (classe 7 = ventes/CA).', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'forecast_glissant', description: "Forecast glissant de l'exercice courant : réel à date, budget attendu au prorata du temps écoulé (écart de rythme : en avance/en retard), et PROJECTION de fin d'année par extrapolation du rythme (run-rate), par compte (classes 6 et 7) et en total (produits, charges, résultat projeté). Pour commenter la tendance : « où finit-on l'année si le rythme se maintient ? », expliquer les écarts vs budget et alerter sur les dérapages. La projection est linéaire (ne tient pas compte de la saisonnalité) — dis-le si pertinent.", input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'preparer_budget', description: "Copilote budget : PROPOSE un budget pour l'exercice courant à partir du réalisé de l'exercice précédent, avec la provenance de chaque montant (base réalisée N-1 + taux appliqué). Hypothèses par défaut : croissance des produits +5 %, inflation des charges +3 % — surchargeable via croissance_produits / inflation_charges (en décimal, ex. 0.08). Renvoie aussi des QUESTIONS à poser à la direction (prix, recrutements, investissements, charges non reconductibles). Ne saisit rien : la validation reste humaine (onglet Budget › Copilote).", input_schema: { type: 'object', properties: { croissance_produits: { type: 'number', description: 'décimal, ex. 0.05 pour +5%' }, inflation_charges: { type: 'number', description: 'décimal, ex. 0.03' } }, required: [] } },
  { name: 'comparer_scenarios', description: "Compare 3 scénarios budgétaires (prudent, central, ambitieux) projetés depuis le réalisé N-1 : produits, charges, résultat et marge nette pour chacun. Pour éclairer une décision (« combien coûte l'hypothèse ambitieuse ? », « quel résultat en prudent ? »).", input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'immobilisations', description: "État des immobilisations : par bien — compte, date d'acquisition, valeur brute, durée, cumul d'amortissements et VALEUR NETTE COMPTABLE (VNC), plus les dotations en attente. Totaux (brut, cumul, VNC). Pour répondre sur le patrimoine, la VNC, les amortissements à comptabiliser. Le tableau s'envoie par email via pieces_jointes = [{ document: \"etat_immobilisations\" }].", input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'releve_compte_tiers', description: "Relevé de compte d'un client ou fournisseur : tous ses mouvements chronologiques avec solde progressif, et le SOLDE final (à recevoir pour un client / à payer pour un fournisseur). Fournir le nom (ou le code auxiliaire) du tiers. Pour répondre « combien me doit X ? », faire le point d'un compte, ou avant d'envoyer un relevé. Le PDF s'envoie par email via pieces_jointes = [{ document: \"releve_tiers\", tiers: \"<nom>\" }].", input_schema: { type: 'object', properties: { tiers: { type: 'string', description: 'Nom ou code auxiliaire du client/fournisseur' } }, required: ['tiers'] } },
  { name: 'travaux_de_cloture', description: "Contrôle du grand livre pour préparer les travaux de FIN D'EXERCICE / CLÔTURE : renvoie une checklist des points à traiter (brouillons non validés, dotations aux amortissements dues, comptes d'attente 47x non soldés, caisse créditrice, TVA à régulariser, créances anciennes non lettrées) avec pour chacun le statut, le montant et l'action recommandée, plus le résultat provisoire. Utilise-le pour dresser un PLAN de clôture étape par étape.", input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'previsionnel', description: "États prévisionnels d'un scénario : compte de résultat prévisionnel, budget de TRÉSORERIE mensuel (position de départ = trésorerie actuelle), indicateurs (marge nette, BFR, trésorerie minimale) et alerte si la trésorerie devient négative. Paramètres : scenario (prudent|central|ambitieux, défaut central) et stress (décimal, ex. 0.15 = baisse produits -15% et hausse charges +15% pour un stress test). Étalement linéaire (MVP).", input_schema: { type: 'object', properties: { scenario: { type: 'string' }, stress: { type: 'number', description: 'décimal, ex. 0.15' } }, required: [] } },
  { name: 'recurrences_dues', description: 'Modèles d\'écritures récurrentes (loyers, abonnements…) et nombre d\'échéances DUES à générer pour chacun. Pour savoir ce qui reste à passer.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'factures_recurrentes_dues', description: 'Modèles de factures de vente récurrentes (abonnements) et nombre de factures DUES à générer pour chacun.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'catalogue', description: 'Catalogue des articles et services vendus : désignation, référence, prix unitaire HT, taux de TVA et compte de produit. Pour renseigner un prix, préparer un devis/une facture ou vérifier un tarif.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'estimation_is', description: "Estimation de l'impôt sur les bénéfices (IS) et de l'impôt minimum forfaitaire (IMF) de l'exercice, barème Côte d'Ivoire : chiffre d'affaires, résultat comptable, bénéfice imposable, IS théorique (25 %), IMF (0,5 % du CA, min 3 M / plafond 35 M F), impôt DÛ (le plus élevé des deux, ou l'IMF si déficit) et acompte provisionnel (1/3). Pour PROVISIONNER l'impôt, répondre « combien vais-je payer d'impôt ? » et anticiper les acomptes. INDICATIF : sur le résultat comptable, avant réintégrations/déductions fiscales — précise-le.", input_schema: { type: 'object', properties: {}, required: [] } },
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

// --- Outils d'ACTION (palier assist_plus) -----------------------------------
// Actions à effet réel/externe : exécuter la paie (bulletins brouillons) et
// envoyer un email. Toujours gatés assist_plus. L'envoi d'email est irréversible.
const ACTION_TOOLS = [
  {
    name: 'comptabiliser_dotations_dues',
    description: "Comptabilise (poste au grand livre) toutes les dotations aux amortissements DUES à ce jour : écritures 681 → 28x, dont les montants sont DÉTERMINISTES (issus du plan d'amortissement, jamais inventés). À n'appeler qu'APRÈS accord explicite de l'utilisateur, dans le cadre des travaux de clôture. Annonce le nombre de dotations comptabilisées et le total. Réversibilité : comme toute écriture, elle se contre-passe si besoin.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'preparer_livre_paie',
    description: 'Calcule (prépare) la paie d\'une période : génère les bulletins BROUILLONS de tous les salariés (avec absences, heures sup et avances déjà branchées). N\'écrit PAS au grand livre — la comptabilisation reste une action humaine dans l\'onglet Paie. Fournir année et mois (1-12).',
    input_schema: { type: 'object', properties: { annee: { type: 'number' }, mois: { type: 'number', description: 'Mois en clair 1-12' } }, required: ['annee', 'mois'] },
  },
  {
    name: 'envoyer_email',
    description: 'Envoie un email (synthèse, relance, document), avec éventuellement une PIÈCE JOINTE PDF générée par Nova. IRRÉVERSIBLE : n\'envoie que si la personne l\'a clairement demandé, après avoir confirmé le destinataire et récapitulé le contenu. Le corps peut être du texte ou du HTML simple. Joins un ou plusieurs documents via pieces_jointes = [ { document, annee, mois, … }, … ]. Documents disponibles : avec annee+mois ("livre_paie", "bulletin" +salarie, "declaration_cnps", "declaration_dgi", "declaration_tva", "rapport_mensuel") ; restitutions comptables de l\'exercice courant ("balance", "grand_livre" +compte, "etats_financiers"). N\'annonce JAMAIS une pièce jointe dans le corps sans la mettre réellement dans pieces_jointes.',
    input_schema: {
      type: 'object',
      properties: {
        destinataire: { type: 'string', description: 'Adresse email du destinataire' },
        sujet: { type: 'string' },
        corps: { type: 'string', description: 'Corps du message (texte ou HTML simple)' },
        pieces_jointes: {
          type: 'array',
          description: 'Pièces jointes PDF générées par Nova (0, 1 ou plusieurs). UTILISE CE TABLEAU dès qu\'il y a au moins un document à joindre.',
          items: {
            type: 'object',
            properties: {
              document: { type: 'string', description: '"livre_paie" | "ordre_virement" | "courrier_virement" (lettre à la banque) | "bulletin" | "declaration_cnps" | "declaration_dgi" | "declaration_tva" | "rapport_mensuel" | "balance" | "grand_livre" (un compte précis, préciser compte) | "grand_livre_general" (tous les comptes) | "journal_centralisateur" (récap mensuel par journal) | "etats_financiers" | "livre_journal" | "releve_tiers" (relevé de compte d\'un client/fournisseur, préciser tiers) | "etat_immobilisations" | "etat_rapprochement" (rapprochement bancaire, préciser compte ex. 521) | "confirmation_solde" (lettre de confirmation de solde à un tiers, préciser tiers) | "balance_agee" (balance âgée des créances/dettes par tiers)' },
              tiers: { type: 'string', description: 'Pour "releve_tiers" : nom ou code auxiliaire du client/fournisseur' },
              annee: { type: 'number' },
              mois: { type: 'number', description: 'Mois en clair 1-12 (documents de paie/reporting)' },
              salarie: { type: 'string', description: 'Pour "bulletin" : matricule ou nom du salarié' },
              compte: { type: 'string', description: 'Pour "grand_livre" : code du compte (ex. 411, 601)' },
              format: { type: 'string', description: 'Format du fichier : "pdf" (défaut) ou "excel" (CSV ouvrable dans Excel). "excel" disponible pour "balance" et "grand_livre".' },
            },
            required: ['document'],
          },
        },
      },
      required: ['destinataire', 'sujet', 'corps'],
    },
  },
  {
    name: 'envoyer_relance_client',
    description: 'Relance un client en retard de paiement PAR EMAIL : envoie une lettre de relance (ton adapté au niveau) avec le relevé de compte (postes ouverts) en PDF, et journalise la relance (le niveau s\'incrémente automatiquement). IRRÉVERSIBLE. Nécessite le nom du client et l\'adresse email du destinataire (demande-la si tu ne l\'as pas). Le niveau est déduit (1 rappel, 2 relance, 3 mise en demeure) sauf si précisé.',
    input_schema: { type: 'object', properties: { client: { type: 'string', description: 'Nom du client à relancer' }, destinataire: { type: 'string', description: 'Adresse email du destinataire' }, niveau: { type: 'number', description: '1, 2 ou 3 (optionnel)' } }, required: ['client', 'destinataire'] },
  },
  {
    name: 'relance_groupee',
    description: 'Relance PAR EMAIL, en une fois, tous les clients en retard au-delà d\'un seuil d\'ancienneté (défaut 90 jours) DONT l\'email est renseigné en fiche : à chacun sa lettre + relevé PDF, journalisée. IRRÉVERSIBLE. Renvoie le récapitulatif (envoyées, ignorées faute d\'email, échecs). Confirme avant de lancer.',
    input_schema: { type: 'object', properties: { seuil_jours: { type: 'number', description: 'Ancienneté minimale en jours (défaut 90)' }, niveau: { type: 'number', description: 'Forcer un niveau 1-3 (optionnel, sinon auto par client)' } }, required: [] },
  },
  {
    name: 'generer_recurrences',
    description: 'Génère (comptabilise) les échéances DUES des modèles d\'écritures récurrentes définis par l\'humain (loyers, abonnements…). Les écritures viennent de modèles pré-validés — c\'est l\'application d\'un échéancier déjà décidé, pas une écriture inventée. Confirme d\'abord ce qui va être généré (vois recurrences_dues), puis récapitule le nombre d\'écritures et le total.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'comptabiliser_tva',
    description: 'Comptabilise la LIQUIDATION de TVA d\'un mois : écriture d\'OD déterministe qui solde la TVA collectée (443) et déductible (445) et constate le net (TVA due 4441, ou crédit de TVA 4449). Opération mécanique de fin de mois (aucun jugement). Montre d\'abord la situation TVA (outil tva) et CONFIRME avant. Fournir année et mois (1-12).',
    input_schema: { type: 'object', properties: { annee: { type: 'number' }, mois: { type: 'number', description: 'Mois en clair 1-12' } }, required: ['annee', 'mois'] },
  },
  {
    name: 'generer_factures_recurrentes',
    description: 'Génère les factures de vente récurrentes (abonnements) DUES à partir des modèles définis par l\'humain : crée des FACTURES BROUILLONS (à émettre ensuite dans l\'onglet Facturation). N\'a aucun effet comptable tant qu\'elles ne sont pas émises. Confirme d\'abord ce qui va être créé (factures_recurrentes_dues), puis récapitule.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];
const ACTION_TOOL_NAMES = new Set(ACTION_TOOLS.map((t) => t.name));
// Outils qui modifient/agissent : journalisés (qui a demandé quoi, quel résultat).
const MUTATING_TOOL_NAMES = new Set<string>([...DRAFT_TOOL_NAMES, ...REVERSIBLE_TOOL_NAMES, ...ACTION_TOOL_NAMES]);

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
  if (ACTION_TOOL_NAMES.has(name) && mode !== 'assist_plus') {
    return { error: 'Action non autorisée : activez le mode « assisté + actions » (réservé aux administrateurs).' };
  }

  switch (name) {
    case 'situation_generale': return await dash.dossierDashboard(c, dossierId, fy);
    case 'alertes': return await alerts.dossierAlerts(c, dossierId, fy);
    case 'balance_generale': return cap(await acc.trialBalance(c, dossierId, fy), 120);
    case 'grand_livre': return cap(await acc.generalLedger(c, dossierId, { fiscalYearId: fy, accountCode: String(input?.compte ?? '') }), 100);
    case 'etats_financiers': return await acc.financialStatements(c, dossierId, fy);
    case 'ratios_financiers': return await ratios.financialRatios(c, dossierId, fy);
    case 'controles_coherence': return await controls.coherenceChecks(c, dossierId, fy);
    case 'resultat_analytique': return await analytic.analyticReport(c, dossierId, fy);
    case 'detail_analytique': return await analytic.analyticDetail(c, dossierId, String(input?.section ?? ''), fy);
    case 'creances_clients': return await relances.overdueClients(c, dossierId);
    case 'dettes_fournisseurs': return await purchases.supplierAging(c, dossierId);
    case 'previsionnel_tresorerie': return await forecast.cashForecast(c, dossierId, {});
    case 'echeancier': { const e: any = await forecast.echeancier(c, dossierId); return { ...e, creances: cap(e.creances, 40), dettes: cap(e.dettes, 40) }; }
    case 'balance_agee': { const a: any = await forecast.agedBalance(c, dossierId); return { clients: { ...a.clients, rows: cap(a.clients.rows, 40) }, fournisseurs: { ...a.fournisseurs, rows: cap(a.fournisseurs.rows, 40) } }; }
    case 'tva': return await tax.vatDeclaration(c, dossierId, String(input?.debut ?? ''), String(input?.fin ?? ''));
    case 'factures_ventes': return cap(await invoicing.listInvoices(c, dossierId, input?.statut, 'invoice'), 50);
    case 'factures_achats': return cap(await purchases.listPurchases(c, dossierId, input?.statut), 50);
    case 'memoriser': { await addMemory(c, dossierId, String(input?.fait ?? ''), 'lexa'); return { statut: 'memorise', note: 'Fait enregistré dans ta mémoire pour les prochaines sessions.' }; }
    case 'personnel': return cap(await payroll.listEmployees(c, dossierId), 100);
    case 'livre_paie': { const y = Number(input?.annee) || new Date().getUTCFullYear(); const mo = clampMonth(input?.mois); return { annee: y, mois: mo + 1, bulletins: await payroll.listPayslips(c, dossierId, y, mo) }; }
    case 'etat_rh': { const abs = await payroll.listAbsences(c, dossierId); const adv = await payroll.listAdvances(c, dossierId); return { absences_non_payees: abs.filter((a: any) => !a.paye), avances_en_cours: adv.filter((a: any) => a.restant > 0) }; }
    case 'profil_entreprise': { const { rows } = await c.query('select to_jsonb(dd) as j from dossiers dd where id=$1', [dossierId]); const d: any = rows[0]?.j ?? {}; return { raison_sociale: d.raison_sociale, forme_juridique: d.forme_juridique ?? null, regime_fiscal: d.regime_fiscal ?? null, ncc_ifu: d.tax_id ?? null, rccm: d.rccm ?? null, banque: d.bank_name ?? null, rib: d.rib ?? null, pays: d.country ?? 'CI', systeme_comptable: d.accounting_system }; }
    case 'catalogue': {
      const { rows } = await c.query(
        `select kind, reference, label, unit, unit_price, vat_rate, account_code
           from catalog_items where dossier_id=$1 and active order by label`, [dossierId]);
      return { articles: rows.map((r: any) => ({ nature: r.kind, reference: r.reference, designation: r.label, unite: r.unit, prix_ht: Number(r.unit_price), tva: Number(r.vat_rate), compte_produit: r.account_code })) };
    }
    case 'echeances_fiscales': {
      const { rows } = await c.query('select to_jsonb(dd) as j from dossiers dd where id=$1', [dossierId]);
      const d: any = rows[0]?.j ?? {};
      let fyEnd: string | null = null;
      try { const fys = await acc.listFiscalYears(c, dossierId); const openFy = fys.find((f: any) => f.status && f.status !== 'closed') ?? fys[fys.length - 1]; fyEnd = openFy?.end_date ?? null; } catch { /* ignore */ }
      return { echeances: upcomingDeadlines({ regimeFiscal: d.regime_fiscal, accountingSystem: d.accounting_system, fiscalYearEnd: fyEnd }) };
    }
    case 'analyse_mensuelle': { const y = Number(input?.annee) || new Date().getUTCFullYear(); const mo = clampMonth(input?.mois); return await reporting.monthlyReport(c, dossierId, y, mo); }
    case 'budget': { if (!fy) return { note: 'Aucun exercice ouvert pour lire le budget.' }; const b: any = await budget.budgetReport(c, dossierId, fy); return { ...b, rows: cap(b.rows ?? [], 60) }; }
    case 'forecast_glissant': { if (!fy) return { note: 'Aucun exercice ouvert pour le forecast.' }; const f: any = await budget.rollingForecast(c, dossierId, fy); if (!f.hasBudget) return { ...f, rows: cap(f.rows ?? [], 60), note: "Aucun budget saisi : la projection s'appuie sur le seul run-rate du réalisé, sans référence budgétaire." }; return { ...f, rows: cap(f.rows ?? [], 60) }; }
    case 'preparer_budget': { if (!fy) return { note: 'Aucun exercice ouvert.' }; const g: any = await budgetcopilot.generateBudgetFromHistory(c, dossierId, fy, { growthProduits: input?.croissance_produits, inflationCharges: input?.inflation_charges }); if (!g.priorYear) return { note: "Aucun exercice précédent avec des mouvements : impossible de générer depuis l'historique. Il faut saisir les hypothèses manuellement.", questions: g.questions }; return { ...g, lines: cap(g.lines ?? [], 80) }; }
    case 'comparer_scenarios': { if (!fy) return { note: 'Aucun exercice ouvert.' }; return await budgetcopilot.compareScenarios(c, dossierId, fy); }
    case 'previsionnel': { if (!fy) return { note: 'Aucun exercice ouvert.' }; const p: any = await budgetcopilot.provisionalStatements(c, dossierId, fy, String(input?.scenario ?? 'central'), Number(input?.stress) || 0); return { ...p, tresorerie: { ...p.tresorerie, mensuel: cap(p.tresorerie?.mensuel ?? [], 12) } }; }
    case 'immobilisations': {
      const list: any[] = await assets.listAssets(c, dossierId);
      const actifs = list.filter((a) => a.status !== 'disposed');
      const rows = actifs.map((a) => ({ immobilisation: a.label, compte: a.assetAccountCode, acquisition: a.acquisitionDate, valeur_brute: a.amount, duree_ans: a.durationYears, cumul_amort: a.cumulPosted, vnc: a.vnc, dotations_en_attente: a.pending, montant_dotations_dues: a.pendingAmount }));
      return { immobilisations: cap(rows, 80), totaux: { valeur_brute: actifs.reduce((s, a) => s + a.amount, 0), cumul_amort: actifs.reduce((s, a) => s + a.cumulPosted, 0), vnc: actifs.reduce((s, a) => s + a.vnc, 0), dotations_dues: actifs.reduce((s, a) => s + (a.pendingAmount || 0), 0) } };
    }
    case 'travaux_de_cloture': { return await clotureworks.clotureChecklist(c, dossierId, fy); }
    case 'estimation_is': return await tax.estimationIS(c, dossierId, fy);
    case 'releve_compte_tiers': {
      const cp = await tiers.findCounterparty(c, dossierId, String(input?.tiers ?? ''));
      if (!cp) return { error: `Tiers « ${input?.tiers} » introuvable.` };
      const st: any = await tiers.tiersStatement(c, dossierId, cp.id);
      const supplier = cp.type === 'fournisseur';
      const label = st.totals.solde === 0 ? 'soldé' : supplier ? (st.totals.solde < 0 ? 'à payer' : 'avance/avoir') : (st.totals.solde > 0 ? 'à recevoir' : 'avance/avoir');
      return { tiers: { nom: cp.name, code: cp.aux_code, type: cp.type }, mouvements: cap(st.rows, 80), totaux: st.totals, situation: label };
    }
    case 'recurrences_dues': { const t = await recurring.listTemplates(c, dossierId); return { modeles: t.map((x: any) => ({ label: x.label, frequence: x.frequencyLabel, journal: x.journalCode, montant: x.amount, tiers: x.counterpartyName ?? null, actif: x.active, echeances_dues: x.due })), total_dues: t.reduce((s: number, x: any) => s + (x.active ? x.due : 0), 0) }; }
    case 'factures_recurrentes_dues': { const t = await recinv.listTemplates(c, dossierId); return { modeles: t.map((x: any) => ({ label: x.label, client: x.clientName, frequence: x.frequencyLabel, montant_ttc: x.montantTtc, actif: x.active, factures_dues: x.due })), total_dues: t.reduce((s: number, x: any) => s + (x.active ? x.due : 0), 0) }; }

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

    // --- Actions (palier assist_plus) ---
    case 'comptabiliser_dotations_dues': {
      const r = await assets.postDepreciationDue(c, dossierId);
      if (r.count === 0) return { statut: 'rien_a_faire', note: 'Aucune dotation due à comptabiliser.' };
      return { statut: 'dotations_comptabilisees', dotations: r.count, total: r.total, ignorees: r.skipped, note: `${r.count} dotation(s) comptabilisée(s) (681 → 28x) pour ${r.total}. ${r.skipped ? r.skipped + ' ignorée(s) (exercice manquant).' : ''}` };
    }
    case 'preparer_livre_paie': {
      const y = Number(input?.annee) || new Date().getUTCFullYear(); const mo = clampMonth(input?.mois);
      const r = await payroll.runPayroll(c, dossierId, y, mo);
      return { statut: 'paie_preparee', annee: y, mois: mo + 1, ...r, note: 'Bulletins BROUILLONS générés (absences, heures sup et avances incluses). La comptabilisation de l\'OD de paie reste à valider dans l\'onglet Paie.' };
    }
    case 'envoyer_email': {
      if (!mail.emailEnabled()) return { error: 'Canal email non configuré côté serveur (RESEND_API_KEY absent).' };
      const to = String(input?.destinataire ?? '').trim();
      if (!to.includes('@')) return { error: 'Adresse email du destinataire invalide.' };
      const corps = String(input?.corps ?? '');
      const isHtml = /<[a-z][\s\S]*>/i.test(corps);

      // Pièces jointes générées par Nova : accepte un objet unique, un tableau,
      // ou une chaîne JSON (robustesse : le modèle passe parfois un tableau).
      const specs: any[] = [];
      const collect = (v: any) => {
        if (!v) return;
        let x = v;
        if (typeof x === 'string') { try { x = JSON.parse(x); } catch { return; } }
        if (Array.isArray(x)) x.forEach((s) => { if (s && s.document) specs.push(s); });
        else if (x && x.document) specs.push(x);
      };
      collect(input?.piece_jointe); collect(input?.pieces_jointes);

      const attachments: { filename: string; content: string }[] = [];
      const jointes: string[] = [];
      for (const spec of specs) {
        const d = await buildDocAttachment(c, dossierId, fy, spec);
        if ('error' in d) return { error: d.error, ...(d.extra ?? {}) };
        attachments.push({ filename: d.filename, content: d.buffer.toString('base64') });
        jointes.push(d.filename);
      }

      try {
        const { id } = await mail.sendEmail({ to, subject: String(input?.sujet ?? '(sans objet)'), html: isHtml ? corps : undefined, text: isHtml ? undefined : corps, attachments: attachments.length ? attachments : undefined });
        return { statut: 'email_envoye', destinataire: to, pieces_jointes: jointes, id, note: 'Email envoyé (action irréversible).' };
      } catch (e: any) { return { error: String(e?.message ?? e).slice(0, 200) }; }
    }
    case 'envoyer_relance_client': {
      if (!mail.emailEnabled()) return { error: 'Canal email non configuré côté serveur (RESEND_API_KEY absent).' };
      const to = String(input?.destinataire ?? '').trim();
      if (!to.includes('@')) return { error: 'Adresse email du destinataire invalide.' };
      const nom = String(input?.client ?? '').trim().toLowerCase();
      const overdue = await relances.overdueClients(c, dossierId);
      const match: any = overdue.find((o: any) => String(o.name ?? '').toLowerCase().includes(nom));
      if (!match) return { error: `Aucun client en retard correspondant à « ${input?.client} ».`, clients_en_retard: overdue.map((o: any) => o.name) };
      const doc = await relances.releveClientPdf(c, dossierId, match.counterpartyId);
      if (doc.letter.open.length === 0) return { error: `${match.name} n'a aucun poste ouvert à relancer.` };
      const level = Number(input?.niveau) || doc.letter.suggestedLevel;
      const body = relances.relanceEmailBody(doc.letter, level, doc.cur);
      try {
        const { id } = await mail.sendEmail({ to, subject: body.subject, html: body.html, attachments: [{ filename: doc.filename, content: doc.buffer.toString('base64') }] });
        const rec = await relances.recordRelance(c, dossierId, match.counterpartyId, level, doc.letter.total, undefined, `Relance niveau ${level} envoyée à ${to}`);
        return { statut: 'relance_envoyee', client: match.name, destinataire: to, niveau: rec.level, total_du: doc.letter.total, piece_jointe: doc.filename, id, note: 'Relance envoyée et journalisée (action irréversible).' };
      } catch (e: any) { return { error: String(e?.message ?? e).slice(0, 200) }; }
    }
    case 'relance_groupee': {
      if (!mail.emailEnabled()) return { error: 'Canal email non configuré côté serveur (RESEND_API_KEY absent).' };
      const seuil = Number(input?.seuil_jours) || 90;
      const overdue = await relances.overdueClients(c, dossierId);
      const cibles = overdue.filter((o: any) => o.oldestAge >= seuil && o.balance > 0);
      const envoyees: any[] = []; const sansEmail: string[] = []; const echecs: any[] = [];
      for (const cli of cibles) {
        if (!cli.email || !String(cli.email).includes('@')) { sansEmail.push(cli.name); continue; }
        try {
          const doc = await relances.releveClientPdf(c, dossierId, cli.counterpartyId);
          if (doc.letter.open.length === 0) continue;
          const level = Number(input?.niveau) || (cli.lastLevel + 1);
          const body = relances.relanceEmailBody(doc.letter, level, doc.cur);
          await mail.sendEmail({ to: cli.email, subject: body.subject, html: body.html, attachments: [{ filename: doc.filename, content: doc.buffer.toString('base64') }] });
          await relances.recordRelance(c, dossierId, cli.counterpartyId, level, doc.letter.total, undefined, `Relance groupée niveau ${level} à ${cli.email}`);
          envoyees.push({ client: cli.name, email: cli.email, niveau: level, total: doc.letter.total });
        } catch (e: any) { echecs.push({ client: cli.name, erreur: String(e?.message ?? e).slice(0, 120) }); }
      }
      return { statut: 'relances_envoyees', seuil_jours: seuil, total_envoyees: envoyees.length, envoyees, ignores_sans_email: sansEmail, echecs };
    }
    case 'generer_recurrences': {
      const r = await recurring.generateAllDue(c, dossierId);
      return { statut: 'recurrences_generees', ecritures: r.count, modeles_concernes: r.templates, total: r.total, note: 'Échéances récurrentes générées à partir des modèles validés. Visibles dans les journaux / l\'onglet Récurrences.' };
    }
    case 'comptabiliser_tva': {
      const y = Number(input?.annee) || new Date().getUTCFullYear(); const mo = clampMonth(input?.mois);
      const from = `${y}-${String(mo + 1).padStart(2, '0')}-01`;
      const to = `${y}-${String(mo + 1).padStart(2, '0')}-${String(new Date(y, mo + 1, 0).getDate()).padStart(2, '0')}`;
      try {
        const r = await tax.postVatLiquidation(c, dossierId, from, to, to);
        return { statut: 'tva_comptabilisee', periode: `${mo + 1}/${y}`, ecriture_id: r.entryId, tva_collectee: r.collectee, tva_deductible: r.deductible, tva_a_payer: r.netDue, credit_reportable: r.creditReportable, note: 'Écriture de liquidation de TVA comptabilisée (journal OD).' };
      } catch (e: any) { return { error: String(e?.message ?? e).slice(0, 200) }; }
    }
    case 'generer_factures_recurrentes': {
      const r = await recinv.generateAllDue(c, dossierId);
      return { statut: 'factures_generees', factures_brouillons: r.count, modeles_concernes: r.templates, note: 'Factures BROUILLONS créées (abonnements). À émettre dans l\'onglet Facturation.' };
    }

    default: return { error: `Outil inconnu : ${name}` };
  }
}

// Convertit un mois « en clair » (1-12) en index 0-11, borné.
function clampMonth(mois: any): number { const mo = Number(mois) || 1; return Math.max(0, Math.min(11, mo - 1)); }

// Construit une pièce jointe PDF à partir d'une spec { document, annee, mois, … }.
async function buildDocAttachment(c: Client, dossierId: string, fy: string | undefined, pj: any): Promise<{ filename: string; buffer: Buffer } | { error: string; extra?: any }> {
  const y = Number(pj.annee) || new Date().getUTCFullYear(); const mo = clampMonth(pj.mois);
  const excel = /csv|excel|tableur/i.test(String(pj.format ?? ''));
  // Exports tableur (Excel) pour la balance et le grand livre.
  if (excel && pj.document === 'balance') { const r = await csv.balanceCsv(c, dossierId, fy); return { filename: r.filename, buffer: r.buffer }; }
  if (excel && pj.document === 'grand_livre') { const code = String(pj.compte ?? '').trim(); if (!code) return { error: 'Précisez le compte (piece_jointe.compte) pour le grand livre.' }; const r = await csv.grandLivreCsv(c, dossierId, code, fy); if (r.count === 0) return { error: `Aucune écriture sur le compte ${code}.` }; return { filename: r.filename, buffer: r.buffer }; }
  switch (pj.document) {
    case 'livre_paie': { const r = await payroll.livrePaiePdf(c, dossierId, y, mo); if (r.count === 0) return { error: `Aucun bulletin pour ${mo + 1}/${y} : lancez d'abord la paie (preparer_livre_paie).` }; return r; }
    case 'declaration_cnps': case 'declaration_dgi': { const r = await payroll.declarationPdf(c, dossierId, y, mo, pj.document === 'declaration_cnps' ? 'cnps' : 'dgi'); if (r.count === 0) return { error: `Aucun bulletin pour ${mo + 1}/${y} : lancez d'abord la paie avant d'éditer la déclaration.` }; return r; }
    case 'ordre_virement': { const r = await payroll.ordreVirementPdf(c, dossierId, y, mo); if (r.count === 0) return { error: `Aucun bulletin pour ${mo + 1}/${y} : lancez d'abord la paie avant l'ordre de virement.` }; return r; }
    case 'courrier_virement': { const r = await payroll.courrierVirementPdf(c, dossierId, y, mo); if (r.count === 0) return { error: `Aucun bulletin pour ${mo + 1}/${y} : lancez d'abord la paie avant le courrier de virement.` }; return r; }
    case 'bulletin': { const r = await payroll.bulletinPdf(c, dossierId, String(pj.salarie ?? ''), y, mo); if (!r.found) return { error: `Salarié « ${pj.salarie} » introuvable pour ${mo + 1}/${y}.`, extra: { salaries_disponibles: r.candidates } }; return r; }
    case 'rapport_mensuel': return await reporting.rapportMensuelPdf(c, dossierId, y, mo);
    case 'declaration_tva': return await accdocs.declarationTvaPdf(c, dossierId, y, mo);
    case 'balance': return await accdocs.balancePdf(c, dossierId, fy);
    case 'grand_livre': { const code = String(pj.compte ?? '').trim(); if (!code) return { error: 'Précisez le compte (piece_jointe.compte) pour le grand livre.' }; const r = await accdocs.grandLivrePdf(c, dossierId, code, fy); if (r.count === 0) return { error: `Aucune écriture sur le compte ${code}.` }; return r; }
    case 'etats_financiers': return await accdocs.etatsFinanciersPdf(c, dossierId, fy);
    case 'livre_journal': { const r = await accdocs.livreJournalPdf(c, dossierId, fy); if (r.count === 0) return { error: 'Aucune écriture pour le livre-journal.' }; return r; }
    case 'grand_livre_general': { const r = await accdocs.grandLivreGeneralPdf(c, dossierId, fy); if (r.count === 0) return { error: 'Aucune écriture pour le grand livre général.' }; return r; }
    case 'journal_centralisateur': { const r = await accdocs.journalCentralisateurPdf(c, dossierId, fy); if (r.count === 0) return { error: 'Aucune écriture pour le journal centralisateur.' }; return r; }
    case 'balance_agee': { const r = await accdocs.balanceAgeePdf(c, dossierId); if (r.count === 0) return { error: 'Aucun solde ouvert pour la balance âgée.' }; return r; }
    case 'releve_tiers': {
      const cp = await tiers.findCounterparty(c, dossierId, String(pj.tiers ?? ''));
      if (!cp) return { error: `Tiers « ${pj.tiers} » introuvable pour le relevé de compte.` };
      const { rows: dd } = await c.query('select base_currency from dossiers where id=$1', [dossierId]);
      return await tiers.tiersStatementPdf(c, dossierId, cp.id, dd[0]?.base_currency ?? 'XOF');
    }
    case 'etat_immobilisations': {
      const { rows: dd } = await c.query('select base_currency from dossiers where id=$1', [dossierId]);
      const r = await assets.assetsRegisterPdf(c, dossierId, dd[0]?.base_currency ?? 'XOF');
      if (r.count === 0) return { error: 'Aucune immobilisation enregistrée.' };
      return r;
    }
    case 'etat_rapprochement': {
      const compte = String(pj.compte ?? '521').trim();
      const { rows: dd } = await c.query('select base_currency from dossiers where id=$1', [dossierId]);
      return await bank.reconciliationStatementPdf(c, dossierId, compte, dd[0]?.base_currency ?? 'XOF');
    }
    case 'confirmation_solde': {
      const cp = await tiers.findCounterparty(c, dossierId, String(pj.tiers ?? ''));
      if (!cp) return { error: `Tiers « ${pj.tiers} » introuvable pour la confirmation de solde.` };
      const { rows: dd } = await c.query('select base_currency from dossiers where id=$1', [dossierId]);
      return await tiers.tiersBalanceLetterPdf(c, dossierId, cp.id, dd[0]?.base_currency ?? 'XOF');
    }
    default: return { error: `Type de pièce jointe non pris en charge : ${pj.document}.` };
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
  const tools = mode === 'assist_plus' ? [...READ_TOOLS, ...DRAFT_TOOLS, ...REVERSIBLE_TOOLS, ...ACTION_TOOLS]
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
  const instruction = String([...history].reverse().find((h) => h.role === 'user')?.content ?? '');
  const toolCalls: AgentToolCall[] = [];
  let tokIn = 0, tokOut = 0; // cumul des tokens sur toutes les étapes du tour
  for (let step = 0; step < MAX_STEPS; step++) {
    const data = await callClaude({
      model, max_tokens: 2048, system, tools, messages,
    });
    const u = data.usage ?? {};
    tokIn += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    tokOut += u.output_tokens ?? 0;
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
        // Journal d'audit : toute action de Lexa est tracée (instruction + acteur + résultat).
        if (MUTATING_TOOL_NAMES.has(block.name) && !result?.error) {
          try { await audit.recordAudit(c, { dossierId, action: `lexa.${block.name}`, entity: 'lexa_action', detail: { instruction: instruction.slice(0, 300), entrees: block.input, resultat: result?.statut ?? 'ok' } }); } catch { /* best-effort */ }
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Réponse finale : concatène les blocs texte.
    const reply = content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    await usage.recordUsage(c, dossierId, 'anthropic', model, { inputTokens: tokIn, outputTokens: tokOut });
    return { reply: reply || 'Je n\'ai pas de réponse.', toolCalls, model, mode };
  }
  await usage.recordUsage(c, dossierId, 'anthropic', model, { inputTokens: tokIn, outputTokens: tokOut });
  return { reply: 'La demande a nécessité trop d\'étapes. Reformulez de façon plus ciblée.', toolCalls, model, mode };
}
