# Traiter le backlog GitHub sans surveillance

`backlog.mjs` (skill `team-backlog`) lance un run `/team` par issue GitHub prête, dans
un worktree jetable, et rend compte sur l'issue. La skill `/team-backlog` ne fait que la
simulation ; le mode réel se lance depuis un terminal ou un planificateur.

État : implémenté et testé avec un exécuteur simulé (aucun vrai `claude` ni `gh` dans
les tests). Pas encore éprouvé sur un vrai dépôt : voir « Limites ».

## Prérequis

- `team.json` initialisé (`/team-init`) **commité et poussé sur la branche de base** : le
  worktree part de `origin/<baseBranch>`, il ne voit pas les fichiers non poussés. Le
  script le vérifie au démarrage, avant tout appel `gh` (voir « Vérifié au démarrage »).
- Des issues **prêtes** : trois rubriques en titres Markdown (voir « Issue prête »). Le
  modèle d'issue proposé par `/team-init` les fournit.
- `gh` authentifié (`gh auth status`) avec les droits issues, pull requests et contenu.
- `claude` dans le `PATH`, authentifié (abonnement ou `ANTHROPIC_API_KEY`).
- Node ≥ 20.

## Commandes

```
node .claude/skills/team-backlog/scripts/backlog.mjs --dry-run [--limit N] [--issue n]
node .claude/skills/team-backlog/scripts/backlog.mjs --yes     [--limit N] [--issue n]
```

| Option      | Effet |
| ----------- | ----- |
| `--dry-run` | Liste les issues retenues et écartées, et ce qui serait fait. Seulement des lectures : `git show`, `gh repo view`, `gh api` en GET (sans `git fetch`). |
| `--yes`     | Mode réel. Refusé (code 2) si `CLAUDECODE` est défini, c'est-à-dire depuis une session Claude Code. |
| `--limit N` | Au plus N issues, plafonné par `backlog.maxIssues`. |
| `--issue n` | Cette issue seulement (le label n'est pas exigé ; les autres filtres oui). |

Sorties : 0 ; 1 si une issue a échoué en cours de traitement ; 2 refus ou erreur de
configuration (dont `team.json` absent ou non initialisé sur `origin/<base>`). Rapport
de chaque passage : `.agent-runs/backlog/<horodatage>.json` (avec la sortie JSON de
`claude` et les commentaires postés, à côté).

### Vérifié au démarrage

Avant tout appel `gh`, tout `gh issue edit` et tout `git worktree add`, le script
s'arrête avec le code 2 et la cause si :

- `baseBranch` (de `team.json`) ne respecte pas `[A-Za-z0-9][A-Za-z0-9._/-]*` : aucun
  appel `git` n'est fait avec une valeur qui pourrait passer pour une option ;
- `--yes` seulement : `git fetch origin <base>` échoue (il précède la lecture de
  `team.json`, pour que la référence distante soit à jour) ;
- `.claude/team.json` est absent de `origin/<base>` (`git show
  origin/<base>:.claude/team.json`), illisible, ou non initialisé (`initialized`
  différent de `true`).

En `--dry-run`, pas de `git fetch` (la simulation ne modifie rien, pas même les
références locales) : `origin/<base>` est lue telle qu'elle est dans le dépôt local, et
peut être en retard sur le serveur. Le message d'absence le précise (« référence locale,
sans git fetch »).

## Réglages (`team.json` → `backlog`, tous facultatifs)

| Clé            | Défaut        | Rôle |
| -------------- | ------------- | ---- |
| `label`        | `agent-ready` | Label qui rend une issue éligible |
| `draftPr`      | `false`       | `true` : push de la branche et PR brouillon quand le run est prêt |
| `maxIssues`    | `3`           | Issues traitées par passage |
| `maxBudgetUsd` | `5`           | Budget de `claude -p` par issue (`--max-budget-usd`) |
| `priorityLabels` | `["P0", "P1", "P2"]` | Labels de priorité, du plus haut au plus bas (voir « Ordre de traitement ») |

`priorityLabels` doit être une liste non vide de textes non vides, sans doublon :
`npm run validate` du dépôt `claude-config` refuse une autre forme ; à l'exécution, une
valeur invalide est ignorée et la liste par défaut s'applique.

Auteurs autorisés : `prComments.allowedAssociations` (défaut `OWNER`, `MEMBER`,
`COLLABORATOR`).

## Issue prête

Une issue du backlog n'est traitée que si elle est **prête** : elle contient les trois
rubriques ci-dessous, chacune en **titre Markdown** (`#` à `######`) suivi d'un contenu non
vide.

| Rubrique | Titres acceptés (début du titre, accents et majuscules ignorés) |
| -------- | --------------------------------------------------------------- |
| Objectif | `Objectif` |
| Comportement attendu ou critères | `Comportement attendu…`, `Critères…` (par exemple `Critères d'acceptation`) |
| Hors périmètre | `Hors périmètre` |

- **Seuls les titres comptent** : un libellé en gras (`**Objectif**`) ne vaut pas une
  rubrique.
- Un deux-points final (`## Objectif :`) est accepté.
- Le contenu court jusqu'au titre suivant de même niveau ou de niveau supérieur ; un
  sous-titre compte comme du contenu. Les commentaires HTML (`<!-- … -->`) sont retirés :
  une rubrique qui n'en contient qu'un est vide (c'est ce qui rend un modèle non rempli
  « non prêt »).
- La vérification porte sur le **texte retenu** : corps normalisé (fins de ligne,
  espaces de début et de fin) et limité à **4 000 caractères**, comme le prompt envoyé à
  `claude`. Une rubrique placée après le 4 000e caractère est manquante.
- Une issue qui ne l'est pas est écartée avec « issue non prête : <rubriques
  manquantes> » (`--dry-run`, `next-issue.mjs`). En `--yes`, voir « Issue non prête en
  mode réel ».

Le modèle d'issue `.github/ISSUE_TEMPLATE/agent-ready.md` est proposé par `/team-init`,
qui ne l'écrit qu'avec accord et ne remplace jamais un fichier existant ; `install.mjs` ne
le copie pas.

### Issue non prête en mode réel

Avec `--yes`, une issue non prête est traitée **avant** les issues prêtes et ne compte
pas dans la limite. Le script ne lance ni worktree ni `claude` pour elle, et ne fait pas
de `git fetch` à son sujet :

1. Un commentaire fait de constantes : les libellés des rubriques manquantes et la marche
   à suivre (compléter l'issue, modèle de `/team-init`, remettre le label). Le texte de
   l'issue n'y figure jamais.
2. `gh issue edit <n> --add-label agent-needs-info --remove-label <label>` : l'issue perd
   `agent-ready` (par défaut) et n'est pas recommentée au passage suivant. Une fois
   complétée, on remet le label.

L'entrée du rapport (`issues`) porte `outcome: "not_ready"`. Une erreur d'écriture donne
`outcome: "error"` et le code de sortie 1. En `--dry-run`, l'issue figure dans `skipped`
et rien n'est écrit sur GitHub.

## Ordre de traitement

Les issues sont lues par ancienneté (`sort=created&direction=asc`) puis ordonnées par la
même fonction que `/team-next` :

1. priorité : le plus petit rang parmi les labels de l'issue présents dans
   `priorityLabels` (`P0` avant `P1` avant `P2`) ; sans label de priorité, en dernier ;
   plusieurs labels : le plus prioritaire compte ; la casse des noms est ignorée ;
2. à priorité égale, la plus ancienne (date de création), puis le plus petit numéro.

Seuls les labels fixent la priorité, jamais le texte de l'issue : ils ne sont posés que
par des personnes autorisées.

## Dépendances : « Dépend de #n »

Une ligne du corps qui contient « Dépend de » (casse et accents ignorés) déclare les
issues attendues, par exemple `Dépend de #12` ou `Dépend de #12 et #14`.

| Situation | Effet |
| --------- | ----- |
| #n **ouverte** | L'issue est écartée : « dépend de #n (ouverte) » |
| #n **fermée** | L'issue reste éligible |
| Issues qui s'attendent en rond (`#a` attend `#b`, qui attend `#a`, ou une issue qui dépend d'elle-même) | Écartées : « dépendances en cycle : #a → #b → #a » |
| Référence **illisible** (« Dépend de la migration », `o/r#3`, `#12abc`) | Avertissement, l'issue reste éligible |
| État de #n **inconnu** (introuvable, erreur `gh`, plafond de lectures atteint) | Avertissement, l'issue reste éligible |

- Une issue de la même passe est considérée ouverte sans appel ; les autres sont lues par
  `gh api repos/{owner}/{repo}/issues/<n>` (GET), **20 lectures au plus** par passage, en
  commençant par les issues les plus prioritaires.
- Les références se lisent dans **tout le corps** (`dependencyRefs`), pas seulement dans
  les 4 000 premiers caractères retenus pour la vérification des rubriques et pour le
  prompt.
- Une référence dans un commentaire HTML est ignorée. Elle doit être précédée d'un début
  de ligne, d'une espace ou de `(`, `,`, `;`, `:`.
- Une issue écartée pour une dépendance ouverte ou un cycle n'est pas modifiée (ni
  commentaire ni label) : elle redevient éligible dès que la dépendance est fermée.

### Avertissements

Les avertissements ont la forme `{ number, message }` (numéro de l'issue concernée) :

- `référence de dépendance illisible : « <extrait de 80 caractères au plus> »`
- `état de la dépendance #n inconnu : issue considérée prête`

Ils viennent du texte des issues, donc ils sont bornés : **5 par issue et 20 au total**,
ceux de l'issue retenue d'abord. Le nombre d'avertissements omis est dans
`warningsOmitted`, dans le rapport du backlog et dans la sortie de
`next-issue.mjs --json` (avec `warnings`). Une issue non prête ne produit pas
d'avertissement.

## Déroulé pour une issue

1. Retenue : ouverte, porte `label`, pas `agent-working`, pas une pull request, auteur
   autorisé, **prête** et **débloquée** (voir plus haut), dans l'ordre de priorité et
   dans la limite du passage. Un worktree déjà présent pour cette issue la fait ignorer
   (rien n'est écrasé).
2. Label `agent-working` (les labels `agent-*` sont créés au besoin).
3. `git fetch origin <base>` puis `git worktree add --detach
   <tmp>/claude-backlog/<repo>-<n> origin/<base>` : hors du dépôt, l'arbre de travail
   de l'utilisateur n'est jamais touché.
4. `claude -p --output-format json --permission-mode acceptEdits --max-budget-usd …
   --max-turns 300 --allowedTools …` dans le worktree. Le prompt
   `/team Issue #n : <titre>` suivi du corps (4 000 caractères au plus) passe par
   l'entrée standard, jamais en argument de commande. Outils autorisés : lecture,
   écriture, agents, skills, commandes Git sans effet distant, scripts de l'équipe et
   commandes de contrôle de `team.json`. Le push reste interdit à `claude` (les hooks
   demandent l'accord, que personne ne donne en mode `-p`).
5. Lecture du `state.json` du run le plus récent du worktree, puis décision :

| État du run | Action sur l'issue |
| ----------- | ------------------ |
| Prêt (`awaiting_delivery_approval`, porte contrôles posée par `run-checks`, contrôles obligatoires réussis, relecture validée, tâches `done`, aucune `requiresHuman`, branche ≠ base, `check-state` sans erreur) **et** `draftPr: true` | `git push -u origin <branche>`, `gh pr create --draft --body-file pr-body.md`, label `agent-pr`, lien en commentaire |
| Prêt mais `draftPr: false` | Label `agent-needs-approval`, commentaire : branche locale prête dans le worktree |
| `awaiting_input` | Questions en commentaire, label `agent-needs-info` |
| `awaiting_plan_approval` | Label `agent-needs-approval` |
| Autre (bloqué, incomplet, aucun run) | Label `agent-blocked` et la raison en commentaire |

6. Retrait de `agent-working` et de `label`. Pour relancer une issue : supprimer son
   worktree (`git worktree remove <chemin>`) et remettre le label.

## Sécurité

- Le texte d'une issue est une donnée non fiable qui devient le prompt d'un agent
  autonome. Seuls les auteurs `OWNER`, `MEMBER`, `COLLABORATOR` déclenchent un run, et
  seules les personnes qui peuvent poser un label choisissent les issues.
- Aucun push ni PR par défaut. Même avec `draftPr: true`, la PR est un brouillon : la
  fusion reste humaine (`gh pr merge` est refusé par les hooks).
- Dépenses bornées : `maxIssues × maxBudgetUsd` par passage, multiplié par la fréquence
  de planification. Commencer avec `maxIssues: 1` et un budget bas.
- Le mode `-p` ne pose aucune question : toute action soumise à accord (push, ajout de
  dépendance, `reset --hard`…) est refusée. Une tâche sensible (`requiresHuman`) arrête
  le run à la porte 1 : l'issue passe en `agent-needs-approval`.

## Planifier

Toujours valider d'abord avec `--dry-run`, puis un passage manuel `--yes --issue n`.

### cron (Linux, macOS)

```
# Du lundi au vendredi à 7 h
0 7 * * 1-5 cd /chemin/projet && node .claude/skills/team-backlog/scripts/backlog.mjs --yes >> .agent-runs/backlog/cron.log 2>&1
```

cron démarre avec un `PATH` minimal : indiquer les chemins complets de `node`, ou
définir `PATH` en tête de crontab pour que `claude`, `gh` et `git` soient trouvés.

### Planificateur de tâches (Windows)

```
schtasks /Create /TN "claude-backlog" /SC WEEKLY /D LUN,MAR,MER,JEU,VEN /ST 07:00 ^
  /TR "cmd /c cd /d C:\chemin\projet && node .claude\skills\team-backlog\scripts\backlog.mjs --yes >> .agent-runs\backlog\task.log 2>&1"
```

Sur un Windows en anglais, les jours s'écrivent `MON,TUE,WED,THU,FRI`. La tâche
tourne sous le compte qui la crée (`gh` et `claude` doivent y être authentifiés).
Vérifier : `schtasks /Run /TN "claude-backlog"`, puis le journal. Supprimer :
`schtasks /Delete /TN "claude-backlog" /F`.

### GitHub Actions planifié

Pas de machine à laisser allumée, mais une clé API facturée à l'usage (pas
d'abonnement) et un fichier de CI à ajouter au dépôt (zone sensible : à relire).

```yaml
name: backlog-agents
on:
  schedule:
    - cron: '0 6 * * 1-5'   # UTC
  workflow_dispatch:
permissions:
  contents: write
  issues: write
  pull-requests: write
concurrency:
  group: backlog-agents
  cancel-in-progress: false
jobs:
  backlog:
    runs-on: ubuntu-latest
    timeout-minutes: 180
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install -g @anthropic-ai/claude-code
      - run: |
          git config user.name "claude-backlog"
          git config user.email "claude-backlog@users.noreply.github.com"
      - run: node .claude/skills/team-backlog/scripts/backlog.mjs --yes
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GH_TOKEN: ${{ github.token }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: backlog-report
          path: .agent-runs/backlog/
```

- Coût : chaque passage peut dépenser jusqu'à `maxIssues × maxBudgetUsd` dollars ; un
  cron quotidien sur les jours ouvrés multiplie par ~22 par mois. Fixer aussi une limite
  de dépense sur la clé dans la console Anthropic.
- Une PR ouverte avec `GITHUB_TOKEN` ne déclenche pas les workflows de CI du dépôt :
  utiliser un token d'application GitHub ou un PAT à portée réduite si la CI doit
  tourner sur ces PR.
- Le runner est éphémère : les worktrees disparaissent avec lui, seul le rapport
  (artefact) et la branche poussée restent.

## Limites

- Seules les **50 issues les plus anciennes** portant le label sont lues (`per_page=50`,
  pas de pagination) : une issue prioritaire au-delà n'est pas vue tant que les plus
  anciennes ne sont pas traitées ou écartées du label.
- Une issue dont une dépendance a un état inconnu (plafond de 20 lectures, issue
  introuvable) est traitée, avec un avertissement.
- Rupture depuis la 0.7.0 : une issue `agent-ready` sans les trois rubriques n'est plus
  traitée (voir le CHANGELOG).
- Non éprouvé de bout en bout sur un vrai dépôt : passage du prompt `/team` par l'entrée
  standard de `claude -p`, liste `--allowedTools`, lancement d'un `claude.cmd` sous
  Windows par le shell.
- Le run `/team` crée sa branche depuis la branche de base **locale** : dans un
  worktree détaché, elle peut être en retard sur `origin/<base>` si elle n'a pas été
  mise à jour.
- Une issue à la fois, séquentiellement ; pas de reprise d'un run interrompu.
