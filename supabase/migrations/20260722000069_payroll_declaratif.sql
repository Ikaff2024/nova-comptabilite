-- =============================================================================
-- Nova Comptabilité — 0069 : champs déclaratifs officiels de la fiche salarié
-- =============================================================================
-- Requis par les exports aux modèles officiels (CNPS nominatif, État 301, FUDP)
-- et par l'allocation spéciale de fonction introduite dans le moteur de paie.
-- Tous optionnels : les fiches existantes restent valides, les exports signalent
-- les manques plutôt que d'échouer.
--
--   indemnite_fonction : allocation spéciale couvrant les frais inhérents à la
--     fonction (art. 116-1° CGI) — exonérée dans la limite de 10 % de la
--     rémunération totale. Le moteur la calcule déjà ; il manquait la saisie.
--   numero_cnps  : immatriculation CNPS DU SALARIÉ (≠ n° employeur du dossier)
--   sexe         : 'M' | 'F'
--   nationalite  : code État 301 — I (ivoirienne) | AA (Afrique) | F (France)
--                  | SL (hors Afrique/France) | A (autre)
--   local_expatrie : 'L' (local) | 'E' (expatrié) — pilote la Contribution
--                  Employeur (0 % local / 9,2 % expatrié)
--   code_emploi  : code État 301 — DR CS AM CM EQ EN OQ ON A ; à défaut,
--                  l'export le déduit de la catégorie socio-professionnelle.
-- =============================================================================

alter table payroll_employees
  add column if not exists indemnite_fonction numeric(20,2) not null default 0,
  add column if not exists numero_cnps        text,
  add column if not exists sexe               text,
  add column if not exists nationalite        text,
  add column if not exists local_expatrie     text,
  add column if not exists code_emploi        text;
