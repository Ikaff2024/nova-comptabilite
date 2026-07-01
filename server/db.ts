import pg from 'pg';

const { Pool } = pg;

// Les montants NUMERIC reviennent en string par défaut (pg) -> on les parse en number.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

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
