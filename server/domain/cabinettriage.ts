import type { Client } from '../db.js';
import { runForDossier } from './nightly.js';

// ============================================================================
// Copilote du cabinet : vue TRANSVERSE du portefeuille. Répond à « par quoi je
// commence ce matin ? » plutôt que d'obliger à ouvrir les dossiers un par un.
//
// S'appuie sur les digests déjà calculés par la veille nocturne (lecture rapide,
// même sur un gros portefeuille) plutôt que de tout recalculer à l'affichage.
// La RLS fait le tri : on ne voit que les dossiers de son périmètre.
// ============================================================================

export interface TriageDossier {
  dossierId: string; raisonSociale: string;
  analyseLe: string | null;
  haute: number; moyenne: number;
  points: { niveau: string; titre: string; categorie: string }[];
}

const CATEGORIE_LABEL: Record<string, string> = {
  tva: 'TVA à déclarer', tresorerie: 'Trésorerie', creances: 'Créances en souffrance',
  coherence: 'Incohérences comptables', immobilisations: 'Dotations à passer', rh: 'Échéances RH',
  previsionnel: 'Trésorerie projetée', saisie: 'Brouillons à valider', resultat: 'Résultat',
};

export async function triage(c: Client): Promise<{
  dossiers: TriageDossier[];
  jamaisAnalyses: { dossierId: string; raisonSociale: string }[];
  resume: { dossiers: number; critiques: number; aTraiter: number };
  parCategorie: { categorie: string; libelle: string; dossiers: number; points: number }[];
}> {
  // Dernier digest par dossier (RLS : périmètre de l'utilisateur uniquement).
  const { rows } = await c.query(
    `select distinct on (ai.dossier_id)
            ai.dossier_id, d.raison_sociale,
            to_char(ai.generated_at,'YYYY-MM-DD"T"HH24:MI:SS') as generated_at,
            ai.resume, ai.items
       from agent_insights ai
       join dossiers d on d.id = ai.dossier_id
      where d.is_active
      order by ai.dossier_id, ai.generated_at desc`);

  const dossiers: TriageDossier[] = rows.map((r: any) => {
    const items: any[] = Array.isArray(r.items) ? r.items : [];
    return {
      dossierId: r.dossier_id,
      raisonSociale: r.raison_sociale,
      analyseLe: r.generated_at,
      haute: Number(r.resume?.haute ?? 0),
      moyenne: Number(r.resume?.moyenne ?? 0),
      // Les 3 points les plus urgents suffisent à décider s'il faut ouvrir.
      points: items.filter((i) => i.niveau !== 'info').slice(0, 3)
        .map((i) => ({ niveau: i.niveau, titre: i.titre, categorie: i.categorie })),
    };
  });
  // Les plus critiques d'abord : c'est l'ordre de traitement de la journée.
  dossiers.sort((a, b) => b.haute - a.haute || b.moyenne - a.moyenne || a.raisonSociale.localeCompare(b.raisonSociale));

  // Dossiers accessibles jamais analysés (angle mort à signaler).
  const analyses = new Set(dossiers.map((d) => d.dossierId));
  const { rows: all } = await c.query('select id, raison_sociale from dossiers where is_active order by raison_sociale');
  const jamaisAnalyses = all.filter((d: any) => !analyses.has(d.id))
    .map((d: any) => ({ dossierId: d.id, raisonSociale: d.raison_sociale }));

  // Agrégation par nature : « 12 TVA à déposer » plutôt que 12 lignes.
  const byCat = new Map<string, { dossiers: Set<string>; points: number }>();
  for (const r of rows as any[]) {
    for (const i of (Array.isArray(r.items) ? r.items : [])) {
      if (i.niveau === 'info') continue;
      const k = String(i.categorie ?? 'autre');
      if (!byCat.has(k)) byCat.set(k, { dossiers: new Set(), points: 0 });
      const e = byCat.get(k)!;
      e.dossiers.add(r.dossier_id); e.points += 1;
    }
  }
  const parCategorie = [...byCat.entries()]
    .map(([categorie, v]) => ({ categorie, libelle: CATEGORIE_LABEL[categorie] ?? categorie, dossiers: v.dossiers.size, points: v.points }))
    .sort((a, b) => b.dossiers - a.dossiers || b.points - a.points);

  return {
    dossiers,
    jamaisAnalyses,
    resume: {
      dossiers: dossiers.length,
      critiques: dossiers.filter((d) => d.haute > 0).length,
      aTraiter: dossiers.reduce((s, d) => s + d.haute + d.moyenne, 0),
    },
    parCategorie,
  };
}

// Analyse à la demande de tout le portefeuille accessible. Borné : sur un gros
// portefeuille, on préfère la veille nocturne.
export async function runAll(c: Client, limit = 60): Promise<{ analyses: number; ignores: number }> {
  const { rows } = await c.query('select id from dossiers where is_active order by raison_sociale limit $1', [limit]);
  let analyses = 0, ignores = 0;
  for (const d of rows as any[]) {
    // Un dossier en erreur ne doit pas interrompre le balayage du portefeuille.
    await c.query('savepoint sp_triage');
    try { await runForDossier(c, d.id); await c.query('release savepoint sp_triage'); analyses++; }
    catch { await c.query('rollback to savepoint sp_triage'); ignores++; }
  }
  return { analyses, ignores };
}
