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
| Porte 1            | utilisateur (orchestrateur en autonomie) | Résumé du plan | `gates.plan = passed`      | « Oui » explicite, ou conditions d'autonomie     | Modifications → plan                     | Exécution          |
| Exécution          | `implementer`        | Une tâche `ready`, run         | Changements non commités     | Livrable `ready` avec preuves                    | `blocked` / `needs_input` → run en attente | Contrôles        |
| Contrôles (porte 2)| `run-checks.mjs`     | `checks` de `team.json`        | Statuts, `checks/*.log`      | Tous les `required` à `passed`                   | `failed` → correction                    | Relecture          |
| Relecture (porte 3)| `code-reviewer`      | Diff de la tâche, run          | `review-<Tn>-<k>.md`         | Verdict `approve`, AC de la tâche couverts       | `changes_requested` → correction         | Commit             |
| Correction         | `implementer`        | Constats, journaux en échec    | Changements complétés        | Retour aux contrôles                             | > `maxAttempts` → tâche `failed`, run `blocked` | Contrôles   |
| Commit             | orchestrateur        | Tâche approuvée                | Un commit par tâche          | Tâche `done`                                     | —                                        | Tâche suivante     |
| Livraison (porte 4)| orchestrateur + user | Branche, `pr.md` conforme (`check-pr`) | Push et PR brouillon **si accord** | Accord explicite pour cette action | Refus → reste local                 | Synthèse           |

## Revue du plan (par l'orchestrateur, avant la porte 1)

- [ ] Chaque `AC` est couvert par au moins une tâche.
- [ ] Chaque tâche a des fichiers probables, des tests attendus et des dépendances qui
      existent ; pas de cycle.
- [ ] Les fichiers cités existent (vérifie avec Glob) ou sont explicitement nouveaux.
- [ ] Toute modification de dépendance, migration ou zone sensible est marquée
      `requiresHuman: true` et apparaît dans les risques.
- [ ] Le découpage est proportionné : une petite demande tient en une tâche.

## Exécution (pistes standard et full)

**Préparation**
1. `team.json` initialisé avec au moins un contrôle obligatoire ; sinon `blocked`
   (« lancer /team-init »).
2. `git status --porcelain` vide (hors `.agent-runs/`). Sinon demande à l'utilisateur
   de ranger ses changements : on ne les mélange jamais au run.
3. `git switch -c <branchPrefix><id> <baseBranch>`, puis `branch` et statut
   `executing` dans `state.json`.

**Boucle, une tâche à la fois** : la prochaine tâche `ready` dont toutes les
dépendances sont `done`.
1. Tâche `in_progress`. Lance `implementer` avec le chemin du run, l'id de la tâche,
   la branche attendue et, en correction, les constats (`review-*.md`) ou les journaux
   (`checks/*.log`) à traiter.
2. Vérifie le livrable : statut, `git status` (des fichiers ont changé, toujours sur
   la branche du run), fichiers touchés comparés au plan. `needs_input` ou `blocked`
   → run `awaiting_input` ou `blocked`, la main revient à l'utilisateur.
3. Statut `checking` : `node .claude/skills/team/scripts/run-checks.mjs
   .agent-runs/<id> --task <Tn>`. Échec → `attempts` + 1, correction (étape 1).
4. Statut `reviewing`, tâche `in_review` : `code-reviewer` avec le chemin du run et
   l'id de la tâche (il relit `git diff`). Enregistre `review-<Tn>-<k>.md` et le
   verdict dans `validation.review`. `changes_requested` → `attempts` + 1, correction.
5. `approve` → `git add -A` puis un commit `<convention> <titre> (<Tn>)` sur la branche
   du run ; tâche `done`, sha du commit dans `validation.evidence`, statut `executing`.
6. `attempts` > `maxAttempts` → tâche `failed`, run `blocked` avec la raison et les
   derniers constats.

**Fin**
1. `run-checks.mjs .agent-runs/<id>` sans `--task`, sur la branche complète.
2. Porte 3 `passed` (`by: "orchestrator"`) : toutes les tâches `done` et approuvées.
3. `pr.md` selon [les conventions de PR](pr-conventions.md), vérifié par
   `check-pr.mjs .agent-runs/<id>`, statut `awaiting_delivery_approval`, porte 4.

Ne t'arrête pas entre deux étapes pour faire un point : le hook `keep-running` te
relance tant que le run est `executing`, `checking` ou `reviewing`.

## Autonomie

| `autonomy` (team.json) | Porte 1                                                         | Porte 4     |
| ---------------------- | --------------------------------------------------------------- | ----------- |
| `supervised` (défaut)  | Utilisateur                                                     | Utilisateur |
| `autonomous`           | Orchestrateur si piste ≠ full, aucune tâche `requiresHuman` et aucune question ouverte ; sinon utilisateur | Utilisateur |

Dans les deux cas, l'exécution enchaîne toutes les tâches sans interruption. Push, PR
et actions destructives restent soumis à l'accord de l'utilisateur.

## Garde-fous (hooks déclarés dans `.claude/settings.json`)

| Hook              | Quand                            | Effet |
| ----------------- | -------------------------------- | ----- |
| `guard-bash`      | Avant Bash / PowerShell          | **Refuse** commit ou push sur la branche de base, fusion de PR (`gh pr merge`), `--no-verify`, lecture de `.env`, `rm -rf` massif. **Demande l'accord** pour push, PR, publication, tag, `reset --hard`, `clean -f`, réécriture d'historique, ajout de dépendance |
| `guard-files`     | Avant Read / Edit / Write / Grep | **Refuse** les fichiers de secrets, et toute écriture de `implementer` dans `.claude/` ou `.agent-runs/`. **Demande l'accord** pour modifier les réglages et les hooks de l'équipe |
| `check-run-state` | Après Edit / Write               | Relance `check-state` sur chaque `state.json` écrit ; une erreur revient au modèle |
| `keep-running`    | Stop                             | Empêche de s'arrêter au milieu d'une exécution (une relance par arrêt) |

Ce sont des filets de sécurité, pas un bac à sable : les règles de `team-rules`
restent la référence.

## Piste quick (exécutée par l'orchestrateur)

1. Contrôles connus (`team.json` initialisé), sinon pas de piste quick.
2. Changements de l'utilisateur présents dans les fichiers à modifier → demande avant.
   Arbre de travail non propre → demande s'il faut travailler sur la branche courante
   sans commit, ou attendre qu'il range ses changements.
3. Sinon : crée la branche `<branchPrefix><id>` depuis la branche courante, fais le
   changement, lance `run-checks.mjs .agent-runs/<id>`, puis `code-reviewer` avec le
   chemin du run.
4. Constat critique ou majeur → corrige ; au plus `maxAttempts` tours.
5. Commit sur la branche dédiée, `pr.md` selon [les conventions de PR](pr-conventions.md)
   et `check-pr.mjs`, puis porte 4 : push et PR seulement après un accord explicite.

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
  une dérogation a une justification dans `notes`. Exception : porte plan par
  l'orchestrateur si `autonomy` vaut `autonomous`, hors piste full, sans tâche
  `requiresHuman` ;
- porte contrôles `passed` : posée par `run-checks` (`by: "run-checks"`) ;
- `executing`, `checking`, `reviewing` : une branche `branch` distincte de la branche
  de base ;
- porte relecture `passed` (hors quick) : toutes les tâches `done` ;
- une tâche au-delà de `limits.maxAttempts` tentatives est `blocked` ou `failed` ;
- au-delà de `awaiting_plan_approval` (hors piste quick) : porte plan validée, au
  moins une tâche, aucune tâche `draft` ;
- chaque contrôle obligatoire de `team.json` figure dans `checks` ; porte contrôles
  `passed` seulement si le run a des contrôles et que les obligatoires sont `passed`
  ou `n/a` ;
- `awaiting_delivery_approval`, `done` et porte livraison `passed` : portes contrôles
  et relecture validées ; `done` (hors quick) : toutes les tâches `done` ;
- une tâche `done` a ses contrôles à `passed` ou `n/a` et une relecture `approve` ;
- `blocked` a une raison, `awaiting_input` au moins une question ;
- les dépendances de tâches existent et ne forment pas de cycle.

Le script juge un état, pas son historique : un changement de piste se trace dans
`log`.

## Limites

- `maxClarificationRounds` (défaut 2) tours de questions, puis `blocked` ou
  poursuite avec des hypothèses explicites validées par l'utilisateur.
- `maxAttempts` (défaut 2) tours de correction par tâche, puis tâche `failed` et run
  `blocked`.
- Toujours une intervention humaine pour : action destructive, push, PR, fusion,
  dépendance, migration, secret, permission supplémentaire.
