# Workflow de l'équipe

Référence de l'orchestrateur `/team`. Les valeurs configurables viennent de
`.claude/team.json`.

## Pistes

| Piste        | Quand                                                                                   | Étapes                                                                  |
| ------------ | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **quick**    | Changement évident et local : typo, petit bug dont la cause est connue, ≤ ~3 fichiers, sans zone sensible | Orchestrateur → contrôles → `code-reviewer` → préparation de la livraison |
| **standard** | Cas par défaut : besoin clair, une à quelques tâches                                    | `planner` (`spec+plan`) → porte 1 → exécution → contrôles → relecture → livraison |
| **full**     | Besoin flou, transverse, plusieurs composants, ou zone sensible                          | `planner` (`spec`) → clarification → `planner` (`plan`) → porte 1 → exécution séquentielle |

Zones sensibles (jamais quick) : dépendances, migrations, authentification et
permissions, secrets, CI, API publique, suppression de données.

## Étapes

| Étape              | Responsable          | Entrée                         | Livrable                     | Réussite                                         | Blocage                                  | Suite              |
| ------------------ | -------------------- | ------------------------------ | ---------------------------- | ------------------------------------------------ | ---------------------------------------- | ------------------ |
| Réception          | orchestrateur        | Demande                        | `request.md`, `state.json`   | Run créé, `check-state` OK                       | Demande vide                             | Qualification      |
| Qualification      | orchestrateur        | Demande, `git status`          | Piste annoncée               | Piste choisie et justifiée                       | —                                        | Spec ou quick      |
| Spécification      | `planner`            | Demande, mode                  | `spec.md`                    | AC vérifiables, hors périmètre, hypothèses       | Questions bloquantes → `awaiting_input`  | Plan               |
| Clarification      | orchestrateur + user | Questions du planner           | Réponses dans `state.json`   | Plus de question bloquante                       | > `maxClarificationRounds` → `blocked`   | Spec ou plan       |
| Plan               | `planner`            | Spec validée                   | `plan.md`, tâches            | Revue du plan OK                                 | Livrable incomplet → retour au planner   | Porte 1            |
| Porte 1            | utilisateur          | Résumé du plan                 | `gates.plan = passed`        | « Oui » explicite                                | Modifications → plan                     | Exécution          |
| Exécution          | *à venir (incrément 2)* | Tâches `ready`              | Commits sur branche dédiée   | —                                                | —                                        | Contrôles          |
| Contrôles (porte 2)| orchestrateur        | `checks` de `team.json`        | Statuts dans `state.json`    | Tous les `required` à `passed` ou `n/a`          | `failed` ou `not_run` → correction       | Relecture          |
| Relecture (porte 3)| `code-reviewer`      | Diff, run                      | `review-N.md`                | Verdict `approve`, aucun AC non couvert          | `changes_requested` → correction         | Livraison          |
| Correction         | auteur du changement | Constats, contrôles en échec   | Nouveaux commits             | Retour aux contrôles                             | > `maxAttempts` → `blocked`              | Contrôles          |
| Livraison (porte 4)| orchestrateur + user | Branche, `pr.md`               | Push et PR **si accord**     | Accord explicite pour cette action               | Refus → reste local                      | Synthèse           |

## Revue du plan (par l'orchestrateur, avant la porte 1)

- [ ] Chaque `AC` est couvert par au moins une tâche.
- [ ] Chaque tâche a des fichiers probables, des tests attendus et des dépendances qui
      existent ; pas de cycle.
- [ ] Les fichiers cités existent (vérifie avec Glob) ou sont explicitement nouveaux.
- [ ] Toute modification de dépendance, migration ou zone sensible est marquée
      `requiresHuman: true` et apparaît dans les risques.
- [ ] Le découpage est proportionné : une petite demande tient en une tâche.

## Piste quick (exécutée par l'orchestrateur)

1. Contrôles connus (`team.json` initialisé), sinon pas de piste quick.
2. Changements de l'utilisateur présents dans les fichiers à modifier → demande avant.
   Arbre de travail non propre → demande s'il faut travailler sur la branche courante
   sans commit, ou attendre qu'il range ses changements.
3. Sinon : crée la branche `<branchPrefix><id>` depuis la branche courante, fais le
   changement, lance les contrôles, puis `code-reviewer` avec le chemin du run.
4. Constat critique ou majeur → corrige ; au plus `maxAttempts` tours.
5. Commit sur la branche dédiée, `pr.md` d'après [le modèle](templates/pr.md), puis
   porte 4 : push et PR seulement après un accord explicite.

## Statuts

**Run** (`status`) : `qualifying`, `specifying`, `awaiting_input`, `planning`,
`awaiting_plan_approval`, `ready_for_execution`, `executing`, `checking`,
`reviewing`, `awaiting_delivery_approval`, `done`, `blocked`, `cancelled`.

**Tâche** : `draft`, `ready`, `in_progress`, `blocked`, `in_review`, `done`, `failed`.

**Contrôle** : `not_run`, `passed`, `failed`, `n/a`.

**Porte** : `pending`, `passed`, `failed`, `waived` (seulement sur décision explicite
de l'utilisateur, notée dans `notes`).

Règles vérifiées par `scripts/check-state.mjs` (une porte « validée » = `passed` ou
`waived`) :
- portes plan et livraison, et toute dérogation `waived` : `by: "user"` seulement ;
  une dérogation a une justification dans `notes` ;
- au-delà de `awaiting_plan_approval` (hors piste quick) : porte plan validée, au
  moins une tâche, aucune tâche `draft` ;
- chaque contrôle obligatoire de `team.json` figure dans `checks` ; porte contrôles
  `passed` seulement si le run a des contrôles et que les obligatoires sont `passed`
  ou `n/a` ;
- `awaiting_delivery_approval`, `done` et porte livraison `passed` : portes contrôles
  et relecture validées ; `done` (hors quick) : toutes les tâches `done` ;
- une tâche `done` a ses contrôles à `passed` ou `n/a` ;
- `blocked` a une raison, `awaiting_input` au moins une question ;
- les dépendances de tâches existent et ne forment pas de cycle.

Le script juge un état, pas son historique : un changement de piste se trace dans
`log`.

## Limites

- `maxClarificationRounds` (défaut 2) tours de questions, puis `blocked` ou
  poursuite avec des hypothèses explicites validées par l'utilisateur.
- `maxAttempts` (défaut 2) tours de correction par tâche, puis `blocked`.
- Toujours une intervention humaine pour : action destructive, push, PR, fusion,
  dépendance, migration, secret, permission supplémentaire.
