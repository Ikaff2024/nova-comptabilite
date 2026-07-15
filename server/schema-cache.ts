import { pool } from './db.js';

// ============================================================================
// Tolérance au schéma en retard. En production, les migrations peuvent ne pas
// être encore appliquées (rôle runtime sans DDL, déploiement décalé). Plutôt
// que de casser toute l'API si une nouvelle colonne/table manque, on teste son
// existence (information_schema, hors transaction du client appelant) et on
// dégrade proprement. Résultat positif mis en cache définitivement (une fois la
// migration passée, la colonne/table existe pour toujours) ; résultat négatif
// re-testé (pour s'activer automatiquement dès que la migration est appliquée).
// ============================================================================

const cache = new Map<string, boolean>();

export async function columnExists(table: string, column: string): Promise<boolean> {
  const key = `c:${table}.${column}`;
  if (cache.get(key)) return true;
  try {
    const { rows } = await pool.query(
      'select 1 from information_schema.columns where table_schema=\'public\' and table_name=$1 and column_name=$2 limit 1',
      [table, column]);
    const ok = rows.length > 0;
    if (ok) cache.set(key, true);
    return ok;
  } catch { return false; }
}

export async function tableExists(table: string): Promise<boolean> {
  const key = `t:${table}`;
  if (cache.get(key)) return true;
  try {
    const { rows } = await pool.query(
      'select 1 from information_schema.tables where table_schema=\'public\' and table_name=$1 limit 1', [table]);
    const ok = rows.length > 0;
    if (ok) cache.set(key, true);
    return ok;
  } catch { return false; }
}
