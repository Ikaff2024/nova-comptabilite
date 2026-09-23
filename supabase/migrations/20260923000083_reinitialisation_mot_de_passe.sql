-- =============================================================================
-- Nova Comptabilité — 0083 : récupération de mot de passe
-- =============================================================================
-- Constat N10 (P2) de l'audit externe : l'écran de connexion ne propose aucun
-- recours en cas de mot de passe oublié — ni lien, ni contact de support. Un
-- utilisateur qui oublie son mot de passe est simplement dehors, sans issue.
-- C'est le défaut qu'un pilote rencontre dès la première semaine.
--
-- ── Ce que la table stocke, et ce qu'elle ne stocke pas ─────────────────────
--
-- Jamais le jeton lui-même : seulement son empreinte SHA-256. Une fuite de
-- lecture sur cette table ne permettrait donc de prendre aucun compte. C'est le
-- même raisonnement que pour les mots de passe, appliqué à un secret qui ouvre
-- exactement les mêmes portes le temps de sa validité.
--
-- ── Usage unique et expiration ──────────────────────────────────────────────
--
-- used_at rend le jeton inopérant après son premier emploi, et expires_at borne
-- sa durée de vie à une heure. Les deux sont vérifiés en base, dans la même
-- requête que la consommation, pour qu'aucune concurrence ne permette
-- d'utiliser deux fois le même lien.
--
-- ── Invalidation des sessions ouvertes ──────────────────────────────────────
--
-- app_users.token_version compte les réinitialisations. Le numéro est inscrit
-- dans le jeton de session à l'émission et revérifié à chaque requête : changer
-- de mot de passe incrémente le compteur, et TOUS les jetons émis avant
-- deviennent invalides.
--
-- Sans cela, la récupération serait un demi-service : quelqu'un qui aurait volé
-- une session garderait l'accès pendant sept jours après que la victime a repris
-- la main. L'audit l'exige d'ailleurs explicitement (« invalidation après
-- succès »). Cela referme au passage une partie de NOVA-P2-02 de la revue CTO.
-- =============================================================================

alter table app_users add column if not exists token_version integer not null default 0;

create table if not exists password_resets (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references app_users(id) on delete cascade,
  token_hash   text not null unique,          -- SHA-256 du jeton, jamais le jeton
  expires_at   timestamptz not null,
  used_at      timestamptz,
  requested_ip text,
  created_at   timestamptz not null default now()
);

create index if not exists idx_password_resets_user on password_resets(user_id);
create index if not exists idx_password_resets_expiry on password_resets(expires_at);

-- Table d'identité, hors périmètre dossier : même traitement que app_users.
alter table password_resets enable row level security;
alter table password_resets force row level security;

-- Aucune policy : le rôle applicatif ne lit ni n'écrit cette table directement.
-- Tout passe par les fonctions SECURITY DEFINER ci-dessous, qui sont les seules
-- à connaître la règle. Un SELECT direct depuis l'API ne renverrait rien — et
-- c'est voulu : il n'y a aucune raison légitime de parcourir les jetons.

-- --- Demande : crée un jeton, sans révéler si le compte existe ---------------
-- Renvoie l'identifiant et l'email du compte quand il existe, NULL sinon.
-- L'appelant répond la même chose dans les deux cas : c'est la couche API qui
-- garantit la non-divulgation, cette fonction se contente de ne rien inventer.

create or replace function password_reset_demander(p_email text, p_token_hash text, p_ip text)
returns table(user_id uuid, email text, name text)
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_email text; v_name text;
begin
  select u.id, u.email, u.name into v_id, v_email, v_name
    from app_users u where lower(u.email) = lower(trim(p_email));
  if v_id is null then return; end if;

  -- Une demande annule les précédentes encore valides : un seul lien vivant à
  -- la fois, sinon un ancien courriel resterait exploitable.
  update password_resets set used_at = now()
   where password_resets.user_id = v_id and used_at is null and expires_at > now();

  insert into password_resets(user_id, token_hash, expires_at, requested_ip)
    values (v_id, p_token_hash, now() + interval '1 hour', p_ip);

  return query select v_id, v_email, v_name;
end $$;

-- --- Consommation : vérifie, applique, invalide ------------------------------
-- Tout en une seule transaction : le jeton est marqué utilisé, le mot de passe
-- remplacé et le compteur de sessions incrémenté. Si quoi que ce soit échoue,
-- rien n'est appliqué.

create or replace function password_reset_appliquer(p_token_hash text, p_password_hash text)
returns table(user_id uuid, email text)
language plpgsql security definer set search_path = public as $$
declare v_reset password_resets%rowtype; v_email text;
begin
  -- « for update » : deux emplois simultanés du même lien se sérialisent, et le
  -- second voit used_at déjà posé.
  select * into v_reset from password_resets
   where token_hash = p_token_hash for update;

  if v_reset.id is null then raise exception 'RESET_INCONNU'; end if;
  if v_reset.used_at is not null then raise exception 'RESET_DEJA_UTILISE'; end if;
  if v_reset.expires_at <= now() then raise exception 'RESET_EXPIRE'; end if;

  update password_resets set used_at = now() where id = v_reset.id;

  update app_users
     set password_hash = p_password_hash,
         token_version = token_version + 1   -- invalide toutes les sessions ouvertes
   where id = v_reset.user_id
  returning app_users.email into v_email;

  return query select v_reset.user_id, v_email;
end $$;

-- --- Lecture de la version de session ----------------------------------------
-- Appelée à chaque requête authentifiée pour comparer au numéro porté par le
-- jeton. SQL pur et STABLE : exécutable sans transaction applicative.

create or replace function user_token_version(p_id uuid)
returns integer
language sql stable security definer set search_path = public as $$
  select token_version from app_users where id = p_id
$$;

grant execute on function password_reset_demander(text, text, text) to nova_app;
grant execute on function password_reset_appliquer(text, text)      to nova_app;
grant execute on function user_token_version(uuid)                  to nova_app;

-- get_user / get_user_for_login exposent désormais token_version, pour que
-- l'émission d'un jeton de session y inscrive le numéro courant.
drop function if exists get_user_for_login(text);
create function get_user_for_login(p_email text)
returns table(id uuid, password_hash text, name text, email text, totp_secret text,
              totp_enabled boolean, is_platform_admin boolean, token_version integer)
language sql security definer set search_path = public as $$
  select id, password_hash, name, email, totp_secret, totp_enabled, is_platform_admin, token_version
    from app_users where email = lower(trim(p_email));
$$;

drop function if exists get_user(uuid);
create function get_user(p_id uuid)
returns table(id uuid, email text, name text, totp_enabled boolean,
              is_platform_admin boolean, token_version integer)
language sql security definer set search_path = public as $$
  select id, email, name, totp_enabled, is_platform_admin, token_version
    from app_users where id = p_id;
$$;

grant execute on function get_user_for_login(text) to nova_app;
grant execute on function get_user(uuid) to nova_app;
