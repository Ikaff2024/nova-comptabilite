-- =============================================================================
-- Nova Comptabilité — 0084 : trois invariants comptables ramenés EN BASE
-- =============================================================================
-- Revue CTO 001, constats NOVA-P1-01, P1-02 et P1-03.
--
-- L'en-tête de la migration 0004 énonce le contrat fondateur du produit :
--
--     « Ces règles vivent EN BASE (pas dans l'applicatif). C'est ce qui garantit
--       que l'IA, l'API ou un bug ne peuvent jamais produire une compta
--       déséquilibrée ou altérer le passé. »
--
-- La revue a montré que ce contrat n'était tenu que pour l'ÉQUILIBRE. Quatre
-- autres invariants vivaient en TypeScript. La migration 0078 a ramené
-- l'immuabilité ; celle-ci ramène les trois derniers.
--
-- Aucun n'était atteignable par l'application : postEntry() les impose tous.
-- C'est précisément ce qui les rendait dangereux — la protection était une
-- propriété du code appelant, pas une garantie du moteur. Elle disparaissait au
-- premier second chemin d'écriture : un import, un outil de Lexa, un script de
-- reprise. Et aucun des ~540 contrôles automatisés ne l'aurait vu, puisqu'ils
-- empruntent tous le chemin sûr.
--
-- ── Les trois trous, reproduits ─────────────────────────────────────────────
--
-- P1-01  NON TRAITÉ ICI, ET C'EST DÉLIBÉRÉ. La revue recommandait d'interdire
--        en base l'imputation sur un compte « non mouvementable ». Mise à
--        l'épreuve, cette recommandation s'est révélée FAUSSE : dans le plan
--        SYSCOHADA livré, is_postable = false signifie « ce compte a des
--        subdivisions », pas « on n'y impute pas ».
--
--        Les comptes refusés par le verrou étaient 411 CLIENTS, 401
--        FOURNISSEURS, 521 BANQUES LOCALES, 571 CAISSE, 443 TVA FACTURÉE,
--        661 RÉMUNÉRATIONS, 245 MATÉRIEL DE TRANSPORT — c'est-à-dire les
--        comptes de tenue les plus courants d'une PME, et ceux sur lesquels
--        NOVA LUI-MÊME écrit : issueInvoice() impute le 411 et le 443, la paie
--        le 661, les immobilisations le 245.
--
--        Douze suites de tests sur vingt-deux tombaient. Le défaut n'était pas
--        dans les tests : une règle qui interdit à la facturation d'écrire au
--        compte client n'est pas un garde-fou, c'est une panne.
--
--        L'imputation sur un compte de regroupement reste ce qu'elle était :
--        un point de QUALITÉ, détecté par le contrôle de révision (« compte de
--        tête mouvementé »), à arbitrer par le comptable. Un cabinet qui tient
--        des auxiliaires voudra descendre au 4011 ; une petite entreprise
--        s'arrête au 401, et elle a raison.
--
-- P1-02  écriture datée du 04/07/2019 rattachée à l'exercice 2026 : ACCEPTÉE.
--        check_period_open() vérifiait que l'exercice n'était pas clôturé, pas
--        que la date y tombait. L'écriture compte alors dans la balance de
--        l'exercice mais sort de tout état filtré par date — journal, grand
--        livre, TFT, FEC. Deux lectures du même exercice divergent.
--
-- P1-03  ligne du dossier A imputée sur un compte du dossier A2 : ACCEPTÉE.
--        Entre cabinets la RLS l'empêche, mais entre deux clients d'un MÊME
--        cabinet — le cas normal d'un cabinet d'expertise — les deux dossiers
--        sont dans app_dossier_ids() et rien ne s'y oppose. Le grand livre
--        joint accounts sur account_id : le libellé affiché serait celui du
--        dossier voisin.
--
-- ── Portée : les écritures FUTURES ──────────────────────────────────────────
--
-- Un trigger ne relit pas l'existant. Les données déjà non conformes ne sont ni
-- rejetées ni modifiées — aucune perte, aucun blocage au déploiement. Pour les
-- inventorier, la vue de diagnostic v_anomalies_invariants ci-dessous les liste
-- sans rien corriger : le redressement est un acte comptable, il revient au
-- cabinet, et il se fait par contre-passation.
-- =============================================================================

-- --- 1) Cohérence d'une ligne d'écriture --------------------------------------
-- Un seul trigger pour deux invariants : ils portent sur la même ligne, au même
-- moment, et les séparer multiplierait les lectures de `accounts`.

create or replace function check_entry_line_coherence() returns trigger
language plpgsql as $$
declare
  v_acc record;
  v_entry_dossier uuid;
begin
  select a.dossier_id, a.account_code, a.label, a.is_postable
    into v_acc
    from accounts a where a.id = new.account_id;

  if v_acc is null then
    raise exception 'Compte introuvable pour cette ligne d''écriture';
  end if;

  -- (a) NOVA-P1-03 — le compte appartient au dossier de la ligne.
  if v_acc.dossier_id is distinct from new.dossier_id then
    raise exception
      'Compte % appartient à un autre dossier : une écriture ne peut pas s''imputer sur le plan comptable d''un autre client',
      v_acc.account_code;
  end if;

  -- (b) NOVA-P1-03 (suite) — la ligne appartient au dossier de son écriture.
  select e.dossier_id into v_entry_dossier from entries e where e.id = new.entry_id;
  if v_entry_dossier is not null and v_entry_dossier is distinct from new.dossier_id then
    raise exception
      'Ligne rattachée au dossier % alors que son écriture appartient au dossier %',
      new.dossier_id, v_entry_dossier;
  end if;

  -- Pas de contrôle sur is_postable : voir l'en-tête. Dans le plan livré, ce
  -- drapeau dit « ce compte a des subdivisions », pas « on n'y impute pas ».
  return new;
end $$;

drop trigger if exists trg_entry_line_coherence on entry_lines;
create trigger trg_entry_line_coherence
  before insert or update on entry_lines
  for each row execute function check_entry_line_coherence();

-- --- 2) La date tombe dans l'exercice ----------------------------------------
-- On enrichit check_period_open plutôt que d'ajouter un trigger : les deux
-- règles portent sur le même couple (écriture, exercice) au même instant.
--
-- POINT DE VIGILANCE, et raison d'être de la condition sur tg_op :
-- ce trigger s'exécute sur INSERT ET UPDATE. Sans la garde, mettre à jour une
-- écriture DÉJÀ validée et déjà hors bornes — ce que fait reverse_entry en
-- posant reversed_by_entry_id — se verrait refuser. Or c'est exactement le
-- geste par lequel on RÉPARE une écriture mal datée (outil « réaffecter
-- l'exercice »). Le contrôle ne doit donc valoir qu'au moment où l'écriture
-- DEVIENT validée, pas à chaque retouche ultérieure.

create or replace function check_period_open() returns trigger
language plpgsql as $$
declare v_fy fiscal_years%rowtype;
begin
  if new.status <> 'posted' then return new; end if;

  select * into v_fy from fiscal_years where id = new.fiscal_year_id;
  if v_fy.id is null then
    raise exception 'Exercice introuvable pour l''écriture %', new.id;
  end if;

  if v_fy.status = 'closed' then
    raise exception 'Exercice clôturé : impossible de valider l''écriture %', new.id;
  end if;

  -- Uniquement à la validation (insertion déjà validée, ou passage à validé).
  if tg_op = 'INSERT' or old.status is distinct from 'posted' then
    if new.entry_date < v_fy.start_date or new.entry_date > v_fy.end_date then
      raise exception
        'Date % hors de l''exercice « % » (% → %) : rattachez l''écriture à l''exercice correspondant, ou corrigez sa date',
        to_char(new.entry_date, 'DD/MM/YYYY'), v_fy.label,
        to_char(v_fy.start_date, 'DD/MM/YYYY'), to_char(v_fy.end_date, 'DD/MM/YYYY');
    end if;
  end if;

  return new;
end $$;

-- --- 3) Diagnostic de l'existant ---------------------------------------------
-- Liste ce qui viole les règles ci-dessus SANS rien corriger. Une écriture
-- validée est immuable : son redressement passe par une contre-passation, qui
-- est une décision comptable — pas quelque chose qu'une migration s'arroge.
--
-- security_invoker : chaque cabinet ne voit que ses propres anomalies.

create or replace view v_anomalies_invariants
with (security_invoker = true) as
  select l.dossier_id, e.id as entry_id, e.entry_date, e.description, e.status,
         a.account_code, 'compte d''un autre dossier'::text as anomalie
    from entry_lines l
    join entries e on e.id = l.entry_id
    join accounts a on a.id = l.account_id
   where a.dossier_id is distinct from l.dossier_id
  union all
  select l.dossier_id, e.id, e.entry_date, e.description, e.status,
         a.account_code, 'compte de regroupement mouvementé (qualité, pas erreur)'
    from entry_lines l
    join entries e on e.id = l.entry_id
    join accounts a on a.id = l.account_id
   where a.is_postable is false
  union all
  select e.dossier_id, e.id, e.entry_date, e.description, e.status,
         null, 'date hors des bornes de son exercice'
    from entries e
    join fiscal_years f on f.id = e.fiscal_year_id
   where e.entry_date < f.start_date or e.entry_date > f.end_date;

grant select on v_anomalies_invariants to nova_app;
