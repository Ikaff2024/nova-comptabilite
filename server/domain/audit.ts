import type { Client } from '../db.js';

// ============================================================================
// Piste d'audit. recordAudit insère une trace horodatée dans le même
// transaction que l'action auditée ; l'acteur (id + nom/email dénormalisés) est
// résolu via app_current_user_id() (GUC de session posée par withUser).
// La table est APPEND-ONLY (UPDATE/DELETE retirés au rôle applicatif).
// ============================================================================

export interface AuditInput {
  dossierId?: string | null;
  action: string;              // 'entry.posted', 'exercise.closed', 'invoice.issued'…
  entity?: string;
  entityId?: string;
  detail?: Record<string, any>;
}

export async function recordAudit(c: Client, input: AuditInput): Promise<void> {
  await c.query(
    `insert into audit_log(user_id, user_name, user_email, dossier_id, action, entity, entity_id, detail)
     values (
       app_current_user_id(),
       (select name from app_users where id = app_current_user_id()),
       (select email from app_users where id = app_current_user_id()),
       $1, $2, $3, $4, $5::jsonb
     )`,
    [input.dossierId ?? null, input.action, input.entity ?? null, input.entityId ?? null,
     JSON.stringify(input.detail ?? {})],
  );
}

export async function listAudit(c: Client, dossierId: string, limit = 200): Promise<any[]> {
  const { rows } = await c.query(
    `select id, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') as created_at,
            user_name, user_email, action, entity, entity_id, detail
       from audit_log
      where dossier_id = $1
      order by created_at desc, id desc
      limit $2`,
    [dossierId, limit],
  );
  return rows;
}
