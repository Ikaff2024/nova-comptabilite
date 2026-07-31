# Reste à faire

Relevé de ce qui a été décidé ou repéré sans être livré. Tenu à jour au fil des
sessions — quand un point est fait, il sort d'ici et vit dans le code.

Dernière mise à jour : 31 juillet 2026.

---

## 1. En attente d'une décision — rien ne peut avancer sans

### 1.1 Deux lectures à confirmer dans « Le Praticien », p. 885

La table de correspondance des postes du bilan ([etats-postes.ts](../server/domain/etats-postes.ts))
est saisie depuis l'ouvrage, sauf deux points restés en suspens :

- **poste AL** — `2394` ou `239` ? Si c'est `2394`, les immobilisations en cours
  `2391, 2392, 2393, 2395, 2398` ne tombent dans aucun poste et leur solde
  disparaît du bilan.
- **poste BS** — `581, 582` ou `58` ? Même conséquence pour `585 Virements de
  fonds` et `588 Autres virements internes`.

S'y ajoutent les comptes de liaison `186, 187, 188`, non captés non plus.

`npm run test:postes` liste ces dix comptes à chaque exécution. Le contrôle est
**non bloquant** volontairement : un trou visible vaut mieux qu'un trou comblé au
jugé. Le moteur, lui, les signale à l'exécution dans `comptesNonAffectes` — donc
rien ne s'évapore en silence en attendant.

### 1.2 Convention du bilan passif : Guide (8 lignes) ou AUDCIF (11 lignes) ?

Deux référentiels officiels divergent sur les références du bloc capitaux
propres. Nova suit l'AUDCIF/Praticien ; AuthNTIC raisonne en Guide et produit
une liasse AUDCIF en sortie. **Les deux sorties concordent aujourd'hui** — donc
aucune urgence — mais le jour où l'un des deux évolue, l'écart repart.

À trancher pour les **deux projets ensemble**, avec un chef comptable.

### 1.3 Texte intégral du SYSCOHADA : que fait-on du corpus ?

Trois options, jamais arbitrées :

1. **Corpus dérivé committé** — extraire les 73 blocs de doctrine par compte et
   les 517 entrées de lexique dans un fichier de données (~500 Ko), le reste
   ignoré. Recommandé fonctionnellement.
2. **Fichier hors dépôt**, monté au déploiement comme ressource — même mécanisme
   que `guide.ts`, qui se dégrade proprement si le fichier manque.
3. **On s'arrête là.**

C'est un Journal Officiel vendu 20 000 FCFA : la question est autant juridique
que technique. Sans arbitrage, le point 2.4 ci-dessous reste bloqué.

---

## 2. Prêt à construire

### 2.1 Plusieurs axes analytiques

Nova n'en a **qu'un** : `entry_lines.analytic_axis`, une colonne texte. Une
entreprise qui suit ses agences ne peut donc pas suivre en plus ses chantiers ou
ses activités — sauf à encoder les combinaisons dans le code de section
(`ABIDJAN-NOVA`), ce qui explose en nombre et interdit toute agrégation par une
seule dimension.

Conception retenue :

- une table `analytic_axes` par dossier — « Activité », « Agence », « Chantier ».
  La plupart n'en déclareront qu'un ;
- `analytic_sections` gagne son axe ; les sections existantes basculent sur un
  axe par défaut ;
- le lien ligne ↔ valeurs passe par une table de jointure, **pas** par des
  colonnes supplémentaires : sinon le nombre d'axes est plafonné par le schéma ;
- `entry_lines.analytic_axis` demeure comme axe principal, pour que tout
  l'existant continue de fonctionner sans réécriture. Les axes suivants
  s'ajoutent.

Portée : dix-sept fichiers lisent ou écrivent l'axe, plus le déclencheur SQL de
contre-passation qui le recopie. C'est un changement de structure du grand livre
— il mérite sa propre passe, pas d'être glissé entre deux fonctionnalités.

Question à trancher avant de commencer : **une ligne peut-elle être ventilée
entre plusieurs valeurs d'un même axe** (60 % agence A, 40 % agence B) ? Je
commencerais par non — une valeur par axe et par ligne — car la ventilation au
pourcentage double la complexité de tous les états analytiques.

À noter : cela ne change rien à la commission des vendeurs, désormais livrée. Le
vendeur est porté par `invoices.vendeur_id` — la **facture**, pas la ligne
d'écriture. Trois raisons qui tiendront quels que soient les axes : une commission
se calcule net des **avoirs**, et le lien facture → avoir n'existe pas au niveau
d'une ligne comptable ; la justification attendue sur le bulletin est la **liste
des factures**, pas une somme ; et le vendeur est connu à l'**émission**, par le
commercial, alors que l'axe se renseigne à la comptabilisation, plus tard et par
quelqu'un d'autre.

### 2.2 Réaffectation en masse des écritures mal rattachées

Le redressement **une par une** existe (Révision → Préparer, ou l'outil
`reaffecter_exercice` de Lexa). Sur quinze écritures ou plus, il faut un écran de
sélection avec l'aperçu de l'impact sur les **deux** exercices avant validation.

### 2.3 Rattachement analytique d'une immobilisation acquise

La route existe (`PATCH /assets/:id/analytic`) et l'immobilisation produite en
interne hérite de son chantier. Mais **aucun écran** ne permet de rattacher une
immobilisation achetée à une activité — donc la rentabilité par activité ignore
l'investissement des activités qui n'ont pas été construites en interne.

### 2.4 Doctrine SYSCOHADA accessible à Lexa

Dépend de 1.3. Ordre de valeur retenu, à rebours de l'intuition première :

1. **Opérations et problèmes spécifiques** (41 chapitres, ~149 k tokens, la
   partie la mieux transcrite) — crédit-bail, devises, contrats pluri-exercices,
   fusions, première application. C'est là que les modèles généralistes sont
   faibles et qu'un cabinet a réellement besoin d'aide.
2. **Lexique** — 517 entrées délimitées, risque quasi nul (les définitions ne
   portent pas de codes de comptes).
3. **Doctrine par compte**, *Contenu et Commentaires uniquement* — les blocs
   « Subdivisions » sont à écarter : redondants avec le plan, et c'est là que se
   concentrent les nombres, donc le risque OCR.

Mécanisme éprouvé : le patron de [guide.ts](../server/ai/guide.ts) — découpage,
score lexical déterministe, aucun appel d'API, rien dans le prompt système.

Réserves à porter dans le prompt : l'OCR est fautif (« Foumisseurs », « cffets »)
— citation utile, copie littérale à proscrire ; et interdiction de répondre sur
la fiscalité ivoirienne à partir d'un texte OHADA.

---

## 3. Dettes repérées en chemin

### 3.1 L'alerte « brouillons à valider » pointe au mauvais endroit

Le tableau de bord renvoie vers l'onglet **Saisie**, où rien ne les affiche. Les
brouillons vivent dans **Révision**. Une ligne à changer.

### 3.2 Un diagnostic mal posé dans la veille

« Masse salariale brute vs compte 661 » avec bulletins à **0** n'est pas un
écart : c'est « aucun bulletin n'a été saisi ». Le libellé n'est pas seulement
technique, le diagnostic est faux. À corriger dans le module de cohérence, pas
dans le mail.

### 3.3 Registre de la veille adapté au destinataire

Nova est vendue aux cabinets **et** aux PME. Le même mail part à un comptable et
à un dirigeant. Lexa adapte déjà son registre à son interlocuteur dans le chat ;
le mail devrait faire pareil — Nova connaît le rôle du destinataire. Adapter, pas
niveler : « compte 661 » a du sens pour un comptable.

### 3.4 Les quinze écritures d'IKAFFANAN

Toujours rattachées à l'exercice 2025 alors qu'elles sont datées de juillet 2026.
Le diagnostic les nomme (journaux et origines), la préparation du redressement
existe. Reste à les traiter — c'est une décision comptable, pas une correction
technique : réaffecter change le résultat de deux exercices.

### 3.5 Configuration d'IKAFFANAN

Sections analytiques par produit, chantiers de production interne, capitalisation
de fin d'exercice. Ne peut pas se faire sans accès à la base de production, et ne
doit pas se faire sans décision sur la quote-part de salaire par produit — c'est
elle qui porte l'essentiel du montant capitalisable, et elle doit être
justifiable.

### 3.6 Mail d'accueil à l'inscription

Un email de bienvenue automatique à chaque nouveau cabinet ou PME. Repéré de
longue date, jamais urgent.

### 3.7 Matrice rôle × action agentique

Quels profils peuvent déclencher quelles actions de Lexa. Le gating par palier
(`readonly` / `assist` / `assist_plus`) existe ; la matrice par rôle
d'utilisateur, non.

---

## 4. Écarté volontairement — pour ne pas y revenir

- **Module d'actifs logiciels** avec suivi de versions et registre de propriété
  intellectuelle. C'est du suivi produit, pas de la comptabilité. Le besoin réel
  est couvert par « rentabilité par activité », qui parle à tous les clients de
  Nova quand « actifs logiciels » n'en concerne aucun.
- **Redevances de filiale sur la propriété intellectuelle.** Du prix de
  transfert : se documente et s'assume devant l'administration, ne se code pas à
  la légère.
- **Prose de la veille rédigée par un modèle.** Le digest est déterministe : coût
  nul par client et par jour, et rien qui puisse mentir. À trois mille clients
  quotidiens, la prose générée devient une ligne de charges — et un risque
  d'erreur chaque matin chez chacun.
- **Conseils à conséquence sur un tiers** dans un mail automatique (« décaler le
  paiement fournisseur X »). Recommander une action *dans l'outil* est légitime ;
  conseiller une décision de gestion qui engage un tiers ne l'est pas.
- **Le tableau de correspondance postes/comptes par re-OCR.** Tenté puis écarté :
  confronté à l'ouvrage, le modèle décalait des postes, fusionnait les colonnes
  brut et amortissements, et fabriquait une section entière absente de la page.
  Ni la validation des codes contre le plan ni le vote sur cinq passes ne
  détectaient ces erreurs — elles sont systématiques, pas aléatoires.
