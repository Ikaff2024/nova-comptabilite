// ============================================================================
// Correspondance POSTES / COMPTES des états financiers SYSCOHADA (Système
// Normal) — la table qui dit, pour chaque poste du Bilan et du Compte de
// résultat, quels comptes du plan l'alimentent.
//
// SOURCE : « Le Praticien Système Comptable OHADA (SYSCOHADA) », Tableau de
// correspondance postes — Bilan Actif, p. 885. Saisi depuis l'ouvrage.
//
// Pourquoi pas depuis le Journal Officiel : le PDF du JO est un scan pur (aucune
// couche texte) et sa transcription détruit ce tableau. Un re-OCR par modèle de
// vision a été tenté puis ÉCARTÉ — confronté au Praticien il décalait des postes
// d'une ligne, fusionnait les colonnes brut/amortissements et fabriquait une
// section entière absente de la page. Cette table se saisit à la main ; elle est
// courte et elle est un socle : mieux vaut la vérifier que la deviner.
//
// Deux colonnes, et c'est essentiel : un poste de bilan actif se lit
// BRUT − AMORTISSEMENTS/DÉPRÉCIATIONS = NET. Les confondre rend le bilan faux.
// ============================================================================

export type NaturePoste = 'rubrique' | 'poste' | 'total';

export interface PosteEtat {
  ref: string;              // référence du poste : AD, AE, BZ…
  libelle: string;
  nature: NaturePoste;      // rubrique = intitulé de regroupement, total = calculé
  brut?: string[];          // expressions de comptes, cf. parseExpression
  amort?: string[];         // amortissements et dépréciations à déduire
  note?: string;
}

// Une expression désigne un compte ou une famille de comptes, avec deux
// nuances reprises telles quelles de l'ouvrage :
//   « 24 (sauf 245 et 2495) » — la famille moins des exclusions ;
//   « 2818p »                 — pour partie : seule une fraction du compte entre
//                               dans le poste, ce qui relève du jugement du
//                               comptable et ne peut pas être automatisé seul.
export interface Expression { prefixe: string; sauf: string[]; partiel: boolean; }

// Le marqueur « p » (pour partie) peut porter sur l'expression entière
// (« 2818p ») comme sur une exclusion (« 294 sauf 2945, 2949p »).
const sansPartiel = (s: string) => s.trim().replace(/\s*p\.?$/i, '');

export function parseExpression(raw: string): Expression {
  const partiel = /\s*p\.?$/i.test(raw.trim());
  const m = sansPartiel(raw).match(/^(\d+)\s*(?:\(\s*sauf\s+(.+?)\s*\))?$/i);
  if (!m) return { prefixe: sansPartiel(raw), sauf: [], partiel };
  const sauf = (m[2] ?? '').split(/\s*(?:,|et)\s*/).map(sansPartiel).filter(Boolean);
  return { prefixe: m[1], sauf, partiel };
}

// Un compte appartient-il à l'expression ? Rattachement par préfixe, exclusions
// comprises (« 24 sauf 245 » retient 241 mais pas 2451).
export function matchExpression(accountCode: string, raw: string): boolean {
  const e = parseExpression(raw);
  if (!accountCode.startsWith(e.prefixe)) return false;
  return !e.sauf.some((x) => accountCode.startsWith(x));
}

// --- BILAN ACTIF (Le Praticien p. 885) ---------------------------------------

export const BILAN_ACTIF: PosteEtat[] = [
  { ref: 'AD', libelle: 'IMMOBILISATIONS INCORPORELLES', nature: 'rubrique' },
  { ref: 'AE', libelle: 'Frais de développement et de prospection', nature: 'poste',
    brut: ['211', '2181', '2191'], amort: ['2811', '2818p', '2911', '2918p'] },
  { ref: 'AF', libelle: 'Brevets, licences, logiciels et droits similaires', nature: 'poste',
    brut: ['212', '213', '214', '2193'], amort: ['2812', '2813', '2814', '2912', '2913', '2914', '2919p'] },
  { ref: 'AG', libelle: 'Fonds commercial et droit au bail', nature: 'poste',
    brut: ['215', '216'], amort: ['2815', '2816', '2915', '2916'] },
  { ref: 'AH', libelle: 'Autres immobilisations incorporelles', nature: 'poste',
    brut: ['217', '218 (sauf 2181)', '2198'], amort: ['2817', '2818p', '2917', '2918p', '2919p'] },

  { ref: 'AI', libelle: 'IMMOBILISATIONS CORPORELLES', nature: 'rubrique' },
  { ref: 'AJ', libelle: 'Terrains', nature: 'poste',
    brut: ['22'], amort: ['282', '292'], note: 'Renvoi (1) « dont Placement en Net » — immeubles de placement, à ventiler.' },
  { ref: 'AK', libelle: 'Bâtiments', nature: 'poste',
    brut: ['231', '232', '233', '237'], amort: ['2831', '2832', '2833', '2837', '2931', '2932', '2933', '2937'],
    note: 'Renvoi (1) « dont Placement en Net » — immeubles de placement, à ventiler.' },
  { ref: 'AL', libelle: 'Aménagements, agencements et installations', nature: 'poste',
    brut: ['234', '235', '238', '2394'], amort: ['2834', '2835', '2838', '2934', '2935', '2938p', '2939p'] },
  { ref: 'AM', libelle: 'Matériel, mobilier et actifs biologiques', nature: 'poste',
    brut: ['24 (sauf 245 et 2495)'], amort: ['284 (sauf 2845)', '294 (sauf 2945, 2949p)'] },
  { ref: 'AN', libelle: 'Matériel de transport', nature: 'poste',
    brut: ['245', '2495'], amort: ['2845', '2945', '2949p'] },
  { ref: 'AP', libelle: 'Avances et acomptes versés sur immobilisations', nature: 'poste',
    brut: ['251', '252'], amort: ['2951', '2952'] },

  { ref: 'AQ', libelle: 'IMMOBILISATIONS FINANCIERES', nature: 'rubrique' },
  { ref: 'AR', libelle: 'Titres de participation', nature: 'poste', brut: ['26'], amort: ['296'] },
  { ref: 'AS', libelle: 'Autres immobilisations financières', nature: 'poste', brut: ['27'], amort: ['297'] },
  { ref: 'AZ', libelle: 'TOTAL ACTIF IMMOBILISE', nature: 'total' },

  { ref: 'BA', libelle: 'ACTIF CIRCULANT HAO', nature: 'poste', brut: ['485', '488'], amort: ['498'] },
  { ref: 'BB', libelle: 'STOCKS ET ENCOURS', nature: 'poste',
    brut: ['31', '32', '33', '34', '35', '36', '37', '38'], amort: ['39'] },

  { ref: 'BG', libelle: 'CREANCES ET EMPLOIS ASSIMILES', nature: 'rubrique' },
  { ref: 'BH', libelle: 'Fournisseurs avances versées', nature: 'poste', brut: ['409'], amort: ['490'] },
  { ref: 'BI', libelle: 'Clients', nature: 'poste', brut: ['41 (sauf 419)'], amort: ['491'] },
  { ref: 'BJ', libelle: 'Autres créances', nature: 'poste',
    brut: ['185', '42', '43', '44', '45', '46', '47 (sauf 478)'],
    amort: ['492', '493', '494', '495', '496', '497'],
    note: 'Soldes débiteurs uniquement.' },
  { ref: 'BK', libelle: 'TOTAL ACTIF CIRCULANT', nature: 'total' },

  { ref: 'BQ', libelle: 'Titres de placement', nature: 'poste', brut: ['50'], amort: ['590'] },
  { ref: 'BR', libelle: 'Valeurs à encaisser', nature: 'poste', brut: ['51'], amort: ['591'] },
  { ref: 'BS', libelle: 'Banques, chèques postaux, caisse et assimilés', nature: 'poste',
    brut: ['52', '53', '54', '55', '57', '581', '582'], amort: ['592', '593', '594'],
    note: 'Soldes débiteurs uniquement.' },
  { ref: 'BT', libelle: 'TOTAL TRESORERIE ACTIF', nature: 'total' },

  { ref: 'BU', libelle: 'Ecart de conversion-Actif', nature: 'poste', brut: ['478'] },
  { ref: 'BZ', libelle: 'TOTAL GENERAL', nature: 'total' },
];

// --- BILAN PASSIF ------------------------------------------------------------
// Références et libellés relevés sur le MODÈLE du bilan passif (Le Praticien
// p. 884). La colonne « comptes à incorporer » vient d'une AUTRE page de
// l'ouvrage, non encore saisie : tant qu'elle manque, on ne devine pas.
// Attention, les références diffèrent du JO tel que transcrit : ici DH Dettes
// circulantes HAO, DI Clients avances reçues, DJ Fournisseurs d'exploitation,
// DK Dettes fiscales et sociales, DM Autres dettes.

export const BILAN_PASSIF_MODELE: PosteEtat[] = [
  { ref: 'CA', libelle: 'Capital', nature: 'poste' },
  { ref: 'CB', libelle: 'Apporteurs capital non appelé (-)', nature: 'poste' },
  { ref: 'CD', libelle: 'Primes liées au capital social', nature: 'poste' },
  { ref: 'CE', libelle: 'Ecarts de réévaluation', nature: 'poste' },
  { ref: 'CF', libelle: 'Réserves indisponibles', nature: 'poste' },
  { ref: 'CG', libelle: 'Réserves libres', nature: 'poste' },
  { ref: 'CH', libelle: 'Report à nouveau (+ ou -)', nature: 'poste' },
  { ref: 'CJ', libelle: "Résultat net de l'exercice (bénéfice + ou perte -)", nature: 'poste' },
  { ref: 'CL', libelle: "Subventions d'investissement", nature: 'poste' },
  { ref: 'CM', libelle: 'Provisions réglementées', nature: 'poste' },
  { ref: 'CP', libelle: 'TOTAL CAPITAUX PROPRES ET RESSOURCES ASSIMILEES', nature: 'total' },
  { ref: 'DA', libelle: 'Emprunts et dettes financières diverses', nature: 'poste' },
  { ref: 'DB', libelle: 'Dettes de location acquisition', nature: 'poste' },
  { ref: 'DC', libelle: 'Provisions pour risques et charges', nature: 'poste' },
  { ref: 'DD', libelle: 'TOTAL DETTES FINANCIERES ET RESSOURCES ASSIMILEES', nature: 'total' },
  { ref: 'DF', libelle: 'TOTAL RESSOURCES STABLES', nature: 'total' },
  { ref: 'DH', libelle: 'Dettes circulantes HAO', nature: 'poste' },
  { ref: 'DI', libelle: 'Clients, avances reçues', nature: 'poste' },
  { ref: 'DJ', libelle: "Fournisseurs d'exploitation", nature: 'poste' },
  { ref: 'DK', libelle: 'Dettes fiscales et sociales', nature: 'poste' },
  { ref: 'DM', libelle: 'Autres dettes', nature: 'poste' },
  { ref: 'DN', libelle: 'Provisions pour risques à court terme', nature: 'poste' },
  { ref: 'DP', libelle: 'TOTAL PASSIF CIRCULANT', nature: 'total' },
  { ref: 'DQ', libelle: "Banques, crédits d'escompte", nature: 'poste' },
  { ref: 'DR', libelle: 'Banques, établissements financiers et crédits de trésorerie', nature: 'poste' },
  { ref: 'DT', libelle: 'TOTAL TRESORERIE-PASSIF', nature: 'total' },
  { ref: 'DV', libelle: 'Ecart de conversion-Passif', nature: 'poste' },
  { ref: 'DZ', libelle: 'TOTAL GENERAL', nature: 'total' },
];

// Tous les codes cités par la table, pour contrôle contre le plan du dossier.
export function comptesCites(postes: PosteEtat[]): string[] {
  const out = new Set<string>();
  for (const p of postes) {
    for (const raw of [...(p.brut ?? []), ...(p.amort ?? [])]) out.add(parseExpression(raw).prefixe);
  }
  return [...out].sort();
}
