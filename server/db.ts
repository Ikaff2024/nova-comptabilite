import pg from 'pg';

const { Pool } = pg;

// ----------------------------------------------------------------------------
// LECTURE DES MONTANTS — constat NOVA-P2-01
// ----------------------------------------------------------------------------
// Le pilote rend les NUMERIC sous forme de texte, exactement tels que la base
// les a écrits. On les convertit en nombre JavaScript, ce qui est commode pour
// tout le produit mais introduit le seul endroit où un montant peut changer de
// valeur sans que personne ne l'ait demandé : au-delà d'environ 900 milliards
// (avec quatre décimales), un nombre JavaScript ne porte plus la dernière
// décimale. Mesuré en base : 1 234 567 890 123,4567 revient en ...4568.
//
// L'ancienne version convertissait en silence. Un tel montant remontait donc
// FAUX jusqu'à l'écran, sans que rien ne le signale — dans une balance, dans un
// état financier, dans une déclaration.
//
// La conversion vérifie désormais qu'elle est RÉVERSIBLE, et refuse plutôt que
// d'approximer. Le contrôle ne coûte que sur les valeurs longues : en deçà de
// seize chiffres significatifs, aucune perte n'est possible et l'on convertit
// directement — c'est le cas de la totalité des montants réels.
//
// Cette garde est le filet. La vraie protection est la contrainte posée en base
// (migration 0085), qui empêche un tel montant d'être enregistré. Le filet sert
// pour ce qui existait déjà, pour les imports, et pour les valeurs calculées à
// la volée par une requête.
// Seuil au-delà duquel un nombre JavaScript ne porte plus la quatrième
// décimale : 2^53 / 10^4, soit environ 900 milliards. Recopié ici plutôt
// qu'importé — ce fichier est chargé avant tout le reste, et une dépendance de
// plus au démarrage se paierait à chaque connexion.
const MONTANT_MAX_SUR = Math.floor(Number.MAX_SAFE_INTEGER / 10 ** 4);

pg.types.setTypeParser(1700, (v) => {
  if (v === null) return null;
  const n = Number(v);

  // Sous le seuil, la conversion est exacte au dix-millième près : on rend le
  // nombre sans rien vérifier. C'est le cas de la totalité des montants réels,
  // et la lecture reste aussi rapide qu'avant.
  //
  // On ne contrôle PAS le nombre de décimales : une division ou une moyenne
  // calculée en base rend un numeric à vingt décimales (un ratio, un taux), que
  // l'arrondi flottant traite parfaitement. Ce n'est pas un montant, et le
  // rejeter serait une panne, pas un garde-fou.
  if (Math.abs(n) <= MONTANT_MAX_SUR) return n;

  // Au-dessus, on n'accepte que si la conversion est RÉVERSIBLE : on réécrit le
  // nombre avec autant de décimales que la base en a fourni, et l'on exige le
  // même texte. Sinon, refus — mieux vaut une erreur franche qu'un chiffre faux
  // dans une balance.
  const decimales = (v.split('.')[1] ?? '').length;
  if (decimales <= 20 && n.toFixed(decimales) === v) return n;

  throw new Error(
    `Montant illisible sans perte : la base contient ${v}, que Nova ne peut pas `
    + `restituer au centime près. Ce montant dépasse les limites admises `
    + `(${MONTANT_MAX_SUR.toLocaleString('fr-FR')}) : il doit être corrigé à la source `
    + `avant toute exploitation comptable.`);
});

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://nova_app:nova_app@localhost:5432/nova',
  max: 10,
});

export type Client = pg.PoolClient;

/**
 * Exécute `fn` dans une transaction en positionnant l'identité courante
 * (RLS via app.current_user_id). Toute opération comptable passe par ici :
 * c'est le seul endroit où l'on ouvre une transaction et fixe le tenant.
 */
export async function withUser<T>(
  userId: string | null,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (userId) {
      await client.query("select set_config('app.current_user_id', $1, true)", [userId]);
    }
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
