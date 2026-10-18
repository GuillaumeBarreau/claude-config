# Traiter le backlog GitHub sans surveillance

`backlog.mjs` (skill `team-backlog`) lance un run `/team` par issue GitHub prête, dans
un worktree jetable, et rend compte sur l'issue. La skill `/team-backlog` ne fait que la
simulation ; le mode réel se lance depuis un terminal ou un planificateur.

État : implémenté et testé avec un exécuteur simulé (aucun vrai `claude` ni `gh` dans
les tests). Pas encore éprouvé sur un vrai dépôt : voir « Limites ».

## Prérequis

- `team.json` initialisé (`/team-init`) **et commité sur la branche de base** : le
  worktree part de `origin/<baseBranch>`, il ne voit pas les fichiers non poussés.
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
| `--dry-run` | Liste les issues retenues et écartées, et ce qui serait fait. Seulement des lectures `gh` (`repo view`, `api` en GET). |
| `--yes`     | Mode réel. Refusé (code 2) si `CLAUDECODE` est défini, c'est-à-dire depuis une session Claude Code. |
| `--limit N` | Au plus N issues, plafonné par `backlog.maxIssues`. |
| `--issue n` | Cette issue seulement (le label n'est pas exigé ; les autres filtres oui). |

Sorties : 0 ; 1 si une issue a échoué en cours de traitement ; 2 refus ou erreur de
configuration. Rapport de chaque passage : `.agent-runs/backlog/<horodatage>.json`
(avec la sortie JSON de `claude` et les commentaires postés, à côté).

## Réglages (`team.json` → `backlog`, tous facultatifs)

| Clé            | Défaut        | Rôle |
| -------------- | ------------- | ---- |
| `label`        | `agent-ready` | Label qui rend une issue éligible |
| `draftPr`      | `false`       | `true` : push de la branche et PR brouillon quand le run est prêt |
| `maxIssues`    | `3`           | Issues traitées par passage |
| `maxBudgetUsd` | `5`           | Budget de `claude -p` par issue (`--max-budget-usd`) |

Auteurs autorisés : `prComments.allowedAssociations` (défaut `OWNER`, `MEMBER`,
`COLLABORATOR`).

## Déroulé pour une issue

1. Éligible : ouverte, porte `label`, pas `agent-working`, pas une pull request, auteur
   autorisé. Un worktree déjà présent pour cette issue la fait ignorer (rien n'est
   écrasé).
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

- Non éprouvé de bout en bout sur un vrai dépôt : passage du prompt `/team` par l'entrée
  standard de `claude -p`, liste `--allowedTools`, lancement d'un `claude.cmd` sous
  Windows par le shell.
- Le run `/team` crée sa branche depuis la branche de base **locale** : dans un
  worktree détaché, elle peut être en retard sur `origin/<base>` si elle n'a pas été
  mise à jour.
- Une issue à la fois, séquentiellement ; pas de reprise d'un run interrompu.
