# 0004 — Vérifications déterministes du plan, du périmètre et de la reprise

Date : 2026-10-18 · Statut : acceptée

## Contexte

En 0.2, trois contrôles reposaient sur le jugement de l'orchestrateur :
- la **revue du plan** avant la porte 1 (AC couverts, fichiers existants, zones
  sensibles marquées `requiresHuman`) : une liste à cocher dans `workflow.md` ;
- le **périmètre d'une tâche** avant son commit (« fichiers touchés comparés au
  plan ») : une consigne, sans trace dans `state.json` ;
- la **reprise d'un run** (`/team reprendre <id>`) depuis une nouvelle session : le
  `sessionId` restait celui de la session d'origine, et le hook `keep-running`, qui ne
  suit que les runs de sa session, ne relançait plus rien.

Par ailleurs, `keep-running` laissait s'arrêter dès la deuxième relance
(`stop_hook_active`), même quand le run avançait : un run long s'interrompait au
milieu sans raison.

## Décision

- **`schemaVersion: 2`** dans `state.json`. Les nouvelles règles de `check-state` ne
  s'appliquent qu'à partir de cette version : un run 0.2 (sans `schemaVersion`) reste
  valide et se termine avec les règles d'origine.
- **`check-plan.mjs`** croise `spec.md`, le dernier bloc JSON de `plan.md` et les
  tâches de `state.json`. `--record` écrit `planCheck` avec une **empreinte**
  (`planDigest` : sha256 des champs qui fixent le périmètre des tâches du plan).
  `check-state` (R1) exige un `planCheck` réussi **et à jour** pour toute porte plan
  validée : modifier `files` après coup invalide l'état.
- **`check-scope.mjs`** lit `git status` (indexé, non indexé, non suivi) et compare au
  `files ∪ newFiles` de la tâche. Résultat dans `task.scope` ; `check-state` (R2)
  exige ce constat pour une tâche `done`, une justification pour un écart et l'accord
  de l'utilisateur (`approvedBy: "user"`) pour un fichier sensible. Un test non prévu
  est toléré, mais listé. En piste quick, `state.scope` ne doit contenir aucun fichier
  sensible (R3).
- **`sensitive.mjs`** : une seule définition des zones sensibles (dépendances,
  migrations, CI, authentification et permissions, secrets, `.claude/`), utilisée par
  `check-plan` et `check-scope`. `team.json` → `sensitivePaths` ajoute des motifs, n'en
  retire jamais.
- **`claim-run.mjs`**, appelé par la skill avant que le modèle lise la demande,
  rattache un run repris à la nouvelle session (`run_resumed` dans le journal).
- **`keep-running`** relance tant que `state.json` change entre deux arrêts (empreinte
  mémorisée dans `.agent-runs/<id>/.keep-running.json`) et laisse s'arrêter après
  une relance sans progrès. `awaiting_ci` devient un statut actif.
- Le schéma 2 réserve aussi les champs des autres lots (CI, PR, commentaires,
  redécoupage, consultations) pour qu'un seul `check-state` les valide (R4, R5).

## Alternatives écartées

- Faire vérifier le plan par un agent relecteur : coûteux et non déterministe pour
  des règles qui se calculent.
- Un hook PreToolUse sur `git commit` pour imposer `check-scope` : la règle R2 sur
  `done` suffit, sans ajouter de motif fragile à `guard-bash`.
- Compter un nombre maximal de relances dans `keep-running` : borne arbitraire ; le
  progrès de `state.json` dit directement si le run avance.

## Conséquences

- L'orchestrateur lance `check-plan --record` avant la porte 1 et `check-scope --task`
  avant chaque commit ; sans eux, `check-state` refuse l'état (hook `check-run-state`).
- Un redécoupage ou une modification du plan après validation impose un nouveau
  `check-plan --record`.
- `check-scope` suppose un arbre de travail propre au début de la tâche (déjà exigé
  par le workflow) : sinon les changements de l'utilisateur apparaissent hors plan.
- Une boucle reste possible si chaque relance modifie `state.json` sans faire avancer
  le run (par exemple un journal réécrit à chaque tour) : à surveiller sur des runs
  réels.
