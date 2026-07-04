import type { Client } from '../db.js';

// Modèles de saisie : gabarits d'écriture réutilisables (pas de planification).

export interface TemplateLine { accountCode: string; label?: string; debit?: number; credit?: number }

export async function listTemplates(c: Client, dossierId: string): Promise<any[]> {
  const { rows } = await c.query(
    'select id, name, journal_code, lines from entry_templates where dossier_id=$1 order by name', [dossierId]);
  return rows.map((r: any) => ({ id: r.id, name: r.name, journalCode: r.journal_code, lines: r.lines }));
}

export async function createTemplate(c: Client, dossierId: string, name: string, journalCode: string | null, lines: TemplateLine[]): Promise<{ id: string }> {
  if (!name?.trim()) throw new Error('Nom du modèle requis.');
  const clean = (lines ?? []).filter((l) => l.accountCode?.trim());
  if (clean.length < 2) throw new Error('Un modèle exige au moins 2 lignes.');
  const { rows } = await c.query(
    'insert into entry_templates(dossier_id, name, journal_code, lines) values ($1,$2,$3,$4::jsonb) returning id',
    [dossierId, name.trim(), journalCode ?? null, JSON.stringify(clean)]);
  return { id: rows[0].id };
}

export async function deleteTemplate(c: Client, dossierId: string, id: string): Promise<void> {
  await c.query('delete from entry_templates where dossier_id=$1 and id=$2', [dossierId, id]);
}
