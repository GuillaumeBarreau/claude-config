# 0008 — Agent expert pour la logique complexe

Date : 2026-10-18 · Statut : acceptée

## Contexte

Certaines tâches résistent aux développeurs Sonnet, et même à l'escalade sur Opus :
algorithmes, concurrence, machines à états, calculs de précision, bugs dont la cause
est inconnue. Le redécoupage n'aide pas quand la difficulté est dans la logique
elle-même, pas dans la taille de la tâche.

## Décision

- Un agent `expert` sur le modèle le plus capable (`fable`, effort `max`), développeur à
  part entière : procédure commune `team-implementer`, même livrable, mêmes
  garde-fous (`guard-files`, `check-deliverable`), même vérification par `check-plan`.
- Deux usages : le planner lui confie une tâche dont la difficulté est logique
  (routage de `templates/plan.md`) ; et il reprend une tâche en échec après l'escalade
  sur `escalationModel`, avant le redécoupage.
- Sa méthode est explicite : reformuler, écrire les invariants, énumérer les cas
  limites, reproduire un bug avant de le corriger, comparer deux approches, prouver
  chaque invariant par un test.

## Conséquences

- C'est l'agent le plus coûteux : le routage le réserve aux difficultés logiques,
  jamais au volume. Il se désactive dans `team.json` (`agents.expert: false`) ; la
  correction passe alors directement au redécoupage.
- Avec `maxAttempts: 2` (défaut), une tâche en échec voit au plus : correction sur
  Opus, puis expert, puis redécoupage.
- À mesurer sur le banc : taux de réussite des tâches reprises par l'expert et
  consommation.
