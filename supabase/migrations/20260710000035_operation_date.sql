-- =============================================================================
-- Nova Comptabilité — 0035 : Date d'origine d'une ligne (reprise d'antériorité)
-- =============================================================================
-- Lors d'une migration vers Nova, les en-cours tiers (factures ouvertes) sont
-- repris dans l'écriture d'à-nouveaux, datée à l'ouverture de l'exercice. Pour
-- ne PAS perdre l'ancienneté réelle de ces créances/dettes, chaque ligne peut
-- porter la date d'origine de la pièce (operation_date). La balance âgée et les
-- relances utilisent coalesce(operation_date, entry_date). Champ optionnel :
-- une écriture normale n'en a pas besoin.
-- =============================================================================

alter table entry_lines add column if not exists operation_date date;
