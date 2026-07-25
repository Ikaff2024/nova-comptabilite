import fs from 'node:fs';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'plan_comptable_OHADA_valide.txt');
const OUT = path.join(ROOT, 'supabase/migrations/20260629000006_seed_syscohada.sql');
// Rattrapage des intitulés pour les bases déjà migrées (le seed ne rejoue pas).
const OUT_RELABEL = path.join(ROOT, 'supabase/migrations/20260725000070_chart_labels.sql');

const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);

let currentClass = null;
const accounts = []; // {code,label,classNo}
const classRe = /^=+\s*CLASSE\s+(\d)\s*=+/i;
const acctRe = /^(\d{3,})\s+(.+?)\s*$/;

for (const raw of lines) {
  const line = raw.trimEnd();
  const cm = line.match(classRe);
  if (cm) { currentClass = parseInt(cm[1], 10); continue; }
  const am = line.match(acctRe);
  if (am && currentClass != null) {
    accounts.push({ code: am[1], label: am[2].trim(), classNo: currentClass });
  }
}

const codeSet = new Set(accounts.map(a => a.code));

function p2(c) { return c.slice(0, 2); }

function accountType(a) {
  const { classNo, code } = a;
  const d2 = parseInt(p2(code), 10); // ex 10,16,41...
  switch (classNo) {
    case 1: return d2 <= 15 ? 'equity' : 'liability';
    case 2: return 'asset';
    case 3: return 'asset';
    case 4: return p2(code) === '41' ? 'asset' : 'liability';
    case 5: return 'asset';
    case 6: return 'expense';
    case 7: return 'income';
    case 8: {
      if (code.startsWith('89')) return 'expense';
      const second = parseInt(code[1], 10);
      return second % 2 === 0 ? 'income' : 'expense'; // pair=produit, impair=charge
    }
    case 9: return 'analytic';
    default: return 'asset';
  }
}

function normalSide(a) {
  const { classNo, code } = a;
  const pref2 = p2(code);
  switch (classNo) {
    case 1: return 'credit';
    case 2: return (pref2 === '28' || pref2 === '29') ? 'credit' : 'debit';
    case 3: return (pref2 === '39') ? 'credit' : 'debit';
    case 4: return pref2 === '41' ? 'debit' : 'credit';
    case 5: return pref2 === '59' ? 'credit' : 'debit';
    case 6: return 'debit';
    case 7: return 'credit';
    case 8: {
      if (code.startsWith('89')) return 'debit';
      const second = parseInt(code[1], 10);
      return second % 2 === 0 ? 'credit' : 'debit';
    }
    case 9: return 'debit';
    default: return 'debit';
  }
}

function isCollective(a) {
  // Tiers principaux (fournisseurs/clients/personnel) au niveau 3 chiffres
  return a.code.length === 3 && ['40', '41', '42'].includes(p2(a.code));
}

function parentCode(a) {
  if (a.code.length > 3) {
    const parent = a.code.slice(0, a.code.length - 1);
    // remonte jusqu'à trouver un parent existant (ex 4-digit -> 3-digit)
    let p = parent;
    while (p.length >= 3) {
      if (codeSet.has(p)) return p;
      p = p.slice(0, p.length - 1);
    }
  }
  return null;
}

// --- Intitulés ----------------------------------------------------------------
// Le fichier source reproduit la mise en page du Journal Officiel : il en reste
// (a) des renvois de notes de bas de page — « ([1]) », « [(2)] », « (1) » — et
// (b) des intitulés de subdivision qui ne se lisent qu'accolés à leur parent
// (« dans la Région » sous 601 ACHATS DE MARCHANDISES, « sur emprunts
// obligataires » sous 166). La casse fait foi dans le document : MAJUSCULES =
// compte de regroupement, minuscule initiale = subdivision dépendante.
// Ces intitulés partent tels quels dans le prompt de la capture IA, dans la
// balance, le grand livre et les états : on les nettoie et on les qualifie.

// Ancien nettoyage (ce qui est aujourd'hui en base) — sert à cibler la migration
// de mise à jour sans écraser un intitulé retouché par un cabinet.
const legacyLabel = s => s.replace(/\s*\(\[\d+\]\)/g, '').trim();

// Renvois de notes sous toutes leurs formes OCR, y compris en milieu de chaîne
// (« ASSOCIÉS [(1)], COMPTES COURANTS »).
const stripNotes = s => s
  .replace(/\s*\(\[\d+\]\)/g, '')
  .replace(/\s*\[\(\d+\)\]/g, '')
  .replace(/\s+\(\d{1,2}\)/g, '')
  .replace(/\s{2,}/g, ' ')
  .replace(/\s+([,;])/g, '$1')
  .trim();

const byCode = new Map(accounts.map(a => [a.code, a]));
const startsLower = s => { const m = s.match(/\p{L}/u); return !!m && m[0] === m[0].toLowerCase(); };

// Intitulé qualifié : « PARENT — subdivision ». Remonte tant que le parent est
// lui-même une subdivision dépendante.
function qualifiedLabel(a, seen = new Set()) {
  const own = stripNotes(a.label);
  if (!startsLower(own) || seen.has(a.code)) return own;
  seen.add(a.code);
  const pc = parentCode(a);
  const parent = pc ? byCode.get(pc) : null;
  if (!parent) return own;
  return `${qualifiedLabel(parent, seen)} — ${own}`;
}

const esc = s => s.replace(/'/g, "''");

// (code, intitulé actuel en base, nouvel intitulé) pour ceux qui changent.
const relabelled = accounts
  .map(a => ({ code: a.code, before: legacyLabel(a.label), after: qualifiedLabel(a) }))
  .filter(x => x.before !== x.after);

const valueRows = accounts.map(a => {
  const pc = parentCode(a);
  return `  ('${a.code}','${esc(qualifiedLabel(a))}',${a.classNo},'${accountType(a)}','${normalSide(a)}',${pc ? `'${pc}'` : 'NULL'},${isCollective(a)})`;
});

const header = `-- =============================================================================
-- Nova Comptabilité — 0006 : Seed du plan comptable SYSCOHADA révisé (gabarit)
-- =============================================================================
-- GÉNÉRÉ depuis plan_comptable_OHADA_valide.txt (SYSCOHADA révisé 2018, ${accounts.length} comptes).
-- type / sens normal / hiérarchie dérivés par règles (raffinables ultérieurement).
-- Ne pas éditer à la main : régénérer via scripts/gen_seed.mjs.
-- =============================================================================

insert into chart_templates (code, label, version, is_default)
values ('SYSCOHADA', 'Plan comptable SYSCOHADA révisé (AUDCIF)', '2018', true)
on conflict (code, version) do nothing;

insert into chart_template_accounts
  (template_id, account_code, label, class_no, account_type, normal_side, parent_code, is_collective)
select t.id, v.account_code, v.label, v.class_no, v.account_type::account_type,
       v.normal_side::account_nature, v.parent_code, v.is_collective
from chart_templates t,
  (values
${valueRows.join(',\n')}
  ) as v(account_code, label, class_no, account_type, normal_side, parent_code, is_collective)
where t.code = 'SYSCOHADA' and t.version = '2018'
on conflict (template_id, account_code) do nothing;
`;

const fn = `
-- --- Instanciation du gabarit dans un dossier (à l'ouverture) ------------------

create or replace function instantiate_chart(p_dossier_id uuid, p_template_code text default 'SYSCOHADA', p_version text default '2018')
returns integer
language plpgsql security definer as $$
declare v_tmpl uuid; v_count integer;
begin
  select id into v_tmpl from chart_templates where code = p_template_code and version = p_version;
  if v_tmpl is null then raise exception 'Gabarit % % introuvable', p_template_code, p_version; end if;

  insert into accounts (dossier_id, account_code, label, class_no, account_type, normal_side, is_collective, is_postable)
  select p_dossier_id, ta.account_code, ta.label, ta.class_no, ta.account_type, ta.normal_side, ta.is_collective,
         not exists (select 1 from chart_template_accounts c2 where c2.template_id = v_tmpl and c2.parent_code = ta.account_code)
  from chart_template_accounts ta
  where ta.template_id = v_tmpl
  on conflict (dossier_id, account_code) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end $$;
`;

fs.writeFileSync(OUT, header + fn, 'utf8');

// --- Migration de rattrapage des intitulés ------------------------------------
// Le seed 0006 ne rejoue pas sur une base déjà migrée : les dossiers existants
// gardent les anciens intitulés. On génère donc une migration qui les reprend,
// gabarit ET dossiers, en ne touchant QUE les intitulés restés à leur valeur
// d'origine (un intitulé retouché par un cabinet est préservé).
const relabelSql = `-- =============================================================================
-- Nova Comptabilité — ${OUT_RELABEL.match(/(\d{14})/)?.[1] ?? ''} : intitulés du plan SYSCOHADA — nettoyage et qualification
-- =============================================================================
-- GÉNÉRÉ par scripts/gen_seed.mjs (ne pas éditer à la main).
-- Reprend ${relabelled.length} intitulés : suppression des renvois de notes de bas de page
-- du Journal Officiel (« ([1]) », « [(2)] »…) et qualification des subdivisions
-- qui ne se lisent pas seules (« dans la Région » -> « ACHATS DE MARCHANDISES —
-- dans la Région »). Ces intitulés alimentent le prompt de la capture IA, la
-- balance, le grand livre et les états : leur clarté est fonctionnelle.
-- Un intitulé modifié par un cabinet n'est pas écrasé (jointure sur l'ancienne
-- valeur exacte).
-- =============================================================================

-- Une seule instruction (CTE modifiante) : pas de table temporaire, donc
-- indépendant du lanceur de migrations (psql en autocommit comme scripts/migrate.mjs).
with relabel(code, before_label, after_label) as (values
${relabelled.map((x, i) => `  (${i === 0 ? "'" + x.code + "'::text,'" + esc(x.before) + "'::text,'" + esc(x.after) + "'::text" : `'${x.code}','${esc(x.before)}','${esc(x.after)}'`})`).join(',\n')}
),
maj_gabarit as (
  update chart_template_accounts ta set label = r.after_label
    from relabel r
   where ta.account_code = r.code and ta.label = r.before_label
  returning 1
)
update accounts a set label = r.after_label
  from relabel r
 where a.account_code = r.code and a.label = r.before_label;
`;
fs.writeFileSync(OUT_RELABEL, relabelSql, 'utf8');

// petit rapport
const byClass = {};
for (const a of accounts) byClass[a.classNo] = (byClass[a.classNo] || 0) + 1;
console.log('Comptes parsés :', accounts.length);
console.log('Par classe :', JSON.stringify(byClass));
console.log('Collectifs :', accounts.filter(isCollective).length);
console.log('Sans parent (racines) :', accounts.filter(a => !parentCode(a)).length);
console.log('Intitulés repris :', relabelled.length);
for (const x of relabelled.slice(0, 8)) console.log(`   ${x.code} : « ${x.before} » -> « ${x.after} »`);
