-- =============================================================================
-- Nova Comptabilité — 0008 : Utilisateurs & authentification
-- =============================================================================
-- Auth maison, host-agnostique : les comptes vivent dans Postgres. Le login se
-- fait via des fonctions SECURITY DEFINER (lecture par email sans contexte
-- utilisateur), jamais par un trou dans la RLS. Le mot de passe n'est JAMAIS
-- stocké en clair — le backend dépose un hash scrypt (`scrypt$sel$hash`).
-- =============================================================================

create table app_users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  password_hash text not null,
  name          text,
  created_at    timestamptz not null default now()
);

alter table app_users enable row level security;

-- Un utilisateur ne lit/écrit que sa propre fiche (via RLS classique).
create policy app_users_self on app_users for select
  using (id = app_current_user_id());

-- --- Inscription (email unique) ----------------------------------------------

create or replace function register_user(p_email text, p_hash text, p_name text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into app_users(email, password_hash, name)
    values (lower(trim(p_email)), p_hash, p_name)
    returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'EMAIL_TAKEN';
end $$;

-- --- Récupération pour login (par email, sans RLS) ---------------------------

create or replace function get_user_for_login(p_email text)
returns table(id uuid, password_hash text, name text, email text)
language sql security definer set search_path = public as $$
  select id, password_hash, name, email from app_users where email = lower(trim(p_email))
$$;

-- --- Profil par id (pour /me) ------------------------------------------------

create or replace function get_user(p_id uuid)
returns table(id uuid, email text, name text)
language sql security definer set search_path = public as $$
  select id, email, name from app_users where id = p_id
$$;

grant execute on function register_user(text, text, text) to nova_app;
grant execute on function get_user_for_login(text) to nova_app;
grant execute on function get_user(uuid) to nova_app;
