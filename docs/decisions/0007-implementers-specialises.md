# 0007 — Implementers spécialisés et agent de documentation

Date : 2026-10-18 · Statut : acceptée

## Contexte

Un seul `implementer` généraliste réalise toutes les tâches. Son prompt ne peut pas
porter à la fois ce qu'un développeur back-end vérifie (contrats d'API, validation à la
frontière, transactions, injection, autorisation, N+1) et ce qu'un développeur
front-end vérifie (états de chargement, d'erreur et de vide, accessibilité au clavier,
design system, i18n) sans dépasser 100 lignes. Il ne connaît pas non plus les
conventions du projet au-delà de ce qu'il relit à chaque tâche. La documentation (README,
CHANGELOG, ADR) est oubliée ou faite en passant par l'implementer.

L'ADR 0001 prévoyait des spécialisations « si un run réel le justifie ». Aucun run réel
ne l'a encore montré : c'est une décision de l'utilisateur, à confirmer avec le banc
d'essai.

## Décision

- **Trois agents développeurs de plus**, sans retirer `implementer` :
  `implementer-backend`, `implementer-frontend` (Sonnet, effort high, mêmes outils et
  mêmes droits) et `documentation` (Sonnet, effort medium, n'écrit que de la
  documentation).
- **Base commune une seule fois** : la procédure des développeurs (avant de modifier,
  tests d'abord, questions, mode correction, interdits, livrable) quitte le corps
  d'`implementer` pour la skill `team-implementer`, préchargée par les trois
  implementers. Chaque corps d'agent ne garde que son rôle et son domaine. Même
  principe que `team-rules`.
- **Conventions propres au projet** dans deux skills, `conventions-backend` et
  `conventions-frontend`, préchargées par le spécialiste correspondant. Elles
  appartiennent au projet (`PROJECT_OWNED` d'`install.mjs`) : créées vides à
  l'installation, rédigées par `/team-init` en lisant le code et validées par
  l'utilisateur, jamais remplacées ni supprimées par une mise à jour. Le template
  reste générique ; ce qui dépend du projet vit dans le projet.
- **`implementer` reste l'agent par défaut** : tâches mixtes front et back, projets
  sans séparation (bibliothèque, CLI, scripts), outillage, doute. Un projet qui
  désactive les spécialistes retrouve exactement le fonctionnement 0.4. Les tâches
  `CI<n>` et `PR<k>` créées par les scripts lui reviennent.
- **Routage par le planner, vérifié par un script** : le planner remplit `agent` dans
  le bloc des tâches selon une règle écrite dans `templates/plan.md` (tous les fichiers
  côté back, côté front, documentation seule, sinon `implementer`) ; `check-plan`
  refuse un agent inconnu ou désactivé dans `team.json`, et l'empreinte du plan couvre
  l'agent. L'orchestrateur lance `task.agent` ; escalade, consultation et redécoupage
  valent pour tous.
- **Mêmes garde-fous pour tous les développeurs** : `guard-files` leur refuse
  `.claude/` et `.agent-runs/` ; le livrable suit le schéma `implementer` (seul le nom
  d'agent change), validé par `check-deliverable` et mesuré par `record-metrics`. La
  liste des développeurs est définie une fois (`DEVELOPERS`, `deliverable.mjs`) ;
  `guard-files` en garde une copie locale pour ne dépendre que de `lib.mjs`, et un test
  vérifie qu'elles concordent.

## Pourquoi le planner n'est pas séparé maintenant

Séparer PO et architecte doublerait les appels Opus du chemin critique et ajouterait
une passation (spécification → plan) dont la perte d'information n'a pas été observée.
Le routage ajouté ici est une ligne du plan, pas un nouveau métier. On reconsidère
quand un run réel montre une spécification ou un plan faible par manque de spécialité.

## Conséquences

- Plus d'agents à maintenir ; la procédure commune limite la duplication.
- La qualité des spécialistes dépend des skills de conventions : vides, ils se
  rabattent sur la lecture du code voisin, comme `implementer`.
- Le routage repose sur le jugement du planner pour dire « back » ou « front » ; seul
  l'agent (connu, activé) est vérifié par script, pas la cohérence avec les fichiers.
- Non éprouvé sur un run réel : un scénario du banc devra comparer un run avec et
  sans spécialistes.

## Alternatives écartées

- Remplacer `implementer` par les spécialistes : les tâches mixtes et les projets sans
  séparation n'auraient plus d'agent naturel.
- Conventions dans le corps des agents : écrasées à chaque mise à jour, ou en conflit.
- Conventions dans `CLAUDE.md` : chargé par tous les agents, y compris ceux qui n'en
  ont pas besoin, et partagé avec l'usage hors équipe.
- Routage par l'orchestrateur au lancement : décision prise trop tard pour être relue à
  la porte 1 et vérifiée par `check-plan`.
