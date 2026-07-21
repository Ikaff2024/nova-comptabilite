import type { Client } from '../db.js';

// ============================================================================
// Détection comportementale : repère les ÉCARTS aux habitudes du dossier, pour
// que Lexa prévienne (« d'habitude vous… »). Volontairement CONSERVATEUR — le
// faux positif nuit à la confiance — et déterministe. Deux signaux robustes :
//   • un fournisseur habituellement mensuel, absent ce mois-ci ;
//   • un rythme de saisie nettement en retard sur la moyenne.
// ============================================================================

export type Niveau = 'moyenne' | 'info';
export interface Signal { niveau: Niveau; categorie: string; titre: string; detail: string }

export async function behaviorSignals(c: Client, dossierId: string): Promise<{ signaux: Signal[] }> {
  const signaux: Signal[] = [];
  const now = new Date();
  const day = now.getUTCDate();
  const curYm = now.toISOString().slice(0, 7);
  const safe = async (fn: () => Promise<void>) => { try { await fn(); } catch { /* ignoré */ } };

  // --- 1) Fournisseur régulier absent ce mois-ci ----------------------------
  // On attend d'être assez avancé dans le mois pour ne pas alarmer trop tôt.
  if (day >= 12) await safe(async () => {
    const { rows } = await c.query(
      `select cp.id, cp.name, to_char(e.entry_date,'YYYY-MM') as ym
         from entry_lines l
         join entries e on e.id = l.entry_id and e.status = 'posted'
         join counterparties cp on cp.id = l.counterparty_id and cp.type = 'fournisseur'
        where l.dossier_id = $1 and e.entry_date >= (date_trunc('month', current_date) - interval '4 months')
        group by cp.id, cp.name, ym`, [dossierId]);
    const byFrs = new Map<string, { name: string; months: Set<string> }>();
    for (const r of rows) {
      if (!byFrs.has(r.id)) byFrs.set(r.id, { name: r.name, months: new Set() });
      byFrs.get(r.id)!.months.add(r.ym);
    }
    for (const { name, months } of byFrs.values()) {
      const prior = [...months].filter((m) => m !== curYm);
      // Présent dans au moins 3 des mois précédents = habitude mensuelle.
      if (prior.length >= 3 && !months.has(curYm)) {
        signaux.push({ niveau: 'moyenne', categorie: 'habitude', titre: `Fournisseur habituel sans écriture ce mois : ${name}`,
          detail: `Vous enregistrez habituellement une opération avec ${name} chaque mois ; rien n'a été saisi ce mois-ci. Une facture est-elle en attente ?` });
      }
    }
  });

  // --- 2) Rythme de saisie en retard ----------------------------------------
  if (day >= 10) await safe(async () => {
    const { rows } = await c.query(
      `select to_char(e.entry_date,'YYYY-MM') ym, count(distinct e.id)::int n
         from entries e
        where e.dossier_id = $1 and e.status = 'posted'
          and e.entry_date >= (date_trunc('month', current_date) - interval '3 months')
        group by ym`, [dossierId]);
    const byMonth = new Map<string, number>(rows.map((r: any) => [r.ym, r.n]));
    const prior = [...byMonth.entries()].filter(([m]) => m !== curYm).map(([, n]) => n);
    const cur = byMonth.get(curYm) ?? 0;
    if (prior.length >= 2) {
      const moy = prior.reduce((s, x) => s + x, 0) / prior.length;
      // Projection du mois en cours à son rythme actuel (prorata des jours).
      const projete = (cur / day) * 30;
      if (moy >= 5 && projete < moy * 0.5) {
        signaux.push({ niveau: 'info', categorie: 'habitude', titre: 'Rythme de saisie en baisse ce mois',
          detail: `${cur} écriture(s) à ce stade du mois, contre ~${Math.round(moy)} habituellement sur un mois complet. Des pièces sont peut-être en attente de saisie.` });
      }
    }
  });

  return { signaux };
}
