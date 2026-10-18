# Changelog

## 0.2.0 — 2026-10-18 — Incréments 2 et 3 : exécution autonome et garde-fous

Ajouté :
- Agent `implementer` (Sonnet) : réalise une tâche (tests d'abord), ou corrige les
  constats et les contrôles en échec ; ne commite pas.
- Boucle d'exécution de `/team` : une tâche à la fois sur la branche
  `<branchPrefix><id>`, `implementer` → `run-checks` → `code-reviewer` → commit de la
  tâche, au plus `maxAttempts` corrections, puis porte 4 avec `pr.md`.
- `run-checks.mjs` : exécute les contrôles de `team.json`, journaux dans
  `.agent-runs/<id>/checks/`, statuts et porte 2 écrits par le script.
- Hooks Node déclarés dans `.claude/settings.json` : `guard-bash` (refuse commit/push
  sur la branche de base, `--no-verify`, secrets, `rm -rf` massif ; demande l'accord
  pour push, PR, publication, actions destructives, dépendances), `guard-files`
  (secrets, écritures de l'implementer dans `.claude/` et `.agent-runs/`, modification
  des garde-fous), `check-run-state` (vérifie chaque `state.json` écrit),
  `keep-running` (pas d'arrêt au milieu d'une exécution).
- `team.json` : `autonomy` (`supervised` par défaut, ou `autonomous` : porte 1 validée
  par l'orchestrateur hors piste full et sans tâche `requiresHuman`).
- `check-state` : porte 2 posée par `run-checks` seulement, tâche `done` relue et
  approuvée, porte 3 seulement quand toutes les tâches sont `done`, limite de
  tentatives, branche de travail obligatoire pendant l'exécution, règles d'autonomie.
- `install.mjs` fusionne `settings.json` (hooks et permissions de l'équipe) au lieu de
  le copier ; le reste du fichier du projet est conservé.
- `validate.mjs` : scripts de hooks introuvables, événements de hooks inconnus, valeur
  de `autonomy`.
- ADR 0002.
- Conventions de PR (`skills/team/pr-conventions.md`) : une PR par run, un commit par
  tâche, titre ≤ 72 caractères au format du projet, sections obligatoires, brouillon
  par défaut, taille surveillée, jamais de fusion par un agent.
- `check-pr.mjs` : vérifie `pr.md` (titre, `titlePattern`, sections, texte du modèle
  non remplacé, statuts des contrôles identiques à `state.json`, critères
  d'acceptation, lien vers le run), avertit au-delà de `maxChangedLines`, écrit
  `pr-body.md` pour `gh pr create --body-file`.
- `team.json` : `pullRequest` (`draft`, `titlePattern`, `maxChangedLines`, `labels`),
  contrôlé par `validate.mjs`.
- Modèle de PR du dépôt (`.github/pull_request_template.md`).

Modifié :
- `guard-bash` refuse `gh pr merge` / `glab mr merge` (auparavant : accord demandé).
- Retrait des références aux projets étudiés (README, ADR, validateur,
  `which-surface`).
- `state.json` : champs `autonomy`, `sessionId`, `limits`.
- `code-reviewer` relit une tâche nommée ; `team-rules` interdit de contourner un refus
  de hook.

Pas encore fait :
- Aucun run réel complet dans un projet : le comportement des agents et de
  `keep-running` sur un run long reste à observer.
- Exécution parallèle en worktrees (voir ADR 0002).

## 0.1.0 — 2026-10-18 — Incrément 1 : socle et planification

Ajouté :
- Règles communes `team-rules` (preuves, périmètre, Git, sécurité, format des
  livrables), préchargées par chaque agent.
- Agent `planner` (PO + architecte, lecture seule) : spécification, plan, tâches.
- Agent `code-reviewer` (relecture + vérification des critères d'acceptation),
  repris de la configuration utilisateur existante.
- Orchestrateur `/team` : pistes quick / standard / full, porte 1 (validation du
  plan), état du run dans `.agent-runs/<id>/`, reprise d'un run.
- `check-state.mjs` : refuse un `state.json` incohérent avec les portes (plan et
  livraison validés par l'utilisateur seulement, contrôles obligatoires de `team.json`
  présents et réussis, ordre des statuts). Il juge un état, pas son historique, et ne
  remplace pas le hook de garde prévu à l'incrément 3.
- `/team-init` : découverte et validation des commandes de contrôle du projet.
- Skill `which-surface` : choisir entre hook, CLAUDE.md, sous-agent, skill ou rien.
- `install.mjs` (manifeste, conflits, `--dry-run`, `--force`), `validate.mjs`, tests.

Pas encore disponible :
- Exécution des tâches par un agent `implementer` en worktree (incrément 2).
- Hook de garde (push vers la branche de base, commandes destructives) et porte de
  livraison outillée (incrément 3).
