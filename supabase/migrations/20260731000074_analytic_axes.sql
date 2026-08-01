-- =============================================================================
-- Nova Comptabilité — 0074 : plusieurs axes analytiques
-- =============================================================================
-- Jusqu'ici Nova n'avait qu'un axe : entry_lines.analytic_axis, une colonne
-- texte portant le code d'une section. Une entreprise qui suit ses agences ne
-- pouvait donc pas suivre EN PLUS ses activités ou ses chantiers — sauf à
-- encoder les combinaisons dans le code de section (« ABIDJAN-NOVA »), ce qui
-- explose en nombre et interdit toute agrégation sur une seule dimension.
--
-- Choix de structure, et ce qu'il protège :
--
--  · Les sections gagnent un axe. Un axe PRINCIPAL par dossier, créé
--    automatiquement, reçoit les sections existantes : rien ne bouge pour qui
--    n'en déclare qu'un.
--
--  · L'axe principal reste stocké dans entry_lines.analytic_axis. Les axes
--    SUIVANTS passent par une table de jointure. Ce n'est pas une hésitation :
--    dix-sept fichiers écrivent déjà analytic_axis (facturation, achats, banque,
--    mobile money, abonnements, immobilisations, production interne, Lexa…). Si
--    la colonne devenait un miroir dénormalisé, il suffirait qu'un seul de ces
--    chemins oublie d'écrire la ligne de jointure pour que l'axe disparaisse des
--    états sans que rien ne le signale. En laissant la colonne faire foi pour
--    l'axe principal, ces chemins restent justes sans être touchés.
--
--  · Une ligne porte AU PLUS une valeur par axe (index unique). Pas de
--    ventilation au pourcentage entre deux sections d'un même axe : elle
--    doublerait la complexité de tous les états analytiques pour un besoin qui
--    n'est pas encore exprimé. Le jour où il le sera, la table est prête à
--    recevoir une colonne de quote-part.
--
--  · Les codes de section restent uniques par DOSSIER, pas par axe. Comme
--    analytic_axis stocke un code nu, deux axes partageant un code rendraient
--    la colonne ambiguë.
-- =============================================================================

create table if not exists analytic_axes (
  id         uuid primary key default gen_random_uuid(),
  dossier_id uuid not null references dossiers(id) on delete cascade,
  code       text not null,
  label      text not null,
  is_primary boolean not null default false,
  position   int not null default 0,
  created_at timestamptz not null default now(),
  unique (dossier_id, code)
);

create index if not exists idx_analytic_axes_dossier on analytic_axes(dossier_id);

-- Un seul axe principal par dossier : c'est lui qui adosse entry_lines.analytic_axis.
create unique index if not exists uq_analytic_axes_primary
  on analytic_axes(dossier_id) where is_primary;

alter table analytic_axes enable row level security;
drop policy if exists analytic_axes_rw on analytic_axes;
create policy analytic_axes_rw on analytic_axes for all
  using (dossier_id in (select app_dossier_ids()))
  with check (dossier_id in (select app_dossier_ids()));

-- --- Rattachement des sections à un axe --------------------------------------

alter table analytic_sections add column if not exists axis_id uuid references analytic_axes(id) on delete cascade;

-- Amorçage : un axe principal pour CHAQUE dossier existant, et les sections
-- déjà saisies lui reviennent. Fait en une passe, sans table temporaire (les
-- migrations tournent en autocommit via psql).
insert into analytic_axes(dossier_id, code, label, is_primary, position)
  select d.id, 'SECTION', 'Section analytique', true, 0
    from dossiers d
   where not exists (select 1 from analytic_axes a where a.dossier_id = d.id and a.is_primary);

update analytic_sections s
   set axis_id = a.id
  from analytic_axes a
 where a.dossier_id = s.dossier_id and a.is_primary and s.axis_id is null;

alter table analytic_sections alter column axis_id set not null;

create index if not exists idx_analytic_sections_axis on analytic_sections(axis_id);

-- Tout nouveau dossier naît avec son axe principal : aucun chemin de création
-- ne peut l'oublier, ni l'onboarding, ni les jeux de démonstration, ni un test.
create or replace function analytic_axis_bootstrap() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into analytic_axes(dossier_id, code, label, is_primary, position)
    values (new.id, 'SECTION', 'Section analytique', true, 0)
    on conflict do nothing;
  return new;
end $$;

drop trigger if exists trg_analytic_axis_bootstrap on dossiers;
create trigger trg_analytic_axis_bootstrap after insert on dossiers
  for each row execute function analytic_axis_bootstrap();

-- --- Valeurs des axes secondaires sur la ligne d'écriture ---------------------

create table if not exists entry_line_analytics (
  entry_line_id uuid not null references entry_lines(id) on delete cascade,
  dossier_id    uuid not null references dossiers(id) on delete cascade,
  axis_id       uuid not null references analytic_axes(id) on delete cascade,
  section_id    uuid not null references analytic_sections(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (entry_line_id, axis_id)
);

create index if not exists idx_ela_dossier on entry_line_analytics(dossier_id);
create index if not exists idx_ela_axis on entry_line_analytics(axis_id, section_id);

alter table entry_line_analytics enable row level security;
drop policy if exists entry_line_analytics_rw on entry_line_analytics;
create policy entry_line_analytics_rw on entry_line_analytics for all
  using (dossier_id in (select app_dossier_ids()))
  with check (dossier_id in (select app_dossier_ids()));

grant select, insert, update, delete on analytic_axes to nova_app;
grant select, insert, update, delete on entry_line_analytics to nova_app;
grant execute on function analytic_axis_bootstrap() to nova_app;

-- --- L'extourne recopie les axes ---------------------------------------------
-- Une contre-passation qui perdrait la ventilation analytique laisserait la
-- charge annulée dans la section d'origine et son annulation nulle part : les
-- deux états seraient faux, et l'écart ne se verrait qu'au total, où il est nul.
create or replace function reverse_entry(p_entry_id uuid, p_date date default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_src entries%rowtype;
  v_new_id uuid;
  v_line entry_lines%rowtype;
  v_new_line uuid;
begin
  select * into v_src from entries where id = p_entry_id;
  if v_src.id is null then raise exception 'Écriture introuvable'; end if;

  -- garde de périmètre : si un utilisateur est dans le contexte, il doit avoir accès au dossier
  if app_current_user_id() is not null
     and not exists (select 1 from (select app_dossier_ids() as id) s where s.id = v_src.dossier_id) then
    raise exception 'Accès refusé au dossier de l''écriture %', p_entry_id;
  end if;

  if v_src.status <> 'posted' then raise exception 'Seule une écriture validée se contre-passe'; end if;
  if v_src.reversed_by_entry_id is not null then raise exception 'Écriture déjà contre-passée'; end if;

  insert into entries (dossier_id, fiscal_year_id, journal_id, entry_date, piece_ref,
                       description, status, source, reverses_entry_id, created_by)
  values (v_src.dossier_id, v_src.fiscal_year_id, v_src.journal_id,
          coalesce(p_date, current_date), v_src.piece_ref,
          'EXTOURNE — ' || v_src.description, 'draft', v_src.source, v_src.id, v_src.created_by)
  returning id into v_new_id;

  for v_line in select * from entry_lines where entry_id = p_entry_id order by line_no loop
    insert into entry_lines (entry_id, dossier_id, account_id, line_no,
        amount_debit, amount_credit, orig_currency, orig_amount, fx_rate, label,
        counterparty_id, tax_code_id, payment_channel, certification, normalized_cat, analytic_axis)
    values (v_new_id, v_line.dossier_id, v_line.account_id, v_line.line_no,
        v_line.amount_credit, v_line.amount_debit, v_line.orig_currency, v_line.orig_amount,
        v_line.fx_rate, 'Extourne : ' || coalesce(v_line.label,''),
        v_line.counterparty_id, v_line.tax_code_id, v_line.payment_channel,
        v_line.certification, v_line.normalized_cat, v_line.analytic_axis)
    returning id into v_new_line;

    insert into entry_line_analytics (entry_line_id, dossier_id, axis_id, section_id)
      select v_new_line, ela.dossier_id, ela.axis_id, ela.section_id
        from entry_line_analytics ela where ela.entry_line_id = v_line.id;
  end loop;

  update entries set status = 'posted' where id = v_new_id;
  update entries set status = 'reversed', reversed_by_entry_id = v_new_id where id = p_entry_id;
  return v_new_id;
end $$;

grant execute on function reverse_entry(uuid, date) to nova_app;
