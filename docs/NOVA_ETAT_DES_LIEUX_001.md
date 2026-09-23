# Nova Comptabilité — état des lieux après les deux audits

**Au 23 septembre 2026.** Document destiné au fondateur. Il consolide deux
examens menés séparément, dit ce qui est corrigé, ce qui ne l'est pas, et
pourquoi.

---

## 1. De quoi parle-t-on

Deux regards différents ont été portés sur Nova, à quelques jours d'intervalle.

**La revue d'architecture (« revue CTO 001 »)** est un examen du moteur, de
l'intérieur : la base de données, les règles comptables, l'isolation entre
cabinets, la chaîne de déploiement. Elle a été conduite en lecture seule, avec
une consigne explicite — chercher où Nova peut casser, pas confirmer qu'il est
bon. Elle a produit **28 constats**, classés P0 (bloquant) à P3 (confort).

**L'audit fonctionnel externe** est un examen du site en service, de
l'extérieur, sans accès au code : un utilisateur qui clique. Il a produit
**12 constats (N01 à N12)**, plus un incident historique (H01).

Les deux se recoupent sur deux points seulement (le justificatif malveillant,
l'exercice de travail de Lexa). Pour le reste ils voient des choses
différentes — c'est normal, et c'est la raison d'avoir fait les deux.

---

## 2. Où nous en sommes

| Gravité | Constats | Fermés | Restants |
|---|---|---|---|
| **P0 — bloquant** | 3 | **3** | 0 |
| **P1 — grave** | 9 (+1 déjà résolu en cours de revue) | **9** | 0 |
| **N — audit externe, P1** | 6 | **6** | 0 |
| P2 — à traiter | 10 (revue) + 5 (audit externe) | 7 | 8 |
| P3 — confort | 6 (revue) + 1 (audit externe) | 1 | 6 |

**Tout ce qui pouvait faire perdre de l'argent, fausser une comptabilité ou
faire fuir des données d'un cabinet vers un autre est fermé, et verrouillé par
un test automatique.** Ce qui reste est réel mais ne met en jeu ni l'exactitude
des comptes, ni l'étanchéité entre clients.

---

## 3. Les trois P0 — ce qui aurait pu arriver

### P0-01 — Un cabinet pouvait voir les soldes d'un autre

Nova cloisonne les données cabinet par cabinet. Ce cloisonnement s'applique aux
**tables**, mais une **vue** — un tableau calculé, ici les soldes de comptes —
s'exécutait avec les droits de son créateur, pas ceux du lecteur. Elle passait
donc au-dessus du cloisonnement.

Concrètement : un comptable du cabinet A interrogeant les soldes voyait aussi
ceux du cabinet B. Reproduit sur une base jetable avant correction.

**Corrigé.** Toutes les vues s'exécutent désormais avec les droits du lecteur.
Un test vérifie qu'aucune vue du schéma n'échappe à la règle — y compris celles
qui seront créées demain.

### P0-02 — Le garde-barrière pouvait être contourné

Deux failles de configuration. D'une part le cloisonnement était *activé* mais
pas *imposé* : le propriétaire des tables le traversait sans le savoir. D'autre
part rien ne vérifiait, au démarrage, avec quel compte Nova se connectait à sa
base. Une erreur de configuration au déploiement — se connecter en
administrateur plutôt qu'en compte applicatif — supprimait silencieusement
toute l'isolation entre cabinets. L'application aurait démarré normalement.

**Corrigé.** Le cloisonnement est imposé sur toutes les tables concernées, le
compte applicatif est privé des droits qui permettaient de le contourner, et
**Nova refuse désormais de démarrer** si le compte de connexion n'est pas le
bon. Six scénarios d'attaque inter-cabinets sont rejoués à chaque test.

### P0-03 — Une écriture validée n'était pas vraiment figée

C'est le plus grave des trois sur le plan comptable. Une écriture validée est
censée être intouchable. En pratique, on ne pouvait pas la *modifier*, mais on
pouvait **lui ajouter des lignes** — y compris une paire équilibrée, qui ne
déclenchait donc aucune alerte d'équilibre.

Autrement dit : le passé comptable était réécrivable sans laisser de trace. Ce
n'est pas une faille de sécurité, c'est une rupture du contrat fondateur du
produit.

**Corrigé.** L'ajout, la modification et la suppression de lignes sur une
écriture validée sont refusés **par la base elle-même** — pas par le code. La
distinction compte : une protection portée par le code disparaît au premier
autre chemin d'écriture (un import, un outil de Lexa, un script de reprise).
Onze contrôles couvrent ce verrou, dont la contre-passation, qui reste le seul
moyen légitime de corriger le passé.

---

## 4. Les P1 — ce qui a été fermé

**Du moteur :**

- **P1-02 — Écriture datée hors de son exercice.** Une écriture du 04/07/2019
  pouvait être rattachée à l'exercice 2026. Elle comptait alors dans la balance
  mais disparaissait de tout état filtré par date — journal, grand livre, FEC.
  Deux lectures du même exercice donnaient deux chiffres. Bornes désormais
  imposées en base, à la validation.
- **P1-03 — Imputation sur le plan comptable d'un autre dossier.** Entre deux
  clients d'un même cabinet, rien ne s'y opposait. Le libellé affiché au grand
  livre aurait été celui du dossier voisin. Refusé en base.
- **P1-06 — La vérification automatique ne vérifiait presque rien.** Le dépôt
  déclarait 18 suites de tests ; le contrôle automatique en lançait **une**.
  Environ 429 contrôles — toute la paie, les états financiers, les notes
  annexes, la sécurité — ne tournaient jamais. Un feu vert ne garantissait rien.
  Les suites sont maintenant **découvertes** automatiquement : en ajouter une
  suffit à la faire tourner. 23 suites au vert aujourd'hui.
- **P1-07 — Le test d'isolation ne testait rien.** Il s'exécutait sans jamais
  comparer de résultat. Réécrit.
- **P1-08 — L'API servait avant et malgré l'échec des migrations.** Si la mise
  à jour de la base échouait, Nova démarrait quand même, sur un schéma
  incomplet. Séquence désormais stricte : migrer → vérifier le schéma →
  vérifier les garde-fous de sécurité → vérifier le compte de connexion → puis
  seulement servir. À la moindre anomalie, Nova ne démarre pas.

**De l'audit externe :**

- **N01 — Le compte de démonstration avait les droits d'éditeur de la
  plateforme**, transverses à tous les cabinets. Droits retirés.
- **N02 — Un relevé Mobile Money sans en-têtes était mal interprété en
  silence** : les colonnes glissaient, les montants aussi. Nova refuse
  désormais un relevé qu'il ne sait pas lire, plutôt que de deviner.
- **N03 — Le contrôle qualité affichait un ancien diagnostic comme valide.**
  Une facture corrigée gardait son verdict périmé. Le diagnostic est maintenant
  périmé automatiquement, et **refait à l'émission** — une facture non conforme
  ne s'émet plus.
- **N05 — Lexa travaillait sur le mauvais exercice.** Elle reprenait le premier
  exercice trouvé, pas celui qui couvre la date du jour. Corrigé, et le
  contexte qu'elle reçoit nomme désormais explicitement l'exercice de travail.
- **N06 — Les écrans ne lisaient pas tous le même exercice.** Les états
  financiers cumulaient silencieusement tous les exercices quand aucun n'était
  demandé ; la synthèse n'en prenait qu'un. Deux écrans, deux chiffres
  d'affaires. Règle unique désormais partagée.
- **N09 / N10 / N11** — perte silencieuse d'une saisie en cours, absence de
  récupération de mot de passe, contrôles sans nom accessible. Traités.
- **H01 — Lexa annonçait des actions qu'elle n'avait pas faites.** Un garde-fou
  détecte maintenant toute annonce de succès non adossée à un outil ayant
  réellement abouti, et préfixe la réponse d'un rectificatif.

**Les deux derniers, fermés aujourd'hui :**

- **P1-04 / N04 — Un justificatif pouvait agir à la place de celui qui
  l'ouvre.** Nova enregistrait le type de fichier annoncé par le poste de
  l'utilisateur sans le vérifier, puis demandait au navigateur de l'afficher
  directement. Une page HTML ou une image SVG déposée en pièce jointe
  s'exécutait donc dans le navigateur du comptable, sur le domaine de Nova,
  avec sa session ouverte. Désormais le type est déduit des premiers octets du
  fichier ; seuls photos et PDF sont acceptés ; les pièces déjà déposées sous
  un type non reconnu sont téléchargées au lieu d'être ouvertes ; et la page
  déclare une politique de contenu qui interdit au navigateur d'exécuter autre
  chose que Nova.
- **P1-05 — Un outil de Lexa écrivait au grand livre en se présentant comme un
  brouillon.** « Réaffecter l'exercice » figurait parmi les outils de
  préparation : ouvert dès le palier « assisté », sans exigence de rôle. Or il
  contre-passe — il pose une écriture validée, donc définitive. Un
  collaborateur sans droits d'administration pouvait faire produire une
  écriture irréversible depuis la conversation, y compris par WhatsApp.
  L'outil exige maintenant le mode « assisté + actions » **et** un profil
  propriétaire ou associé.

---

## 5. Deux recommandations que j'ai retirées après vérification

Je les signale parce qu'elles disent quelque chose sur la méthode.

**P1-01 — « interdire l'imputation sur un compte non mouvementable ».** La
revue recommandait de bloquer en base toute écriture sur un compte marqué
`is_postable = false`. Mise à l'épreuve, la recommandation s'est révélée
fausse : dans le plan SYSCOHADA livré, ce drapeau signifie « ce compte a des
subdivisions », pas « on n'y impute pas ». Les comptes refusés auraient été
411 CLIENTS, 401 FOURNISSEURS, 521 BANQUES, 571 CAISSE, 443 TVA FACTURÉE,
661 RÉMUNÉRATIONS, 245 MATÉRIEL DE TRANSPORT — c'est-à-dire les comptes de
tenue les plus courants, et ceux sur lesquels Nova lui-même écrit. Douze suites
de tests sur vingt-deux tombaient. Une règle qui empêche la facturation
d'écrire au compte client n'est pas un garde-fou, c'est une panne.

L'imputation sur un compte de tête reste un **point de qualité**, signalé par
le contrôle de révision, à arbitrer par le comptable — un cabinet qui tient des
auxiliaires descendra au 4011, une petite entreprise s'arrêtera au 401 et elle
aura raison.

**La trésorerie.** J'avais recommandé d'exclure les comptes de virements
internes (58x) du solde de trésorerie. L'arithmétique m'a démenti : pendant un
virement de caisse à banque, l'argent est *dans* le 585. En l'excluant, le
tableau de bord affichait 1 000 000 au lieu de 3 000 000 — de l'argent
disparaissait le temps du virement. Recommandation abandonnée ; à la place, la
définition de la trésorerie est maintenant **affichée**, et le solde des
virements non soldés est signalé à part.

Dans les deux cas j'ai gardé les tests et changé la recommandation, pas
l'inverse.

---

## 6. Ce qui reste ouvert

Rien de ce qui suit ne fausse une comptabilité ni ne traverse la frontière
entre deux cabinets. Par ordre d'intérêt :

| Réf | Sujet | Ce que ça change |
|---|---|---|
| **P2-01** | Les montants transitent en nombre à virgule flottante | Risque d'arrondi au centime sur de très gros volumes. Non observé à ce jour, mais c'est une dette de fond sur un produit comptable. **Le plus important des restants.** |
| **N07** | « Top clients » classe par solde, pas par nature du tiers | Un fournisseur à qui l'on a versé une avance apparaît parmi les clients. Cosmétique, mais visible sur le tableau de bord. |
| **P2-03** | Les webhooks accusent réception puis traitent en mémoire | Un redémarrage au mauvais moment perd un paiement Mobile Money entrant, sans reprise possible. |
| **P2-04** | Le limiteur de débit est en mémoire | Sans effet réel dès qu'il y aura plus d'une instance en service. |
| **P2-05** | Toutes les erreurs non typées deviennent des « 400 » | Une panne interne s'affiche comme une erreur de saisie. Gêne le diagnostic. |
| **P2-07** | Injection de prompt sur Lexa | La surface est réelle. Le garde-fou de sortie (H01) et le classement des outils par effet réel (P1-05) en couvrent la conséquence la plus grave ; la défense en entrée reste à écrire. |
| **P2-08** | Dépendances vulnérables | À reprendre périodiquement ; le contrôle automatique bloque désormais sur les alertes de niveau élevé. |
| **P2-09** | `api.ts` : 311 routes dans un seul fichier | Dette de structure. Aucun effet visible, mais chaque modification y coûte plus cher. |
| **N08** | Parcours mobile insuffisamment adapté | Confort d'usage. |
| **P3-01 à P3-06**, **N12** | Documentation périmée, journalisation, libellés | Confort. |

---

## 7. Comment ces corrections ont été faites

Une méthode unique, appliquée à chaque constat :

1. **reproduire** le défaut sur une base jetable — si je n'arrive pas à le
   provoquer, je ne le corrige pas ;
2. **corriger**, en base plutôt qu'en code chaque fois que la règle est une
   règle comptable ;
3. **verrouiller** par un test automatique dont je vérifie qu'il **échoue avant
   la correction**. Un test qui passe dans les deux cas ne prouve rien.

Aucune base de production n'a été touchée. Aucune donnée réelle n'est entrée
dans les jeux d'essai.

**État de la vérification automatique aujourd'hui :** 23 suites au vert
(124 secondes), 23 contrôles d'invariants comptables et d'isolation au vert,
construction du site au vert.

---

## 8. Ce que je propose ensuite

Dans cet ordre :

1. **P2-01 — la politique monétaire.** C'est le seul restant qui touche à
   l'exactitude des montants. Il mérite d'être traité avant que les volumes
   n'augmentent, parce que le corriger plus tard supposera de vérifier
   l'existant.
2. **N07 — le classement clients/fournisseurs.** Court, visible, et il entame
   la confiance dans le tableau de bord chaque fois qu'un cabinet le remarque.
3. **P2-03 — la reprise des webhooks.** À faire avant toute montée en charge
   sur le Mobile Money.

Le reste peut suivre le rythme des chantiers produits déjà prévus dans
`docs/RESTE-A-FAIRE.md`.

---

### Documents de référence

- `docs/NOVA_CTO_ARCHITECTURE_REVIEW_001.md` — la revue complète, 28 constats
  avec les preuves
- `docs/NOVA_P0_REMEDIATION_001.md` — le détail des trois P0
- `docs/NOVA_REMEDIATION_PLAN_001.md` — le plan d'origine
- `docs/NOVA_SECURITY_BOUNDARY_MAP_001.md` — la carte des frontières entre
  cabinets
- `docs/NOVA_TEST_COVERAGE_MAP_001.md` — ce qui est couvert par des tests, et
  ce qui ne l'est pas
- `audit-nova/RAPPORT-AUDIT-NOVA.md` — l'audit fonctionnel externe
