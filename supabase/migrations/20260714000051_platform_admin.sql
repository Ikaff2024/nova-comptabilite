-- =============================================================================
-- Nova Comptabilité — 0051 : Console éditeur (opérateurs Nova)
-- =============================================================================
-- Vue TRANSVERSE à tous les cabinets, réservée à NOUS, éditeurs de Nova, pour
-- suivre nos clients (cabinets abonnés) : volumétrie, activité et coûts d'API.
-- Contourne volontairement la RLS via des fonctions SECURITY DEFINER, qui
-- s'auto-protègent (fail-closed) : elles lèvent une exception si l'appelant
-- n'est pas un administrateur plateforme. Aucun trou de RLS pour les cabinets.
-- =============================================================================

alter table app_users add column is_platform_admin boolean not null default false;

-- Amorçage : le fondateur + le compte de démonstration (pilote).
update app_users set is_platform_admin = true
  where lower(email) in ('ikaffanan@gmail.com', 'demo@nova-comptabilite.ci');

-- --- Identité : l'appelant est-il opérateur Nova ? ---------------------------
create or replace function app_is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_platform_admin from app_users where id = app_current_user_id()), false)
$$;

-- --- /me & login : exposent le drapeau opérateur -----------------------------
drop function if exists get_user_for_login(text);
create function get_user_for_login(p_email text)
returns table(id uuid, password_hash text, name text, email text, totp_secret text, totp_enabled boolean, is_platform_admin boolean)
language sql security definer set search_path = public as $$
  select id, password_hash, name, email, totp_secret, totp_enabled, is_platform_admin
    from app_users where email = lower(trim(p_email));
$$;

drop function if exists get_user(uuid);
create function get_user(p_id uuid)
returns table(id uuid, email text, name text, totp_enabled boolean, is_platform_admin boolean)
language sql security definer set search_path = public as $$
  select id, email, name, totp_enabled, is_platform_admin from app_users where id = p_id;
$$;

-- --- Vue par cabinet client (volumétrie, activité, coûts d'API) ---------------
create or replace function platform_cabinets()
returns table(
  cabinet_id uuid, name text, country text, created_at timestamptz,
  dossiers int, membres int, ecritures bigint,
  cost_30d numeric, cost_total numeric, last_activity timestamptz
)
language plpgsql security definer set search_path = public as $$
begin
  if not app_is_platform_admin() then
    raise exception 'NOT_PLATFORM_ADMIN';
  end if;
  return query
    select cb.id, cb.name::text, cb.country::text, cb.created_at,
      (select count(*)::int from dossiers d where d.cabinet_id = cb.id),
      (select count(*)::int from cabinet_members m where m.cabinet_id = cb.id),
      (select count(*)::bigint from entries e join dossiers d on d.id = e.dossier_id where d.cabinet_id = cb.id),
      (select coalesce(sum(u.cost_usd), 0) from api_usage u join dossiers d on d.id = u.dossier_id
         where d.cabinet_id = cb.id and u.created_at >= now() - interval '30 days'),
      (select coalesce(sum(u.cost_usd), 0) from api_usage u join dossiers d on d.id = u.dossier_id
         where d.cabinet_id = cb.id),
      greatest(
        (select max(e.created_at) from entries e join dossiers d on d.id = e.dossier_id where d.cabinet_id = cb.id),
        (select max(u.created_at) from api_usage u join dossiers d on d.id = u.dossier_id where d.cabinet_id = cb.id)
      )
    from cabinets cb
    order by cb.created_at;
end $$;

grant execute on function app_is_platform_admin() to nova_app;
grant execute on function get_user_for_login(text) to nova_app;
grant execute on function get_user(uuid) to nova_app;
grant execute on function platform_cabinets() to nova_app;
