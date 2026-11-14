# Changelog

## 0.11.0 — 2026-11-13 — Revue de PR : relecteurs recalibrés

Premier essai réel (une PR de 13 fichiers) : `/team-review` a rendu 1 constat là où une
revue manuelle à trois relecteurs en a rendu 7. Les relecteurs avaient vu une partie des
autres points mais les avaient écartés sur consigne.

Modifié :
- `cc-pr-reviewer-frontend`, `-backend`, `-architecture` : tout constat prouvé est
  remonté, mineur compris (l'utilisateur trie ; `minor` → `COULD`). Supprimé : « ne
  remplis pas avec des remarques mineures ». Nouvelle priorité « Maintenabilité » (règle
  dupliquée, clé ou identifiant construit dynamiquement, attribut de test réutilisé,
  refactor de contrat partagé non annoncé, écart à une convention écrite). `checked` ne
  contient plus de réserves : « hérité », « hors périmètre » deviennent des constats.
- Les mêmes relecteurs sont invités à **exécuter ce qui tranche**, en lecture seule :
  script jetable dans le dossier temporaire du système, comparaison de clés de
  traduction, linter ou contrôle de types ciblés.
- Les quatre agents de revue reçoivent `PowerShell` en plus de `Bash` (Bash peut
  échouer sous Windows, ce qui empêchait toute exécution).
- `pr-fetch.mjs` : le résumé de la CI ne compte qu'une fois chaque contrôle, par sa
  dernière exécution (même workflow et même nom). Un contrôle annulé puis relancé avec
  succès ne fait plus passer la CI en « failed ».
- `findings.mjs` : sans constat à contre-vérifier, `verify-input.json` n'est pas écrit
  (et il est supprimé s'il restait d'un passage précédent).
- `/team-review`, étape 6 : le rapport local est lancé d'office et son URL complète est
  donnée dans la réponse.
- `install.mjs` : rappelle qu'une session déjà ouverte ne charge ni les nouveaux hooks
  ni les nouveaux agents.
- Documentation, ADR et tests : plus aucune référence à un projet cible particulier ;
  les exemples de motifs d'axes et les chemins des fixtures sont neutres (`client/**`,
  `server/**`, `ui/`).

Ajouté :
- Constat de revue de PR : champ facultatif `preexisting` (problème antérieur à la PR,
  dans du code qu'elle touche ou dont elle dépend), incompatible avec `regression: true`,
  conservé dans `review.json` et affiché « préexistant » dans le rapport local.

## 0.10.0 — 2026-11-13 — Agents préfixés cc-

**Changement cassant.** Les douze agents du template sont renommés avec le préfixe
`cc-` (claude-config) : `cc-planner`, `cc-implementer`, `cc-implementer-backend`,
`cc-implementer-frontend`, `cc-documentation`, `cc-expert`, `cc-code-reviewer`,
`cc-analyste`, `cc-pr-reviewer-frontend`, `cc-pr-reviewer-backend`,
`cc-pr-reviewer-architecture`, `cc-pr-verifier`. Un projet qui a son propre
`code-reviewer` (cas réel) n'est plus en conflit à l'installation et n'est plus visé par
le hook `check-deliverable`, qui ne contrôle que nos agents. Les skills ne changent pas
de nom. Le nom préfixé vaut partout : `name:` et fichier, listes de `deliverable.mjs`
et `guard-files.mjs`, matcher `SubagentStop`, clés `agents` de `team.json`, champ
`agent` des livrables et des tâches, descriptions d'appel (`cc-implementer T1 #1`).
ADR 0012.

Mise à jour d'un projet installé : relancer `node install.mjs <projet>` (d'abord avec
`--dry-run`) :
- les anciens fichiers `agents/<nom>.md` intacts sont supprimés (« retiré du
  template ») ; un fichier modifié localement est conservé et signalé ;
- `team.json` : les clés `agents` sans préfixe sont renommées à leur place, valeur
  conservée (message « migré ») — seule écriture jamais faite dans ce fichier par
  l'installeur ; une ancienne clé restante est signalée par `validate.mjs` avec le
  nouveau nom ;
- les runs en cours dans `.agent-runs/` (`agent: "implementer"`…) restent valides :
  `check-plan` et `check-state` lisent un ancien nom comme son équivalent préfixé, et
  l'empreinte du plan ne change pas.

Ajouté :
- `validate.mjs` : un agent géré par claude-config (template, ou présent dans le
  manifeste d'un projet installé) doit porter le préfixe `cc-` ; une ancienne clé
  `agents.<nom>` de `team.json` est signalée avec le nouveau nom. Les agents propres au
  projet ne sont pas concernés.
- `install.mjs` : action « migré » (`migrateTeamAgents`), respectée par `--dry-run`.
- `install.mjs --local` : installation personnelle, invisible pour Git. Réglages dans
  `.claude/settings.local.json` (mêmes règles de fusion), `.gitignore` du projet
  jamais touché (`--ignore-claude` / `--no-ignore-claude` refusés), chaque fichier
  installé — jamais `.claude/` en entier, jamais un fichier préexistant du projet —
  inscrit avec le manifeste, `team.json` s'il a été créé, `.agent-runs/` et
  `.agent-reviews/` dans l'exclusion locale du dépôt (`git rev-parse --git-path
  info/exclude`, worktree compris), dans un bloc entre marqueurs réécrit en entier à
  chaque passage, chemins ancrés à la racine du dépôt. Mode mémorisé dans le manifeste
  (`"mode": "local"`, conservé sans option ; `--no-local` repasse en partagé et retire
  le bloc). Un fichier déjà suivi par Git est signalé (l'exclusion ne le cache pas) ;
  hors dépôt Git, erreur sans rien écrire ; `--dry-run` affiche le bloc et le fichier
  d'exclusion. Commandes `git` via l'exécuteur injectable de `gh.mjs`.
- `deliverable.mjs` : `AGENT_PREFIX`, `DEFAULT_DEVELOPER`, `LEGACY_AGENTS`,
  `canonicalAgent`.
- Revue de PR : **les agents lisent le code au commit de la PR**, plus celui de la
  branche où se trouve l'utilisateur (faux constats « appelant non mis à jour »,
  problèmes manqués dans les fichiers lus dans leur version de base). `pr-fetch.mjs`
  choisit une source par round, enregistrée dans `review.json` (`rounds[k].source =
  { mode, headSha, path }`) et `pr.json`, rappelée aux quatre agents par la skill :
  `working-tree` si `git rev-parse HEAD` est le commit de tête (modifications non
  commitées signalées) ; sinon `git-show` par défaut — `git fetch --no-tags --quiet
  origin +refs/pull/<n>/head:refs/claude-config/pr-<n>` (fork compris, aucune branche
  créée), `git cat-file -e`, lecture des fichiers de la PR par `git show <sha>:<chemin>`
  et `git grep -n … <sha>`, les autres fichiers restant ceux de la branche courante
  (rappelé par `findings.mjs` et dans les limites) ; `worktree` seulement avec
  `--worktree` (`/team-review <n> --worktree`, `pr-fetch.mjs <n> --worktree`,
  `review-batch.mjs --worktree` qui ne le transmet que s'il le reçoit) — `git worktree
  add --detach .agent-reviews/pr-<n>/worktree <sha>`, ancien worktree retiré avant,
  recréé à chaque round, sans `npm install`. Jamais de checkout dans la copie de
  travail. Nouveau script `source.mjs … --remove-worktree` (clôture, `--prepare`), qui
  ne vise qu'un dossier sous `.agent-reviews/` ; `guard-bash` demande un accord pour
  `git worktree remove --force` ailleurs. Section « Lire le code de la PR » dans
  `workflow.md` et `docs/REVIEW.md` ; `argument-hint` de la skill :
  `<numéro de PR> [--worktree] [--prepare] | list | stats`.
- Tests : 34 nouveaux (467 au total) — règle du préfixe (template et projet installé),
  ancienne clé de `team.json`, mise à jour d'un projet installé en 0.9 (simulation
  comprise), `migrateTeamAgents`, anciens noms acceptés par `check-plan` et
  `check-state` ; `--local` (vrai dépôt Git et worktree avec `git status --porcelain`
  vide, `.gitignore` intact, bloc réécrit et reste du fichier conservé, fichier
  d'exclusion donné par git, sous-dossier du dépôt, `settings.local.json`, mode
  mémorisé, refus avec `--ignore-claude` et hors dépôt, `--dry-run`) ; source du round
  (`tests/review-source.test.mjs` : les trois modes avec git simulé, fetch ou cat-file
  en échec, ancien worktree retiré, nouveau round, round à jour revérifié, `source`
  dans `review.json` et `pr.json`, `removeWorktree` limité à `.agent-reviews/`,
  `review-batch --worktree`, `guard-bash` ; et sur un vrai dépôt `git init` avec
  `origin` local : worktree créé au bon commit, retiré, `git worktree list` propre,
  copie de travail principale intacte, `git show` en mode `git-show`).
- `docs/ADD_AGENT.md` : convention du préfixe.

## 0.9.0 — 2026-11-13 — Revue de PR

Ajouté :
- Skill `/team-review` (lancement manuel) : revue d'une PR GitHub. `/team-review <n>`
  relève la PR, lance les relecteurs selon les fichiers touchés, fait contre-vérifier
  les constats graves, fait trier par l'utilisateur, puis publie une seule revue GitHub
  après aperçu et accord. `list` (PR ouvertes et état local), `stats` (justesse des
  agents), `--prepare` (relecture sans triage ni publication). ADR 0011.
- Agents `pr-reviewer-frontend`, `pr-reviewer-backend`, `pr-reviewer-architecture` et
  `pr-verifier` (Opus 5.5, effort medium, lecture seule). Les relecteurs rédigent un
  brouillon de commentaire en français pour chaque constat ; le vérificateur reçoit les
  constats `critical` et `major` sans preuve ni raisonnement et rend `confirmed`,
  `downgraded` ou `rejected` avec le motif. Livrables décrits dans `deliverables.md`
  (sections « Relecteurs de PR » et « pr-verifier ») et validés par `check-deliverable`.
- Scripts Node sans dépendance dans `skills/team-review/scripts/` :
  - `pr-fetch.mjs` : PR, CI, commentaires existants, diff, fichiers par axe ; un round
    par commit de tête ; mode `comments` (PR d'un collègue) ou `fixes` (sa propre PR).
  - `findings.mjs` : fusion et dédoublonnage par empreinte (fichier, extrait normalisé,
    nature), identifiants `R1`…, étiquettes `MUST` / `SHOULD` / `COULD` / `ASK`, ancrage
    sur une ligne du diff ou dans le corps de la revue, verdicts du vérificateur, suivi
    `new` / `persisting` / `fixed` / `unknown` entre rounds.
  - `decisions.mjs` : décision (`ok`, `ko`, `discuss`), note de justesse (`correct`,
    `incorrect`), étiquette, texte du commentaire et note personnelle ; refuse toute
    modification d'un constat publié.
  - `serve.mjs` et `report/index.html` : rapport de triage local sur `127.0.0.1`, jeton
    aléatoire dans l'URL, sans route de publication.
  - `publish.mjs` : `--dry-run` (aperçu), puis une revue `COMMENT` (`--event` pour
    `APPROVE` ou `REQUEST_CHANGES`) avec les seuls constats validés ; refus si la PR a
    bougé depuis le round (sortie 3) ; idempotent. Mode `fixes` : `fixes.md`, aucun
    appel GitHub.
  - `stats.mjs` : précision par agent et `.agent-reviews/calibration.json` (faux
    positifs passés, transmis aux relecteurs suivants).
  - `pr-list.mjs` et `review-batch.mjs` (préparation en lot hors session, simulation
    sans `--yes`).
- Magasin `.agent-reviews/pr-<n>/` (personnel, ignoré par Git).
- `docs/REVIEW.md` : guide d'usage et limites connues.
- Tests : 63 nouveaux (433 au total) — récupération de la PR, fusion et suivi,
  triage, rapport local, publication, agents et livrables, garde-fou, installation et
  validation. `gh` est simulé partout.

Modifié :
- `guard-bash` : demande l'accord pour `publish.mjs` sans `--dry-run` et pour
  `review-batch.mjs --yes`, quel que soit le chemin du script.
- `check-deliverable` : range le livrable d'un agent de revue dans
  `.agent-reviews/<review>/rounds/<round>/deliverables/`.
- `settings.json` : permissions des scripts de lecture et de triage de `team-review`
  (pas `publish.mjs` ni `review-batch.mjs`) ; les quatre agents ajoutés au matcher
  `SubagentStop`.
- `team.json` : les quatre agents dans `agents` ; nouvelle section `review` (`axes`,
  `architectureMinLines`, `maxInlineCould`, `batch.maxPrs`, `event`, `language`).
  `validate.mjs` la contrôle. `event` et `language` sont validés mais sans effet.
- `/team-init` propose `review.axes` d'après la structure du projet.
- `install.mjs` ajoute `.agent-reviews/` au `.gitignore` du projet s'il n'y est pas.

Non éprouvé : rien n'a tourné sur une vraie PR ; réponse de l'API de création de revue
supposée ; page de triage jamais ouverte dans un navigateur ; préparation en lot jamais
lancée en mode non interactif. Prévu, non implémenté : tests de la PR dans le
navigateur. Détail : `docs/REVIEW.md`, « Limites connues ».

## 0.8.0 — 2026-10-24 — Agent analyste, audit proactif et mode QA

Ajouté :
- Agent `analyste` (Opus, lecture seule) : explore proactivement le code pour trouver
  bugs, dette technique, failles de sécurité, améliorations et fonctionnalités
  manquantes. Deux modes (`audit`, `targeted`) et six focus (`security`, `debt`,
  `features`, `performance`, `architecture`, `all`). Chaque constat porte un
  `issueTitle` et un `issueBody` au format issue prête (ADR 0009). Livrable structuré
  validé par `check-deliverable`.
- Skill `/team-audit` : orchestre l'agent `analyste`, présente les constats classés par
  sévérité et type, et crée des issues GitHub (`agent-ready`) avec l'accord de
  l'utilisateur. Script `create-issues.mjs` (Node sans dépendance, appelle `gh issue
  create`).
- Mode QA du `code-reviewer` : activé par `--qa` dans la description. Lance les tests,
  vérifie chaque critère d'acceptation par exécution, teste les cas limites avec des
  commandes concrètes. Chaque constat `confirmed` cite la commande et la sortie.
- Diagrammes ASCII dans le README (workflow principal, interactions entre agents) et
  dans USAGE (cycle d'escalade, cycle audit → issues → team-next).
- ADR 0010 : agent analyste et audit proactif.
- Tests : livrable analyste (modes, focus, summary, findings avec type/issueTitle),
  SubagentStop matcher avec `analyste`, `create-issues.mjs` (formatage pur).

## 0.7.1 — 2026-10-20 — Correctif SubagentHandback et optimisation des runs /team

Corrigé :
- `check-deliverable.mjs` : lorsque `last_assistant_message` est vide à l'arrêt d'un
  sous-agent (cas où Claude Code termine le sous-agent par l'outil interne
  `SubagentHandback`), le hook lit `agent_transcript_path` pour extraire le message de
  `SubagentHandback` (ou le dernier bloc `text` d'assistant). Élimine les faux rejets
  systématiques (`deliverable_rejected`) et enregistre automatiquement
  `deliverables/<NNN>-<agent>.json` et `review-<Tn>-<k>.json`.
- `sensitive.mjs` : seul le dossier `.claude/` à la racine du projet (`dirs[0] ===
  '.claude'`) est classé `team-config`, en cohérence avec `guard-files.mjs` (plus de
  faux positif sur `template/.claude/…` ou `packages/x/.claude/…`).

Modifié (prompts et performance des runs) :
- `team-rules` : impose l'usage des outils dédiés (`Read`, `Grep`, `Glob`, `Edit`,
  `Write`) au lieu de `Bash` pour lire, chercher ou modifier des fichiers, et interdit
  les boucles de test par mutation automatisée et les boucles d'attente (`sleep`).
- `planner` et `templates/plan.md` : réserve `Bash` à l'inspection Git (`git status`,
  `git log`, `git diff`) sans lancer la suite de tests complète pendant la
  planification, et regroupe les changements liés en 1 à 3 tâches cohérentes en piste
  standard (4 ou 5 au plus en piste full).
- `code-reviewer` : dans un run `/team`, réutilise le résultat de la Porte 2
  (`run-checks`) déjà acquis sur l'arbre courant sans relancer toute la suite de tests ;
  les cas limites hors `spec.md` et `plan.md` (sauf vrai bug, régression ou faille de
  sécurité) restent `minor`.
- `expert` : `maxTurns: 80` (au lieu de `150`).
- `team` (`SKILL.md`) : appelle les sous-agents au premier plan (hors parallélisme de
  vague) pour que `record-metrics` et `check-deliverable` reçoivent les mesures
  complètes dès la fin de l'appel.
- `team-implementer` : précise le format `{ file, reason }` de `deviations` et
  l'exécution des tests ciblés d'abord, puis une seule passe finale des contrôles.

## 0.7.0 — 2026-10-18 — Issues prêtes, priorité et dépendances

Ajouté :
- Issue « prête » : `/team-next` et `backlog.mjs` ne prennent qu'une issue dont le corps
  contient trois rubriques en titres Markdown non vides (Objectif, Comportement attendu
  ou critères, Hors périmètre), vérifiées sur le texte retenu (4 000 caractères). Une
  autre est écartée avec « issue non prête : <rubriques manquantes> ». En mode réel
  (`--yes`), `backlog.mjs` lui donne le label `agent-needs-info` à la place de
  `agent-ready`, avec un commentaire qui liste les rubriques manquantes ; sans worktree ni
  `claude`, hors de la limite d'issues du passage (outcome `not_ready` dans le rapport).
- Modèle d'issue `.github/ISSUE_TEMPLATE/agent-ready.md`, proposé par `/team-init`
  (écrit seulement avec accord, jamais écrasé ; `install.mjs` ne le copie pas).
- Priorité : clé `backlog.priorityLabels` (défaut `["P0","P1","P2"]`). Les issues prêtes
  sont prises par priorité, puis par ancienneté ; sans label de priorité, en dernier.
  Même ordre pour `/team-next` et `backlog.mjs`. `validate.mjs` vérifie la clé.
- Dépendances : une ligne « Dépend de #n » écarte l'issue tant que #n est ouverte
  (« dépend de #n (ouverte) ») ou si les issues s'attendent en cycle ; #n fermée, l'issue
  est éligible ; référence illisible ou état inconnu : avertissement (5 par issue, 20 au
  total, `warningsOmitted` dans le rapport et dans `next-issue.mjs --json`). 20 lectures
  `gh api` (GET) au plus par passage.
- `backlog.mjs` vérifie au démarrage, avant tout appel `gh`, que `baseBranch` est un nom
  valide et que `.claude/team.json` est présent et initialisé sur `origin/<base>` ; sinon
  code 2 avec la cause. `git fetch origin <base>` en `--yes` ; pas de fetch en
  `--dry-run` (référence locale).
- ADR 0009 ; `docs/BACKLOG.md` et `docs/USAGE.md` décrivent ces règles.

Modifié :
- **Rupture** : une issue `agent-ready` sans les trois rubriques n'est plus traitée.
  Migration : compléter les issues concernées avec les trois titres (`## Objectif`,
  `## Comportement attendu ou critères`, `## Hors périmètre`), ou adopter le modèle
  d'issue proposé par `/team-init`, puis remettre le label `agent-ready`. Des libellés en
  gras ne suffisent pas : ce sont les titres Markdown qui comptent.
- `/team-next` ne prend plus la plus ancienne issue mais la plus prioritaire, prête et
  débloquée.
- `backlog.mjs` ne suit plus l'ordre par défaut de GitHub (les plus récentes d'abord) : il
  lit les 50 issues les plus anciennes portant le label et les traite par priorité, puis
  par ancienneté.
- Le test CLI de `check-state` ne dépend plus du `.claude/team.json` de la racine du
  dépôt (il tourne dans un dossier sans `.claude/`) : `npm run check` passe avec la copie
  installée.

Ajouté (dépôt) :
- Le dépôt utilise sa propre équipe d'agents : `npm run dogfood` installe
  `template/.claude/` dans `.claude/` (copie ignorée par Git, régénérée après chaque
  changement du template). Les évolutions passent par des branches `team/…` et des PR.

Corrigé (dépôt) :
- `.gitignore` : seule la copie installée à la racine (`/.claude/`) est ignorée, plus les
  nouveaux fichiers de `template/.claude/`.

## 0.6.0 — 2026-10-18 — Agent expert et .gitignore à l'installation

Ajouté :
- Agent `expert` (Fable, effort max) pour la logique complexe : algorithmes,
  concurrence, machines à états, précision, bugs de cause inconnue. Choisi par le
  planner pour ces tâches, et dernier recours en correction (après l'escalade sur
  `escalationModel`, avant le redécoupage). Mêmes garde-fous que les autres
  développeurs. ADR 0008.
- Installation : si `.claude/` n'est pas déjà dans le `.gitignore` du projet (sous
  une forme quelconque), l'installeur demande s'il faut l'ajouter ; ajout en fin de
  fichier, sans rien modifier d'autre. Options `--ignore-claude` et
  `--no-ignore-claude` pour les scripts ; sans terminal, rien n'est ajouté.

Modifié :
- Le test du matcher SubagentStop compare la liste complète des agents (un agent
  oublié échapperait au contrôle du livrable).

## 0.5.1 — 2026-10-18 — Bonnes pratiques web

Ajouté (prompts) :
- `implementer-frontend` : responsive et mobile d'abord, temps de chargement, navigateurs
  cibles, UX (retour à chaque action, confirmation des actions destructives),
  référencement des pages publiques, tests de bout en bout quand le projet en a.
- `implementer-backend` : service sans état, tâches longues en tâche de fond, délais et
  nouvelles tentatives bornés, journalisation (logger du projet, contexte, ni secret ni
  donnée personnelle), cache avec invalidation claire.
- `team-rules` : données personnelles (collecte minimale, jamais dans les logs ni les
  tests, consentement et conservation, RGPD).
- `code-reviewer` : vie privée, performance et interface dans la liste des vérifications.

## 0.5.0 — 2026-10-18 — Implementers spécialisés et agent de documentation

Ajouté (ADR 0007) :
- Agents `implementer-backend` et `implementer-frontend` (Sonnet, effort high) :
  prompts orientés domaine (back : contrats, validation à la frontière, données et
  migrations, transactions, erreurs, injection et autorisation, N+1, tests
  d'intégration ; front : composants et état, états chargement/erreur/vide,
  accessibilité, design system, i18n, tests de comportement, pas de logique métier
  côté client).
- Agent `documentation` (Sonnet, effort medium) : tâches de type `documentation`
  (README, docs/, CHANGELOG, ADR, commentaires d'API) d'après le diff ; n'écrit que de
  la documentation, même livrable que l'implementer.
- Skill `team-implementer` : procédure commune des développeurs, extraite
  d'`implementer` et préchargée par les trois implementers.
- Skills `conventions-backend` et `conventions-frontend`, propres au projet :
  créées à l'installation, jamais remplacées ni supprimées (même `--force`),
  rédigées par `/team-init` en lisant le code.
- Routage : le planner remplit `agent` de chaque tâche (règle dans
  `templates/plan.md`) et prévoit une tâche de documentation quand le changement
  touche un comportement visible, une API ou la configuration ; l'orchestrateur lance
  `task.agent` (défaut `implementer`).

Modifié :
- `implementer` reste l'agent par défaut (tâches mixtes, projets sans séparation) ;
  son corps ne garde que son rôle.
- `check-plan` : erreur si `agent` n'est pas un développeur connu ou s'il est
  désactivé dans `team.json` ; `agent` doit être recopié fidèlement de `plan.md`.
  L'empreinte du plan couvre l'agent quand il n'est pas `implementer` (les runs
  existants gardent leur empreinte).
- `guard-files` : le refus d'écrire dans `.claude/` et `.agent-runs/` vaut pour les
  quatre développeurs.
- `check-deliverable`, `record-metrics`, `deliverable.mjs`, `metrics.mjs` et le
  matcher `SubagentStop` reconnaissent les nouveaux agents (liste unique
  `DEVELOPERS`). `metrics.mjs` compte les appels de tous les développeurs par tâche.
- `team.json` : les trois nouveaux agents activés. `/team-init` propose les
  conventions et désactive un spécialiste sans objet.

Corrigé après relecture :
- `check-plan` refuse un agent dont le fichier a été supprimé du projet ;
  `validate.mjs` refuse `agents.implementer: false` (agent par défaut et des tâches
  CI/PR) ; l'agent `documentation` lit `CLAUDE.md` et les leçons.

Pas fait :
- Planner non séparé en PO et architecte (ADR 0007).
- Aucun run réel avec les spécialistes ; le banc n'a pas de scénario dédié.
- La cohérence entre l'agent choisi et les fichiers de la tâche (back, front) n'est
  pas vérifiée par script : seul l'agent (connu, activé) l'est.

## 0.4.0 — 2026-10-18 — Issues réalisées une par une

Ajouté :
- Skill `/team-next` et `next-issue.mjs` : choisit la plus ancienne issue `agent-ready`
  (auteur autorisé, ni marquée `agent-working`, ni déjà traitée par un run local
  non annulé, ni fermée par une PR ouverte) et la réalise avec le workflow `/team`
  dans la session. Lecture seule côté GitHub. Enchaînement avec `/goal`.
- `state.json` : champ facultatif `issue` (numéro de l'issue), vérifié par
  `check-state`.
- `new-run.mjs` : création déterministe d'un run (identifiant unique, dates réelles,
  session, valeurs de `team.json`). Corrige deux défauts vus au premier run réel du
  banc (`quick-bug`, réussi) : date de création recopiée du modèle (durée faussée) et
  commande composée de création refusée par les permissions.

Pas fait (en attente d'une décision) :
- Livraison automatique en brouillon (`pullRequest.autoDraft`) : push d'une branche
  `team/…` et PR brouillon sans accord. Le classifieur de sécurité l'a signalée
  comme un affaiblissement d'un garde-fou ; elle attend une confirmation explicite.

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
