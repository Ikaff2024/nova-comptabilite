import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculerEtats, type SoldeCompte } from './etats-officiels.js';

// ============================================================================
// Épreuve COMPTE PAR COMPTE des états officiels, sans base de données.
//
// Idée reprise du moteur AuthNTIC : on injecte un solde sur UN SEUL compte du
// plan, puis on vérifie que le bilan s'équilibre encore. C'est le seul contrôle
// qui voit un compte capté d'un côté et pas de l'autre — un amortissement
// déduit deux fois, un brut sans sa contrepartie. Aucun contrôle sur les TOTAUX
// ne peut le détecter : les totaux restent justes pendant que les lignes sont
// fausses.
//
//   npm run test:etats
// ============================================================================

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const plan: { code: string; label: string }[] = [];
for (const l of fs.readFileSync(path.join(ROOT, 'plan_comptable_OHADA_valide.txt'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^(\d{3,})\s+(.+)/);
  if (m) plan.push({ code: m[1], label: m[2].trim() });
}
const feuille = (c: string) => !plan.some((x) => x.code !== c && x.code.startsWith(c));

let ko = 0;
const fail = (m: string) => { console.error(`  FAIL ${m}`); ko++; };

// --- 1. Injection unitaire : le bilan doit rester équilibré ------------------
// Une écriture réelle touche deux comptes. On simule la plus simple qui soit :
// le compte testé au débit, la banque au crédit — et réciproquement.
const MONTANT = 1_000_000;
const banque = { code: '521', label: 'Banque' };

let testes = 0;
const desequilibres: { compte: string; label: string; ecart: number }[] = [];
for (const cp of plan) {
  if (!feuille(cp.code) || cp.code === banque.code) continue;
  if (!'12345'.includes(cp.code[0])) continue; // comptes de bilan
  testes++;
  const balance: SoldeCompte[] = [
    { code: cp.code, label: cp.label, solde: MONTANT },
    { code: banque.code, label: banque.label, solde: -MONTANT },
  ];
  const e = calculerEtats(balance);
  if (!e.controles.equilibreBilan.ok && !e.comptesNonAffectes.length) {
    desequilibres.push({ compte: cp.code, label: cp.label, ecart: e.controles.equilibreBilan.ecart });
  }
}
if (desequilibres.length) {
  fail(`${desequilibres.length} compte(s) déséquilibrent le bilan à eux seuls :`);
  for (const d of desequilibres.slice(0, 15)) console.error(`      ${d.compte.padEnd(6)} ${d.label.slice(0, 44).padEnd(46)} écart ${d.ecart}`);
} else {
  console.log(`  ${testes} comptes de bilan injectés un à un — équilibre préservé ✅`);
}

// --- 2. Aucun compte ne doit être imputé deux fois ---------------------------
// On injecte un solde sur un compte marqué « pour partie » et on vérifie qu'il
// n'est retranché qu'une fois (sinon l'actif net est sous-évalué du double).
for (const code of ['2818', '2918', '2919']) {
  const cp = plan.find((x) => x.code === code) ?? { code, label: code };
  const e = calculerEtats([
    { code: '2181', label: 'Frais de dév.', solde: MONTANT },
    { code, label: cp.label, solde: -400_000 },
    { code: '101', label: 'Capital', solde: -600_000 },
  ]);
  const amortTotal = e.bilanActif.filter((l) => l.nature === 'poste').reduce((s, l) => s + (l.amort ?? 0), 0);
  if (Math.abs(amortTotal - 400_000) > 0.5) fail(`compte ${code} : amortissement compté ${amortTotal} au lieu de 400000 (double emploi)`);
  if (!e.controles.equilibreBilan.ok) fail(`compte ${code} : bilan déséquilibré (écart ${e.controles.equilibreBilan.ecart})`);
  if (!e.aVentiler.some((v) => v.compte === code)) fail(`compte ${code} : partage « pour partie » non signalé`);
}
if (!ko) console.log('  comptes « pour partie » (2818, 2918, 2919) — imputés une fois et signalés ✅');

// --- 3. Le résultat doit se recouper sur un cas complet ----------------------
const e3 = calculerEtats([
  { code: '411', label: 'Clients', solde: 1_180_000 },
  { code: '521', label: 'Banque', solde: 500_000 },
  { code: '101', label: 'Capital', solde: -500_000 },
  { code: '401', label: 'Fournisseurs', solde: -180_000 },
  { code: '4431', label: 'TVA facturée', solde: -180_000 },
  { code: '701', label: 'Ventes', solde: -1_000_000 },
  { code: '601', label: 'Achats', solde: 180_000 },
]);
if (!e3.controles.equilibreBilan.ok) fail(`cas complet : bilan déséquilibré (écart ${e3.controles.equilibreBilan.ecart})`);
if (!e3.controles.resultat.ok) fail(`cas complet : résultat non recoupé (${e3.controles.resultat.parLesPostes} vs ${e3.controles.resultat.parLaBalance})`);
const marge = e3.compteResultat.find((l) => l.ref === 'XA')?.montant;
if (marge !== 820_000) fail(`cas complet : marge commerciale ${marge} au lieu de 820000`);
if (!ko) console.log('  cas complet — équilibre, résultat recoupé, marge commerciale exacte ✅');

console.log(ko === 0 ? '\nÉtats officiels conformes ✅' : `\n${ko} anomalie(s)`);
process.exitCode = ko === 0 ? 0 : 1;
