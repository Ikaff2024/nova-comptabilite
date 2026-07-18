import type { Client } from '../db.js';
import { tableExists } from '../schema-cache.js';

// ============================================================================
// Decision Ledger — journal de preuves des décisions de Lexa. Append-only.
// Chaque tour de l'agent est enregistré (question, outils appelés, contrôles
// AQM, score de confiance, réponse) pour l'explicabilité et l'audit.
//
// Résilient : si la table decision_ledger n'existe pas encore (migration 0056
// non appliquée), les écritures sont ignorées silencieusement et les lectures
// renvoient une liste vide. Ne doit JAMAIS faire échouer une réponse de Lexa.
// ============================================================================

export interface DecisionToolRef { name: string; ok: boolean; verdict?: string }
export interface DecisionRecord {
  dossierId: string;
  userId?: string | null;
  question?: string;
  mode?: string;
  model?: string;
  answer?: string;
  tools?: DecisionToolRef[];
  validations?: any[];
  confidence?: number | null;
  tokensIn?: number;
  tokensOut?: number;
}

export async function logDecision(c: Client, rec: DecisionRecord): Promise<void> {
  try {
    if (!(await tableExists('decision_ledger'))) return;
    await c.query(
      `insert into decision_ledger(dossier_id, user_id, question, mode, model, answer, tools, validations, confidence, tokens_in, tokens_out)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)`,
      [
        rec.dossierId, rec.userId ?? null, (rec.question ?? '').slice(0, 2000), rec.mode ?? null, rec.model ?? null,
        (rec.answer ?? '').slice(0, 8000), JSON.stringify(rec.tools ?? []), JSON.stringify(rec.validations ?? []),
        rec.confidence ?? null, rec.tokensIn ?? null, rec.tokensOut ?? null,
      ],
    );
  } catch { /* best-effort : ne jamais bloquer une réponse de Lexa */ }
}

export async function listDecisions(c: Client, dossierId: string, limit = 30): Promise<any[]> {
  if (!(await tableExists('decision_ledger'))) return [];
  const { rows } = await c.query(
    `select id, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') as created_at, question, mode, model,
            confidence, tools, jsonb_array_length(validations) as nb_validations
       from decision_ledger where dossier_id=$1 order by created_at desc limit $2`,
    [dossierId, Math.min(limit, 100)],
  );
  return rows.map((r: any) => ({
    id: r.id, createdAt: r.created_at, question: r.question, mode: r.mode, model: r.model,
    confidence: r.confidence, tools: r.tools ?? [], nbValidations: Number(r.nb_validations) || 0,
  }));
}

// Tableau de bord qualité (AQM) : agrège le Decision Ledger par type d'action —
// usage et taux de succès par outil, distribution des verdicts AQM, confiance
// moyenne, et décisions récentes à faible confiance. Vide si la table n'existe pas.
export async function qualityDashboard(c: Client, dossierId: string): Promise<any> {
  if (!(await tableExists('decision_ledger'))) return { available: false };

  const { rows: tot } = await c.query(
    `select count(*)::int as total,
            count(*) filter (where confidence is not null)::int as with_conf,
            coalesce(round(avg(confidence) filter (where confidence is not null)), 0)::int as avg_conf,
            count(*) filter (where confidence is not null and confidence < 70)::int as low_conf,
            to_char(min(created_at), 'YYYY-MM-DD') as since,
            to_char(max(created_at), 'YYYY-MM-DD') as until
       from decision_ledger where dossier_id=$1`, [dossierId]);

  const { rows: perTool } = await c.query(
    `select t->>'name' as name,
            count(*)::int as n,
            count(*) filter (where (t->>'ok') = 'true')::int as ok,
            count(*) filter (where t->>'verdict' = 'PASS')::int as pass,
            count(*) filter (where t->>'verdict' = 'WARNING')::int as warn,
            count(*) filter (where t->>'verdict' = 'FAIL')::int as fail
       from decision_ledger d
       cross join lateral jsonb_array_elements(d.tools) as t
      where d.dossier_id=$1
      group by name order by n desc limit 40`, [dossierId]);

  const { rows: lowc } = await c.query(
    `select id, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI') as created_at, question, confidence
       from decision_ledger
      where dossier_id=$1 and confidence is not null and confidence < 90
      order by created_at desc limit 8`, [dossierId]);

  const tools = perTool.map((r: any) => ({
    name: r.name, n: r.n, ok: r.ok, failRate: r.n ? Math.round((r.n - r.ok) / r.n * 100) : 0,
    pass: r.pass, warn: r.warn, fail: r.fail, isValidator: /^valider_/.test(r.name),
  }));
  const aqm = tools.filter((t: any) => t.isValidator).reduce(
    (s: any, t: any) => ({ pass: s.pass + t.pass, warn: s.warn + t.warn, fail: s.fail + t.fail }),
    { pass: 0, warn: 0, fail: 0 });

  return {
    available: true,
    total: tot[0]?.total ?? 0,
    avgConfidence: tot[0]?.with_conf ? tot[0].avg_conf : null,
    lowConfidence: tot[0]?.low_conf ?? 0,
    since: tot[0]?.since ?? null, until: tot[0]?.until ?? null,
    aqm,
    tools,
    lowConfidenceRecent: lowc.map((r: any) => ({ id: r.id, createdAt: r.created_at, question: r.question, confidence: r.confidence })),
  };
}

export async function getDecision(c: Client, dossierId: string, id: string): Promise<any | null> {
  if (!(await tableExists('decision_ledger'))) return null;
  const { rows } = await c.query(
    `select id, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') as created_at, question, mode, model, answer,
            tools, validations, confidence, tokens_in, tokens_out
       from decision_ledger where dossier_id=$1 and id=$2`,
    [dossierId, id],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id, createdAt: r.created_at, question: r.question, mode: r.mode, model: r.model, answer: r.answer,
    tools: r.tools ?? [], validations: r.validations ?? [], confidence: r.confidence,
    tokensIn: r.tokens_in, tokensOut: r.tokens_out,
  };
}
