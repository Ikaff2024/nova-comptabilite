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

export type NaturePoste = 'rubrique' | 'poste' | 'total' | 'solde';

export interface PosteEtat {
  ref: string;              // référence du poste : AD, AE, BZ…
  libelle: string;
  nature: NaturePoste;      // rubrique = intitulé, total/solde = calculé
  brut?: string[];          // bilan actif : expressions de comptes, cf. parseExpression
  amort?: string[];         // bilan actif : amortissements et dépréciations à déduire
  comptes?: string[];       // bilan passif et compte de résultat : colonne unique
  signe?: '+' | '-' | '-/+'; // compte de résultat : sens porté par l'ouvrage
  formule?: string;         // soldes et totaux : mode de calcul, tel qu'imprimé
  crediteur?: boolean;      // ne retenir que les soldes créditeurs du compte
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
  { ref: 'AZ', libelle: 'TOTAL ACTIF IMMOBILISE', nature: 'total', formule: 'somme AD à AS' },

  { ref: 'BA', libelle: 'ACTIF CIRCULANT HAO', nature: 'poste', brut: ['485', '488'], amort: ['498'] },
  { ref: 'BB', libelle: 'STOCKS ET ENCOURS', nature: 'poste',
    brut: ['31', '32', '33', '34', '35', '36', '37', '38'], amort: ['39'] },

  { ref: 'BG', libelle: 'CREANCES ET EMPLOIS ASSIMILES', nature: 'rubrique' },
  { ref: 'BH', libelle: 'Fournisseurs avances versées', nature: 'poste', brut: ['409'], amort: ['490'] },
  { ref: 'BI', libelle: 'Clients', nature: 'poste', brut: ['41 (sauf 419)'], amort: ['491'] },
  { ref: 'BJ', libelle: 'Autres créances', nature: 'poste',
    // L'ouvrage écrit « 47 (sauf 478) » : il s'appuie sur le fait qu'un écart de
    // conversion-passif est créditeur par nature, donc écarté par le filtre de
    // sens. On exclut aussi 479 explicitement — il appartient au poste DV, et
    // s'il ressortait débiteur il serait compté des deux côtés du bilan.
    brut: ['185', '42', '43', '44', '45', '46', '47 (sauf 478 et 479)'],
    amort: ['492', '493', '494', '495', '496', '497'],
    note: 'Soldes débiteurs uniquement.' },
  { ref: 'BK', libelle: 'TOTAL ACTIF CIRCULANT', nature: 'total', formule: 'somme BA à BJ' },

  { ref: 'BQ', libelle: 'Titres de placement', nature: 'poste', brut: ['50'], amort: ['590'] },
  { ref: 'BR', libelle: 'Valeurs à encaisser', nature: 'poste', brut: ['51'], amort: ['591'] },
  { ref: 'BS', libelle: 'Banques, chèques postaux, caisse et assimilés', nature: 'poste',
    brut: ['52', '53', '54', '55', '57', '581', '582'], amort: ['592', '593', '594'],
    note: 'Soldes débiteurs uniquement.' },
  { ref: 'BT', libelle: 'TOTAL TRESORERIE ACTIF', nature: 'total', formule: 'somme BQ à BS' },

  { ref: 'BU', libelle: 'Ecart de conversion-Actif', nature: 'poste', brut: ['478'] },
  { ref: 'BZ', libelle: 'TOTAL GENERAL', nature: 'total', formule: 'AZ + BK + BT + BU' },
];

// --- BILAN PASSIF (Le Praticien p. 886) --------------------------------------
// Colonne unique : au passif, pas de brut/amortissements. Plusieurs postes ne
// retiennent que les SOLDES CRÉDITEURS d'une famille de comptes — un 44 débiteur
// est une créance, il part à l'actif (BJ) et non ici.

export const BILAN_PASSIF: PosteEtat[] = [
  { ref: 'CA', libelle: 'Capital', nature: 'poste', comptes: ['101', '102', '103', '104'] },
  { ref: 'CB', libelle: 'Apporteurs capital non appelé (-)', nature: 'poste', comptes: ['109'] },
  { ref: 'CD', libelle: 'Primes liées au capital social', nature: 'poste', comptes: ['105'] },
  { ref: 'CE', libelle: 'Ecarts de réévaluation', nature: 'poste', comptes: ['106'] },
  { ref: 'CF', libelle: 'Réserves indisponibles', nature: 'poste', comptes: ['111', '112', '113'] },
  { ref: 'CG', libelle: 'Réserves libres', nature: 'poste', comptes: ['118'] },
  { ref: 'CH', libelle: 'Report à nouveau (+ ou -)', nature: 'poste', comptes: ['12'], note: '121 report créditeur ou 129 report débiteur.' },
  { ref: 'CJ', libelle: "Résultat net de l'exercice (bénéfice + ou perte -)", nature: 'poste', comptes: ['13'], note: '131 bénéfice ou 139 perte.' },
  { ref: 'CL', libelle: "Subventions d'investissement", nature: 'poste', comptes: ['14'] },
  { ref: 'CM', libelle: 'Provisions réglementées', nature: 'poste', comptes: ['15'] },
  { ref: 'CP', libelle: 'TOTAL CAPITAUX PROPRES ET RESSOURCES ASSIMILEES', nature: 'total', formule: 'somme CA à CM' },

  { ref: 'DA', libelle: 'Emprunts et dettes financières', nature: 'poste', comptes: ['16', '181', '182', '183', '184'] },
  { ref: 'DB', libelle: 'Dettes de location acquisition', nature: 'poste', comptes: ['17'] },
  { ref: 'DC', libelle: 'Provisions pour risques et charges', nature: 'poste', comptes: ['19'] },
  { ref: 'DD', libelle: 'TOTAL DETTES FINANCIERES ET RESSOURCES ASSIMILEES', nature: 'total', formule: 'somme DA à DC' },
  { ref: 'DF', libelle: 'TOTAL RESSOURCES STABLES', nature: 'total', formule: 'CP + DD' },

  { ref: 'DH', libelle: 'Dettes circulantes HAO', nature: 'poste', comptes: ['481', '482', '484', '4998'] },
  { ref: 'DI', libelle: 'Clients, avances reçues', nature: 'poste', comptes: ['419'] },
  { ref: 'DJ', libelle: "Fournisseurs d'exploitation", nature: 'poste', comptes: ['40 (sauf 409)'] },
  { ref: 'DK', libelle: 'Dettes fiscales et sociales', nature: 'poste', comptes: ['42', '43', '44'], crediteur: true },
  { ref: 'DM', libelle: 'Autres dettes', nature: 'poste', comptes: ['185', '45', '46', '47 (sauf 479)'], crediteur: true },
  { ref: 'DN', libelle: 'Provisions pour risques à court terme', nature: 'poste', comptes: ['499 (sauf 4998)', '599'] },
  { ref: 'DP', libelle: 'TOTAL PASSIF CIRCULANT', nature: 'total', formule: 'somme DH à DN' },

  { ref: 'DQ', libelle: "Banques, crédits d'escompte et de trésorerie", nature: 'poste', comptes: ['564', '565'] },
  { ref: 'DR', libelle: 'Banques, établissements financiers et crédits de trésorerie', nature: 'poste', comptes: ['52', '53', '561', '566'], crediteur: true },
  { ref: 'DT', libelle: 'TOTAL TRESORERIE PASSIF', nature: 'total', formule: 'DQ + DR' },

  { ref: 'DV', libelle: 'Ecart de conversion-Passif', nature: 'poste', comptes: ['479'] },
  { ref: 'DZ', libelle: 'TOTAL GENERAL', nature: 'total', formule: 'DF + DP + DT + DV' },
];

// --- COMPTE DE RÉSULTAT (Le Praticien p. 888) --------------------------------
// Convention de signe : l'ouvrage porte le sens sur chaque poste (+ produit,
// − charge, −/+ variation de stock). Les soldes intermédiaires s'obtiennent donc
// par SOMME des postes déjà signés — « XA = somme TA à RB », les charges y
// entrant négativement. Ne pas re-soustraire.

export const COMPTE_DE_RESULTAT: PosteEtat[] = [
  { ref: 'TA', libelle: 'Ventes de marchandises', nature: 'poste', signe: '+', comptes: ['701'] },
  { ref: 'RA', libelle: 'Achats de marchandises', nature: 'poste', signe: '-', comptes: ['601'] },
  { ref: 'RB', libelle: 'Variation de stocks de marchandises', nature: 'poste', signe: '-/+', comptes: ['6031'] },
  { ref: 'XA', libelle: 'MARGE COMMERCIALE', nature: 'solde', formule: 'somme TA à RB' },

  { ref: 'TB', libelle: 'Ventes de produits fabriqués', nature: 'poste', signe: '+', comptes: ['702', '703', '704'] },
  { ref: 'TC', libelle: 'Travaux, services vendus', nature: 'poste', signe: '+', comptes: ['705', '706'] },
  { ref: 'TD', libelle: 'Produits accessoires', nature: 'poste', signe: '+', comptes: ['707'] },
  { ref: 'XB', libelle: "CHIFFRE D'AFFAIRES", nature: 'solde', formule: 'TA + TB + TC + TD' },

  { ref: 'TE', libelle: 'Production stockée (ou déstockage)', nature: 'poste', signe: '+', comptes: ['73'] },
  { ref: 'TF', libelle: 'Production immobilisée', nature: 'poste', signe: '+', comptes: ['72'] },
  { ref: 'TG', libelle: "Subventions d'exploitation", nature: 'poste', signe: '+', comptes: ['71'] },
  { ref: 'TH', libelle: 'Autres produits', nature: 'poste', signe: '+', comptes: ['75'] },
  { ref: 'TI', libelle: "Transferts de charges d'exploitation", nature: 'poste', signe: '+', comptes: ['781'] },
  { ref: 'RC', libelle: 'Achats de matières premières et fournitures liées', nature: 'poste', signe: '-', comptes: ['602'] },
  { ref: 'RD', libelle: 'Variation de stocks de matières premières et fournitures liées', nature: 'poste', signe: '-/+', comptes: ['6032'] },
  { ref: 'RE', libelle: 'Autres achats', nature: 'poste', signe: '-', comptes: ['604', '605', '608'] },
  { ref: 'RF', libelle: "Variation de stocks d'autres approvisionnements", nature: 'poste', signe: '-/+', comptes: ['6033'] },
  { ref: 'RG', libelle: 'Transports', nature: 'poste', signe: '-', comptes: ['61'] },
  { ref: 'RH', libelle: 'Services extérieurs', nature: 'poste', signe: '-', comptes: ['62', '63'] },
  { ref: 'RI', libelle: 'Impôts et taxes', nature: 'poste', signe: '-', comptes: ['64'] },
  { ref: 'RJ', libelle: 'Autres charges', nature: 'poste', signe: '-', comptes: ['65'] },
  { ref: 'XC', libelle: 'VALEUR AJOUTEE', nature: 'solde', formule: '(XB + RA + RB) + (somme TE à RJ)' },

  { ref: 'RK', libelle: 'Charges de personnel', nature: 'poste', signe: '-', comptes: ['66'] },
  { ref: 'XD', libelle: "EXCEDENT BRUT D'EXPLOITATION", nature: 'solde', formule: 'XC + RK' },

  { ref: 'TJ', libelle: "Reprises d'amortissements, de provisions et de dépréciations", nature: 'poste', signe: '+', comptes: ['791', '798', '799'] },
  { ref: 'RL', libelle: 'Dotations aux amortissements, aux provisions et aux dépréciations', nature: 'poste', signe: '-', comptes: ['681', '691'] },
  { ref: 'XE', libelle: "RESULTAT D'EXPLOITATION", nature: 'solde', formule: 'XD + TJ + RL' },

  { ref: 'TK', libelle: 'Revenus financiers et assimilés', nature: 'poste', signe: '+', comptes: ['77'] },
  { ref: 'TL', libelle: 'Reprises de provisions et de dépréciations financières', nature: 'poste', signe: '+', comptes: ['797'] },
  { ref: 'TM', libelle: 'Transferts de charges financières', nature: 'poste', signe: '+', comptes: ['787'] },
  { ref: 'RM', libelle: 'Frais financiers et charges assimilés', nature: 'poste', signe: '-', comptes: ['67'] },
  { ref: 'RN', libelle: 'Dotations aux provisions et aux dépréciations financières', nature: 'poste', signe: '-', comptes: ['697'] },
  { ref: 'XF', libelle: 'RESULTAT FINANCIER', nature: 'solde', formule: 'somme TK à RN' },
  { ref: 'XG', libelle: 'RESULTAT DES ACTIVITES ORDINAIRES', nature: 'solde', formule: 'XE + XF' },

  { ref: 'TN', libelle: "Produits des cessions d'immobilisations", nature: 'poste', signe: '+', comptes: ['82'] },
  { ref: 'TO', libelle: 'Autres Produits HAO', nature: 'poste', signe: '+', comptes: ['84', '86', '88'] },
  { ref: 'RO', libelle: "Valeurs comptables des cessions d'immobilisations", nature: 'poste', signe: '-', comptes: ['81'] },
  { ref: 'RP', libelle: 'Autres Charges HAO', nature: 'poste', signe: '-', comptes: ['83', '85'] },
  { ref: 'XH', libelle: 'RESULTAT HORS ACTIVITES ORDINAIRES', nature: 'solde', formule: 'somme TN à RP' },

  { ref: 'RQ', libelle: 'Participation des travailleurs', nature: 'poste', signe: '-', comptes: ['87'] },
  { ref: 'RS', libelle: 'Impôts sur le résultat', nature: 'poste', signe: '-', comptes: ['89'] },
  { ref: 'XI', libelle: 'RESULTAT NET', nature: 'solde', formule: 'XG + XH + RQ + RS' },
];

// Tous les codes cités par une table, pour contrôle contre le plan du dossier.
export function comptesCites(postes: PosteEtat[]): string[] {
  const out = new Set<string>();
  for (const p of postes) {
    for (const raw of [...(p.brut ?? []), ...(p.amort ?? []), ...(p.comptes ?? [])]) {
      out.add(parseExpression(raw).prefixe);
    }
  }
  return [...out].sort();
}

// Poste auquel un compte se rattache, dans une table donnée. Renvoie la première
// correspondance : les tables de l'ouvrage sont construites pour ne pas se
// chevaucher, un chevauchement signalerait une erreur de saisie (cf. test).
export function posteDuCompte(accountCode: string, postes: PosteEtat[]): PosteEtat | undefined {
  return postes.find((p) => [...(p.brut ?? []), ...(p.comptes ?? [])]
    .some((raw) => matchExpression(accountCode, raw)));
}
