-- =============================================================================
-- Nova Comptabilité — 20260725000070 : intitulés du plan SYSCOHADA — nettoyage et qualification
-- =============================================================================
-- GÉNÉRÉ par scripts/gen_seed.mjs (ne pas éditer à la main).
-- Reprend 96 intitulés : suppression des renvois de notes de bas de page
-- du Journal Officiel (« ([1]) », « [(2)] »…) et qualification des subdivisions
-- qui ne se lisent pas seules (« dans la Région » -> « ACHATS DE MARCHANDISES —
-- dans la Région »). Ces intitulés alimentent le prompt de la capture IA, la
-- balance, le grand livre et les états : leur clarté est fonctionnelle.
-- Un intitulé modifié par un cabinet n'est pas écrasé (jointure sur l'ancienne
-- valeur exacte).
-- =============================================================================

-- Une seule instruction (CTE modifiante) : pas de table temporaire, donc
-- indépendant du lanceur de migrations (psql en autocommit comme scripts/migrate.mjs).
with relabel(code, before_label, after_label) as (values
  ('1661'::text,'sur emprunts obligataires'::text,'INTÉRÊTS COURUS — sur emprunts obligataires'::text),
  ('1662','sur emprunts et dettes auprès des établissements de crédit','INTÉRÊTS COURUS — sur emprunts et dettes auprès des établissements de crédit'),
  ('1663','sur avances reçues de l''État','INTÉRÊTS COURUS — sur avances reçues de l''État'),
  ('1664','sur avances reçues et comptes courants bloqués','INTÉRÊTS COURUS — sur avances reçues et comptes courants bloqués'),
  ('1665','sur dépôts et cautionnements reçus','INTÉRÊTS COURUS — sur dépôts et cautionnements reçus'),
  ('1667','sur avances assorties de conditions particulières','INTÉRÊTS COURUS — sur avances assorties de conditions particulières'),
  ('1668','sur autres emprunts et dettes','INTÉRÊTS COURUS — sur autres emprunts et dettes'),
  ('1762','sur dettes de location acquisition/ crédit– bail immobilier','INTÉRÊTS COURUS — sur dettes de location acquisition/ crédit– bail immobilier'),
  ('1763','sur  dettes de location acquisition/ crédit – bail mobilier','INTÉRÊTS COURUS — sur dettes de location acquisition/ crédit – bail mobilier'),
  ('1764','sur  dettes de location acquisition/location-vente','INTÉRÊTS COURUS — sur dettes de location acquisition/location-vente'),
  ('1768','sur autres dettes de location acquisition','INTÉRÊTS COURUS — sur autres dettes de location acquisition'),
  ('2231','pour bâtiments industriels et agricoles','TERRAINS BÂTIS — pour bâtiments industriels et agricoles'),
  ('2232','pour bâtiments administratifs et commerciaux','TERRAINS BÂTIS — pour bâtiments administratifs et commerciaux'),
  ('2234','pour bâtiments affectés aux autres opérations professionnelles','TERRAINS BÂTIS — pour bâtiments affectés aux autres opérations professionnelles'),
  ('2235','pour bâtiments affectés aux autres opérations non professionnelles','TERRAINS BÂTIS — pour bâtiments affectés aux autres opérations non professionnelles'),
  ('231','BÂTIMENTS INDUSTRIELS, AGRICOLES, ADMINISTRATIFS  ET COMMERCIAUX SUR SOL PROPRE','BÂTIMENTS INDUSTRIELS, AGRICOLES, ADMINISTRATIFS ET COMMERCIAUX SUR SOL PROPRE'),
  ('2912','Dépréciation des brevets, licences, concessions  et droits similaires','Dépréciation des brevets, licences, concessions et droits similaires'),
  ('462','ASSOCIÉS [(1)], COMPTES COURANTS','ASSOCIÉS, COMPTES COURANTS'),
  ('463','ASSOCIÉS [(1)], OPÉRATIONS FAITES EN COMMUN ET GIE','ASSOCIÉS, OPÉRATIONS FAITES EN COMMUN ET GIE'),
  ('465','ASSOCIÉS [(1)], DIVIDENDES À PAYER','ASSOCIÉS, DIVIDENDES À PAYER'),
  ('4816','Réserve de propriété [(1)]','Réserve de propriété'),
  ('4817','Retenues de garantie [(1)]','Retenues de garantie'),
  ('4818','Factures non parvenues [(1)]','Factures non parvenues'),
  ('4911','Créances  litigieuses','Créances litigieuses'),
  ('5024','Actions démembrées (certificats d''investissement ; droits de vote)','Actions démembrées (certificats d''investissement; droits de vote)'),
  ('5711','en unités monétaires légales','CAISSE SIÈGE SOCIAL — en unités monétaires légales'),
  ('5712','en devises','CAISSE SIÈGE SOCIAL — en devises'),
  ('5721','en unités monétaires légales','CAISSE SUCCURSALE A — en unités monétaires légales'),
  ('5722','en devises','CAISSE SUCCURSALE A — en devises'),
  ('5731','en unités monétaires légales','CAISSE SUCCURSALE B — en unités monétaires légales'),
  ('5732','en devises','CAISSE SUCCURSALE B — en devises'),
  ('6011','dans la Région','ACHATS DE MARCHANDISES — dans la Région'),
  ('6012','hors Région (1)','ACHATS DE MARCHANDISES — hors Région'),
  ('6013','aux entités du groupe dans la Région','ACHATS DE MARCHANDISES — aux entités du groupe dans la Région'),
  ('6014','aux entités du groupe hors Région','ACHATS DE MARCHANDISES — aux entités du groupe hors Région'),
  ('6015','Frais sur achats [(2)]','Frais sur achats'),
  ('6021','dans la Région (1)','ACHATS DE MATIÈRES PREMIÈRES ET FOURNITURES LIÉES — dans la Région'),
  ('6022','hors Région (1)','ACHATS DE MATIÈRES PREMIÈRES ET FOURNITURES LIÉES — hors Région'),
  ('6023','aux entités du groupe dans la Région','ACHATS DE MATIÈRES PREMIÈRES ET FOURNITURES LIÉES — aux entités du groupe dans la Région'),
  ('6024','aux entités du groupe hors Région','ACHATS DE MATIÈRES PREMIÈRES ET FOURNITURES LIÉES — aux entités du groupe hors Région'),
  ('6025','Frais sur achats [(2)]','Frais sur achats'),
  ('6045','Frais sur achats [(2)]','Frais sur achats'),
  ('6085','Frais sur achats [(2)]','Frais sur achats'),
  ('6542','immobilisations corporelles','VALEUR COMPTABLE DES CESSIONS COURANTES D''IMMOBILISATIONS — immobilisations corporelles'),
  ('6591','sur risques à court terme','CHARGES POUR DEPRECIATION ET PROVISION POUR RISQUES A COURT TERME D''EXPLOITATION — sur risques à court terme'),
  ('6593','sur stocks','CHARGES POUR DEPRECIATION ET PROVISION POUR RISQUES A COURT TERME D''EXPLOITATION — sur stocks'),
  ('6594','sur créances','CHARGES POUR DEPRECIATION ET PROVISION POUR RISQUES A COURT TERME D''EXPLOITATION — sur créances'),
  ('6781','sur rentes viagères','PERTES ET CHARGES SUR RISQUES FINANCIERS — sur rentes viagères'),
  ('6782','sur opérations financières','PERTES ET CHARGES SUR RISQUES FINANCIERS — sur opérations financières'),
  ('6784','sur instruments de trésorerie','PERTES ET CHARGES SUR RISQUES FINANCIERS — sur instruments de trésorerie'),
  ('6791','sur risques financiers','CHARGES POUR DEPRECIATIONS ET PROVISIONS POUR RISQUES A COURT TERME FINANCIÈRES — sur risques financiers'),
  ('6795','sur titres de placement','CHARGES POUR DEPRECIATIONS ET PROVISIONS POUR RISQUES A COURT TERME FINANCIÈRES — sur titres de placement'),
  ('7011','dans la Région','VENTES DE MARCHANDISES — dans la Région'),
  ('7012','hors Région (1)','VENTES DE MARCHANDISES — hors Région'),
  ('7013','aux entités du groupe dans la Région','VENTES DE MARCHANDISES — aux entités du groupe dans la Région'),
  ('7014','aux entités du groupe hors Région','VENTES DE MARCHANDISES — aux entités du groupe hors Région'),
  ('7021','dans la Région (1)','VENTES DE PRODUITS FINIS — dans la Région'),
  ('7022','hors Région (1)','VENTES DE PRODUITS FINIS — hors Région'),
  ('7023','aux entités du groupe dans la Région','VENTES DE PRODUITS FINIS — aux entités du groupe dans la Région'),
  ('7024','aux entités du groupe hors Région','VENTES DE PRODUITS FINIS — aux entités du groupe hors Région'),
  ('7031','dans la Région (1)','VENTES DE PRODUITS INTERMÉDIAIRES — dans la Région'),
  ('7032','hors Région (1)','VENTES DE PRODUITS INTERMÉDIAIRES — hors Région'),
  ('7033','aux entités du groupe dans la Région','VENTES DE PRODUITS INTERMÉDIAIRES — aux entités du groupe dans la Région'),
  ('7034','aux entités du groupe hors Région','VENTES DE PRODUITS INTERMÉDIAIRES — aux entités du groupe hors Région'),
  ('7041','dans la Région (1)','VENTES DE PRODUITS RÉSIDUELS — dans la Région'),
  ('7042','hors Région (1)','VENTES DE PRODUITS RÉSIDUELS — hors Région'),
  ('7043','aux entités du groupe dans la Région','VENTES DE PRODUITS RÉSIDUELS — aux entités du groupe dans la Région'),
  ('7044','aux entités du groupe hors Région','VENTES DE PRODUITS RÉSIDUELS — aux entités du groupe hors Région'),
  ('7051','dans la Région (1)','TRAVAUX FACTURÉS — dans la Région'),
  ('7052','hors Région (1)','TRAVAUX FACTURÉS — hors Région'),
  ('7053','aux entités du groupe dans la Région','TRAVAUX FACTURÉS — aux entités du groupe dans la Région'),
  ('7054','aux entités du groupe hors Région','TRAVAUX FACTURÉS — aux entités du groupe hors Région'),
  ('7061','dans la Région (1)','SERVICES VENDUS — dans la Région'),
  ('7062','hors Région (1)','SERVICES VENDUS — hors Région'),
  ('7063','aux entités du groupe dans la Région','SERVICES VENDUS — aux entités du groupe dans la Région'),
  ('7064','aux entités du groupe hors Région','SERVICES VENDUS — aux entités du groupe hors Région'),
  ('7073','Locations (2)','Locations'),
  ('7075','Mise à disposition de personnel (2)','Mise à disposition de personnel'),
  ('7076','Redevances pour brevets, logiciels, marques et droits similaires (2)','Redevances pour brevets, logiciels, marques et droits similaires'),
  ('7222','immobilisations corporelles (actifs biologiques)','IMMOBILISATIONS CORPORELLES — immobilisations corporelles (actifs biologiques)'),
  ('7591','sur risques à court terme','REPRISES DE CHARGES POUR DEPRECIATIONS ET PROVISIONS POUR RISQUES A COURT TERME D''EXPLOITATION — sur risques à court terme'),
  ('7593','sur stocks','REPRISES DE CHARGES POUR DEPRECIATIONS ET PROVISIONS POUR RISQUES A COURT TERME D''EXPLOITATION — sur stocks'),
  ('7594','sur créances','REPRISES DE CHARGES POUR DEPRECIATIONS ET PROVISIONS POUR RISQUES A COURT TERME D''EXPLOITATION — sur créances'),
  ('7598','sur autres chargespour dépréciation et provisions pour risques à court terme d''exploitation','REPRISES DE CHARGES POUR DEPRECIATIONS ET PROVISIONS POUR RISQUES A COURT TERME D''EXPLOITATION — sur autres chargespour dépréciation et provisions pour risques à court terme d''exploitation'),
  ('7781','sur rentes viagères','GAINS SUR RISQUES FINANCIERS — sur rentes viagères'),
  ('7782','sur opérations financières','GAINS SUR RISQUES FINANCIERS — sur opérations financières'),
  ('7784','sur instruments de trésorerie','GAINS SUR RISQUES FINANCIERS — sur instruments de trésorerie'),
  ('7791','sur risques financiers','REPRISES DE CHARGES POUR DEPRECIATIONS ET PROVISIONS A COURT TERME FINANCIÈRES — sur risques financiers'),
  ('7795','sur titres de placement','REPRISES DE CHARGES POUR DEPRECIATIONS ET PROVISIONS A COURT TERME FINANCIÈRES — sur titres de placement'),
  ('7798','sur autres charges pour dépréciations et provisions à court terme financières','REPRISES DE CHARGES POUR DEPRECIATIONS ET PROVISIONS A COURT TERME FINANCIÈRES — sur autres charges pour dépréciations et provisions à court terme financières'),
  ('7911','pour risques et charges','REPRISES DE PROVISIONS ET DE DEPRECIATIONS D''EXPLOITATION — pour risques et charges'),
  ('7913','pour dépréciation des immobilisations incorporelles','REPRISES DE PROVISIONS ET DE DEPRECIATIONS D''EXPLOITATION — pour dépréciation des immobilisations incorporelles'),
  ('7914','pour dépréciation des immobilisations corporelles','REPRISES DE PROVISIONS ET DE DEPRECIATIONS D''EXPLOITATION — pour dépréciation des immobilisations corporelles'),
  ('7971','pour risques et charges','REPRISES DE PROVISIONS ET DE DEPRECIATIONS FINANCIÈRES — pour risques et charges'),
  ('7972','pour dépréciation des immobilisations financières','REPRISES DE PROVISIONS ET DE DEPRECIATIONS FINANCIÈRES — pour dépréciation des immobilisations financières'),
  ('849','REPRISES DES CHARGES POUR DEPRECIATIONS ET  PROVISIONS POUR RISQUES A COURT TERME H.A.O.','REPRISES DES CHARGES POUR DEPRECIATIONS ET PROVISIONS POUR RISQUES A COURT TERME H.A.O.')
),
maj_gabarit as (
  update chart_template_accounts ta set label = r.after_label
    from relabel r
   where ta.account_code = r.code and ta.label = r.before_label
  returning 1
)
update accounts a set label = r.after_label
  from relabel r
 where a.account_code = r.code and a.label = r.before_label;
