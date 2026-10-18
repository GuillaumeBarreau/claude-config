# Changelog

## Non publié

Modifié :
- Banc d'essai : plus de plafond de coût par défaut (seule limite : `--max-turns`) ;
  `--budget-usd` le réactive. Le coût affiché est une estimation, non facturée avec un
  abonnement ; les scénarios n'ont plus d'attente `maxCostUsd`.

## 0.3.0 — 2026-10-18 — Agents autonomes les uns avec les autres

Planifié par un agent, implémenté en 5 lots parallèles (worktrees), intégré et relu.

Ajouté :
- **Vérifications déterministes** (ADR 0004) : `check-plan` (critères couverts,
  recopie fidèle, fichiers, dépendances, zones sensibles ⇒ `requiresHuman`, écrit
  `planCheck`), `check-scope` (fichiers réellement modifiés comparés au plan),
  `sensitive` (zones sensibles par chemin, motifs ajoutables via `sensitivePaths`),
  `claim-run` (rattache un run repris à la nouvelle session).
- **Schéma 2 de `state.json`** : `planCheck`, `scope`, `ci`, `pr`, `prComments`,
  origine des tâches (`plan`, `split`, `ci`, `pr-review`), statut `awaiting_ci`. Les
  runs 0.2 restent valides.
- **Livrables structurés** (ADR 0003) : chaque agent termine par un bloc JSON
  (`deliverables.md`) vérifié par le hook SubagentStop `check-deliverable`, qui
  renvoie l'agent au travail s'il est invalide et écrit `review-<Tn>-<k>.json`, lu tel
  quel par l'implementer.
- **Mesures** : hook `record-metrics` (`metrics.jsonl`) et `metrics.mjs`.
- **Agents qui se consultent** : planner en modes `consult` (question technique de
  l'implementer, sans solliciter l'utilisateur) et `split` (redécoupage d'une tâche en
  échec) ; escalade de l'implementer sur `escalationModel` à la correction.
- **Après le push** (ADR 0005) : `ci-wait` (CI rouge → tâche `CI<n>` et run rouvert),
  `pr-comments` (commentaires de PR filtrés → tâche `PR<k>`), `/team reprendre <id> --pr`.
- **Leçons et backlog** (ADR 0006) : `lessons.mjs` (leçons filtrées, plafonnées, dans
  `.agent-runs/lessons.md`), skill `/team-backlog` et `backlog.mjs` (issues
  `agent-ready` traitées hors session, sans push par défaut), `docs/BACKLOG.md`,
  `plan-waves.mjs` (parallélisme possible, à titre d'information).
- **Banc d'essai** `bench/` : 4 scénarios de bout en bout, vérification
  déterministe, lancement payant protégé par `--yes`, hors CI (`npm run bench`).
- `team.json` : `escalationModel`, `sensitivePaths`, `ci`, `prComments`, `lessons`,
  `backlog`, `parallel` (réservé), validés par `validate.mjs` et proposés par
  `/team-init`.

Modifié :
- `keep-running` relance tant que `state.json` progresse (il ne relançait qu'une fois
  par arrêt, insuffisant en `claude -p`) ; `awaiting_ci` est un statut actif.
- `guard-bash` demande l'accord pour toute écriture sur GitHub (`gh pr comment`,
  `gh issue comment`, `gh run rerun`, `gh api` modifiant…).
- Boucle d'exécution : `check-scope` après l'implementer ; correction escaladée puis
  redécoupage avant blocage.

Corrigé après relecture de l'intégration :
- `backlog.mjs` : la branche à pousser (écrite par le modèle) est validée (préfixe,
  format, existence locale) et poussée avec un refspec explicite — `HEAD:main` ou
  `+main` ne passent plus.
- `check-plan` accepte les dépendances aval reportées sur les tâches d'un
  redécoupage (le run restait coincé) ; `check-scope` ne compte plus les fichiers
  d'une tâche CI/PR comme hors plan.
- `ci-wait` : attente de 90 s par appel (sous le délai d'un appel Bash), état écrit
  avant l'attente, `gh` absent → run `blocked`, reprise après délai dépassé, état
  vérifié avant écriture (sortie 4) ; idem pour `pr-comments`, dont les tâches qui
  citent une zone sensible sont `requiresHuman`.
- `guard-bash` : `gh` en liste blanche de lectures (tout le reste demande l'accord),
  préfixes et chemins normalisés (`gh.exe`, `(gh …)`, `env gh`, `$(…)`), fusion via
  `gh api` refusée.

Pas encore fait :
- Aucun run réel : le banc d'essai est prêt mais n'a pas été lancé (coût API).
- Champs JSON exacts de `gh`, déclenchement de SubagentStop par nom d'agent et
  `tool_response` des appels en arrière-plan : à confirmer sur un vrai run.
- Parallélisme réel des tâches en worktrees : différé (ADR 0006).

## 0.2.1 — 2026-10-18

Ajouté :
- Règle : aucune ligne `Co-Authored-By:` ni mention d'attribution dans les commits et
  les descriptions de PR (`team-rules`, conventions de PR, `CLAUDE.md`).
- `guard-bash` refuse un `git commit` dont le message contient `Co-Authored-By:`.

Corrigé :
- `.gitattributes` impose LF : sous Windows, l'extraction en CRLF faisait échouer
  5 tests (CI windows-latest en échec depuis la 0.2.0).

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
