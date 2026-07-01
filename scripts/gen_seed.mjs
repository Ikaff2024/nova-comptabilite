import fs from 'node:fs';

const SRC = 'c:/Users/YEO ISSA/nova-comptabilité/plan_comptable_OHADA_valide.txt';
const OUT = 'c:/Users/YEO ISSA/nova-comptabilité/supabase/migrations/20260629000006_seed_syscohada.sql';

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

// nettoyage des marqueurs de notes de bas de page issus du PDF, ex " ([1])"
const cleanLabel = s => s.replace(/\s*\(\[\d+\]\)/g, '').trim();
const esc = s => cleanLabel(s).replace(/'/g, "''");

const valueRows = accounts.map(a => {
  const pc = parentCode(a);
  return `  ('${a.code}','${esc(a.label)}',${a.classNo},'${accountType(a)}','${normalSide(a)}',${pc ? `'${pc}'` : 'NULL'},${isCollective(a)})`;
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

// petit rapport
const byClass = {};
for (const a of accounts) byClass[a.classNo] = (byClass[a.classNo] || 0) + 1;
console.log('Comptes parsés :', accounts.length);
console.log('Par classe :', JSON.stringify(byClass));
console.log('Collectifs :', accounts.filter(isCollective).length);
console.log('Sans parent (racines) :', accounts.filter(a => !parentCode(a)).length);
