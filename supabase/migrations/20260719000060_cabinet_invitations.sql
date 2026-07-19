-- =============================================================================
-- Nova Comptabilité — 0060 : invitations de collaborateurs
-- =============================================================================
-- Jusqu'ici, on ne pouvait rattacher qu'une personne AYANT DÉJÀ un compte Nova.
-- On ajoute une invitation par email : le destinataire reçoit un lien, crée son
-- compte, et se retrouve automatiquement rattaché au cabinet avec le rôle prévu.
--
-- Le destinataire n'est PAS authentifié quand il ouvre le lien : la consultation
-- et l'acceptation passent par des fonctions SECURITY DEFINER clés sur le TOKEN
-- (le secret), comme le pont des canaux. Le token est à usage unique et expire.
-- =============================================================================

create table cabinet_invitations (
  id               uuid primary key default gen_random_uuid(),
  cabinet_id       uuid not null references cabinets(id) on delete cascade,
  email            text not null,
  role             cabinet_role not null default 'collaborateur',
  token            text not null unique,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '14 days',
  accepted_at      timestamptz,
  accepted_user_id uuid
);

create index idx_cab_inv_cabinet on cabinet_invitations(cabinet_id, created_at desc);
-- une seule invitation en attente par (cabinet, email)
create unique index uq_cab_inv_pending on cabinet_invitations(cabinet_id, lower(email))
  where accepted_at is null;

alter table cabinet_invitations enable row level security;
create policy cabinet_invitations_rw on cabinet_invitations for all
  using (cabinet_id in (select app_cabinet_ids()))
  with check (cabinet_id in (select app_cabinet_ids()));

-- --- Consultation publique d'une invitation (par token) -----------------------
-- N'expose que le strict nécessaire pour afficher l'écran d'acceptation.
create or replace function invitation_info(p_token text)
returns table(email text, role cabinet_role, cabinet_name text, expired boolean, accepted boolean)
language sql security definer set search_path = public as $$
  select i.email, i.role, c.name,
         (i.expires_at < now()) as expired,
         (i.accepted_at is not null) as accepted
    from cabinet_invitations i
    join cabinets c on c.id = i.cabinet_id
   where i.token = p_token
   limit 1;
$$;

-- --- Acceptation : rattache l'utilisateur au cabinet --------------------------
-- p_user_id est fourni par le serveur (compte créé ou session vérifiée), jamais
-- par le client. Le token reste le secret qui autorise le rattachement.
create or replace function invitation_accept(p_token text, p_user_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_inv cabinet_invitations%rowtype;
begin
  select * into v_inv from cabinet_invitations where token = p_token;
  if v_inv.id is null then raise exception 'INVITATION_INVALID'; end if;
  if v_inv.accepted_at is not null then raise exception 'INVITATION_USED'; end if;
  if v_inv.expires_at < now() then raise exception 'INVITATION_EXPIRED'; end if;

  insert into cabinet_members(cabinet_id, user_id, role)
    values (v_inv.cabinet_id, p_user_id, v_inv.role)
    on conflict (cabinet_id, user_id) do update set role = excluded.role;

  update cabinet_invitations
     set accepted_at = now(), accepted_user_id = p_user_id
   where id = v_inv.id;

  return v_inv.cabinet_id;
end $$;

grant execute on function invitation_info(text) to nova_app;
grant execute on function invitation_accept(text, uuid) to nova_app;
