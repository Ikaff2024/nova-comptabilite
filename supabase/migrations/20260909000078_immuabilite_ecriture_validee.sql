-- =============================================================================
-- Nova Comptabilité — 0078 : l'immuabilité ne couvrait pas l'AJOUT de lignes
-- =============================================================================
-- FAILLE D'INTÉGRITÉ CORRIGÉE ICI (revue CTO 001, NOVA-P0-03).
--
-- Le verrou des écritures validées s'écrivait :
--
--     create trigger trg_protect_lines
--       before update or delete on entry_lines        -- INSERT absent
--
-- On ne pouvait donc ni modifier ni supprimer une ligne d'écriture validée,
-- mais on pouvait lui en AJOUTER. Le second garde-fou — le trigger d'équilibre
-- différé — ne rattrapait rien, puisqu'il contrôle la SOMME des lignes : une
-- paire ajoutée au débit ET au crédit laisse la somme inchangée. Les deux
-- contrôles se croisaient sans se rencontrer.
--
-- Reproduction (rôle applicatif, sur son propre dossier, dans une transaction) :
--
--     écriture validée      777 777 XOF, 2 lignes
--     + 500 000 au débit
--     + 500 000 au crédit
--     commit                                    ← aucune erreur
--     écriture validée    1 277 777 XOF, 4 lignes
--     statut 'posted', posted_at inchangé, aucune trace
--
-- Conséquence : les comptes mouvementés, la TVA et les états financiers d'une
-- écriture réputée figée pouvaient changer après validation, sans piste d'audit.
-- L'auditabilité AUDCIF repose sur cette garantie ; elle n'existait pas.
--
-- ── Politique retenue, explicite ────────────────────────────────────────────
--
-- STATUTS FINAUX : 'posted' et 'reversed'.
--
--   'posted'   — l'écriture est au grand livre. Elle produit ses effets.
--   'reversed' — statut hérité. Depuis la migration 0075, une contre-passation
--                laisse l'écriture d'origine en 'posted' et la marque par
--                reversed_by_entry_id ; 'reversed' n'est donc plus posé et
--                l'existant a été ramené à 'posted'. On le traite quand même
--                comme final : le laisser ouvert rouvrirait par la bande les
--                écritures d'une base ancienne ou d'un futur code qui le
--                reposerait.
--
--   'draft'    — SEUL statut mutable. Un brouillon n'a aucun effet comptable :
--                on l'amende et on le supprime librement.
--
-- Sur une écriture en statut final :
--   · aucune ligne ajoutée, modifiée ou supprimée ;
--   · aucune donnée économique ou d'audit de l'en-tête modifiée ;
--   · seule sortie : la contre-passation contrôlée (reverse_entry).
--
-- ── Ce qui reste modifiable sur l'en-tête, et pourquoi ──────────────────────
--
-- La liste blanche ci-dessous n'ouvre que le strict nécessaire à la
-- contre-passation et au démontage d'un dossier :
--
--   status                — transition 'posted' -> 'reversed' (compatibilité).
--   reversed_by_entry_id  — posé par reverse_entry sur l'écriture d'ORIGINE,
--                           qui reste 'posted' depuis 0075. Sans cela, plus
--                           aucune contre-passation n'est possible.
--   reverses_entry_id     — remis à NULL par dossier_delete (0068/0077), qui
--                           dénoue les liens croisés avant de supprimer.
--
-- Tout le reste est figé, y compris ce que l'ancienne liste noire laissait
-- passer sans le dire : piece_ref (clé de la piste d'audit), posted_at
-- (antidatage de la validation), document_url, ai_confidence, created_by.
--
-- Régression couverte par supabase/tests/p0_invariants.sql (§ NOVA-P0-03),
-- qui rejoue le scénario 777 777 -> 1 277 777 et refuse de passer s'il aboutit.
-- =============================================================================

-- --- 1) Lignes d'une écriture en statut final : ni ajout, ni modif, ni suppr. --

create or replace function protect_posted_lines() returns trigger
language plpgsql as $$
declare
  v_entry_id uuid := coalesce(new.entry_id, old.entry_id);
  v_status   entry_status;
begin
  select status into v_status from entries where id = v_entry_id;

  -- Écriture parente absente : suppression en cascade dans la même transaction
  -- (delete on entries -> cascade sur entry_lines). Rien à protéger.
  if v_status is null then
    return coalesce(new, old);
  end if;

  if v_status in ('posted', 'reversed') then
    if tg_op = 'INSERT' then
      raise exception
        'Ajout interdit : l''écriture % est comptabilisée, on ne lui ajoute pas de ligne (contre-passez-la)',
        v_entry_id;
    elsif tg_op = 'DELETE' then
      raise exception
        'Suppression interdite : les lignes de l''écriture % sont verrouillées (contre-passez-la)',
        v_entry_id;
    else
      raise exception
        'Modification interdite : les lignes de l''écriture % sont verrouillées (contre-passez-la)',
        v_entry_id;
    end if;
  end if;

  return coalesce(new, old);
end $$;

-- Le trigger doit être recréé : on ne peut pas ajouter INSERT à un trigger
-- existant. Même nom, mêmes autres événements — seul INSERT s'ajoute.
drop trigger if exists trg_protect_lines on entry_lines;
create trigger trg_protect_lines
  before insert or update or delete on entry_lines
  for each row execute function protect_posted_lines();

-- --- 2) En-tête d'une écriture en statut final : liste BLANCHE ----------------
-- L'ancienne version énumérait les colonnes interdites. Une liste noire laisse
-- passer tout ce qu'on a oublié d'y écrire — et il manquait piece_ref,
-- posted_at, document_url, ai_confidence et created_by. On inverse : tout est
-- figé sauf les trois colonnes nommées plus haut.

create or replace function protect_posted_entries() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('posted', 'reversed') then
      raise exception
        'Suppression interdite : écriture % comptabilisée (contre-passez-la)', old.id;
    end if;
    return old;
  end if;

  if old.status in ('posted', 'reversed') then
    -- Seule transition de statut tolérée : 'posted' -> 'reversed'.
    if new.status not in ('posted', 'reversed') then
      raise exception
        'Retour arrière interdit : l''écriture % est comptabilisée, elle ne redevient pas un brouillon', old.id;
    end if;

    -- Liste blanche. On compare les deux versions de la ligne ENTIÈRE, privées
    -- des seules colonnes autorisées. Passer par to_jsonb plutôt que d'énumérer
    -- les colonnes n'est pas un raccourci : c'est ce qui fait que toute colonne
    -- ajoutée plus tard au schéma est figée par défaut, sans qu'il faille
    -- penser à revenir ici. C'est précisément l'oubli qui a créé cette faille.
    if (to_jsonb(new) - 'status' - 'reversed_by_entry_id' - 'reverses_entry_id')
       is distinct from
       (to_jsonb(old) - 'status' - 'reversed_by_entry_id' - 'reverses_entry_id') then
      raise exception
        'Modification interdite : l''écriture % est comptabilisée, elle est immuable (contre-passez-la)', old.id;
    end if;
  end if;

  return new;
end $$;

-- Recréation par sécurité : la définition du trigger ne change pas, mais on
-- garantit qu'il pointe bien la nouvelle fonction et qu'il existe.
drop trigger if exists trg_protect_entries on entries;
create trigger trg_protect_entries
  before update or delete on entries
  for each row execute function protect_posted_entries();
