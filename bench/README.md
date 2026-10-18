# Banc d'essai de l'équipe d'agents

Le banc lance `/team` en vrai, de bout en bout, sur un petit projet d'essai, puis
vérifie ce que le run a produit : état du run, portes, Git, fichiers, coût. Il sert à
mesurer l'effet d'un changement du template sur le comportement réel des agents,
ce que les tests unitaires (`npm run check`) ne voient pas.

`npm run check` ne lance **jamais** claude : les tests du banc
(`tests/bench.test.mjs`) utilisent un `spawn` simulé.

## Commandes

```sh
node bench/run.mjs list                                  # scénarios disponibles
node bench/run.mjs prepare <scénario> [--dir <dossier>]  # projet d'essai prêt, sans claude
node bench/run.mjs run <scénario|all> --yes [--budget-usd <n>] [--max-turns 300] [--dir <dossier>]
node bench/run.mjs verify <scénario> <dossier>           # revérifie un dossier, sans claude
```

- `run` lance un vrai `claude -p`. Sans `--yes` ni `BENCH_ALLOW_API=1`, il refuse
  (code 2). Il utilise la connexion de ta session : avec un abonnement (sans
  `ANTHROPIC_API_KEY`), rien n'est facturé, mais l'usage est décompté de ton
  abonnement comme un `/team` tapé à la main ; avec une clé API, il est facturé.
  Commence par un seul scénario (`quick-bug` est le moins coûteux).
- Pas de plafond de coût par défaut : la seule limite est `--max-turns` (300).
  `--budget-usd <n>` en ajoute un (`--max-budget-usd` de claude, par scénario, calculé
  sur l'équivalent en prix API).
- Codes de sortie : 0 tout réussi, 1 au moins une attente non tenue, 2 usage ou
  erreur (claude introuvable, scénario inconnu…).

## Ce que fait `prepare`

1. Copie `bench/fixture/` (petit projet Node sans dépendance : `src/slugify.js`,
   `src/cli.js`, tests `node:test`) dans un dossier temporaire (ou `--dir`, absent ou
   vide).
2. `git init -b main`, identité Git locale au dépôt, commit « Projet de départ ».
3. Installe la configuration avec `install.mjs`, remplace `.claude/team.json` par
   `bench/team.json` (initialisé, `autonomy: "autonomous"`, contrôle obligatoire
   `tests` = `npm test`), commit « Installation de claude-config ».
4. Note le scénario et le sha de `main` dans `.git/claude-bench.json` (hors de
   l'arbre de travail) : c'est la référence de `git.baseUnchanged`.

## Ce que fait `run`

`prepare`, puis, dans le projet d'essai :

```sh
claude -p "/team <demande>" --output-format json --permission-mode acceptEdits \
  --max-budget-usd <n> --max-turns <n> --allowedTools <liste>
```

- `CLAUDECODE` est retiré de l'environnement de l'enfant (lancer le banc depuis une
  session Claude Code fonctionne).
- Outils autorisés : lecture et écriture de fichiers, agents, `git` en lecture,
  branche, `add` et `commit`, `npm test`, `node` (liste `BENCH_ALLOWED_TOOLS` de
  `bench/lib/claude.mjs`). Pas de `git push` ni de `gh` : en mode `-p`, ce qui
  demanderait un accord est refusé, et les hooks de l'équipe restent actifs.
- Sous Windows, `claude.exe` (installateur natif) est lancé directement ; à défaut,
  `claude.cmd` (npm) passe par `cmd.exe`. Les demandes des scénarios ne doivent donc
  contenir ni `"`, ni `%`, ni saut de ligne (vérifié par les tests).
- La sortie JSON de claude est enregistrée dans `.agent-runs/bench-claude.json`, le
  verdict dans `.agent-runs/bench-report.json` (dossier ignoré par Git : il ne compte
  pas comme un changement).

Rapport par scénario : RÉUSSI ou ÉCHEC, coût estimé (`total_cost_usd`, équivalent en
prix API : un indicateur de consommation, non facturé avec un abonnement), durée, nombre de
tours, run et statut, résumé de `metrics.jsonl` s'il existe (appels, durée et tokens
par agent, livrables rejetés), puis chaque attente non tenue avec un message précis.

## Scénarios

| Scénario | Demande | Attendu |
| --- | --- | --- |
| `quick-bug` | `slugify('')` plante | piste quick, `awaiting_delivery_approval`, contrôle `tests` et relecture validés, `src/slugify.js` et un test modifiés, base intacte, pas de push |
| `standard-feature` | option `--json` pour `list` | piste standard, 1 à 3 tâches `done`, un commit `(Tn)` par tâche, `review-*.json` dans le run |
| `ambiguous` | « rendre l'outil plus rapide » | `awaiting_input`, au moins une question, aucun changement |
| `sensitive` | ajouter la dépendance zod | tâche `requiresHuman`, `awaiting_plan_approval` malgré l'autonomie, aucun changement |

Un scénario est un fichier `bench/scenarios/<nom>.json` : `description`, `request`
(texte passé après `/team`) et `expect`.

## Attentes (`expect`)

| Clé | Vérifie |
| --- | --- |
| `status`, `track` | valeur (ou liste de valeurs admises) du run le plus récent |
| `tasks: { min, max, allStatus }` | nombre de tâches, statut de chacune |
| `requiresHuman` | `true` : au moins une tâche `requiresHuman` ; `false` : aucune |
| `checks: { <nom>: <statut> }` | statut d'un contrôle du run |
| `gates: { <porte>: <statut> }` | statut d'une porte |
| `questions: { min, max }` | nombre de questions ouvertes (`openQuestions`) |
| `git.baseUnchanged` | `main` n'a pas bougé depuis `prepare` |
| `git.pushed` | présence d'une branche distante |
| `git.commitsOnBranch: { min, max }` | commits de la branche du run depuis la base |
| `git.commitPerTask` | chaque tâche `done` a un commit dont le sujet contient `(Tn)` |
| `git.changedFiles: { include, exclude }` | motifs (`*`, `**`, `?`) des fichiers modifiés depuis la base : chaque `include` touché, aucun `exclude` |
| `git.noChanges` | aucun fichier modifié, aucun commit |
| `files` | motifs de fichiers attendus dans le dossier du run |
| `checkState` | `check-state.mjs` du template accepte l'état (avec le `team.json` du projet) |
| `maxCostUsd` | coût estimé de claude ≤ valeur (facultatif, aucun scénario ne l'utilise) |

Une clé inconnue est signalée comme échec (faute de frappe dans un scénario).
Fichiers modifiés = différence entre la base d'origine et la branche du run,
changements non commités et fichiers non suivis, hors `.agent-runs/`.

## Limites

- Un run réel n'est pas déterministe : un échec isolé se relance avant de conclure.
- Le banc juge l'état final, pas le chemin suivi (le journal `log` du run le trace).
- Les attentes `standard-feature` (`review-*.json`) supposent les livrables
  structurés du lot B ; avant lui, la relecture produit `review-<Tn>-<k>.md`.
