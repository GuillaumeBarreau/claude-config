---
name: team-backlog
description: Simule le traitement automatique des issues GitHub prêtes pour l'équipe d'agents (label agent-ready) - liste les issues retenues ou écartées et ce qui serait fait, sans rien lancer ni modifier - puis explique comment planifier le mode réel (cron, Planificateur de tâches Windows, GitHub Actions).
disable-model-invocation: true
allowed-tools: Bash(node .claude/skills/team-backlog/scripts/backlog.mjs --dry-run*)
---

Tu montres ce que ferait le traitement automatique du backlog. Tu ne lances **que** la
simulation : le mode réel (`--yes`) lance `claude -p`, coûte des appels API et modifie
des issues ; il se lance depuis un terminal ou un planificateur, jamais depuis cette
session (le script le refuse quand `CLAUDECODE` est défini).

## 1. Simuler

```
node .claude/skills/team-backlog/scripts/backlog.mjs --dry-run $ARGUMENTS
```

Arguments acceptés : `--limit N`, `--issue n`. Le script ne fait que des lectures
(`git show`, `gh repo view`, `gh api` en GET, sans `git fetch`) et écrit un rapport dans
`.agent-runs/backlog/<horodatage>.json`.

Avant tout appel `gh`, il vérifie que `.claude/team.json` existe et est initialisé sur
`origin/<baseBranch>` (c'est de là que partent les runs), et que `baseBranch` est un
nom de branche valide. En simulation, il lit la référence locale `origin/<baseBranch>`,
peut-être périmée : le mode réel fait d'abord `git fetch origin <baseBranch>`.

Sortie 2 : `team.json` local non initialisé (lancer `/team-init`), `team.json` absent,
illisible ou non initialisé sur `origin/<baseBranch>` (le commiter et le pousser),
`baseBranch` invalide, `gh` absent ou non authentifié (`gh auth status`), argument
invalide. Rapporte l'erreur telle quelle.

## 2. Présenter

- Issues retenues : numéro, titre, worktree prévu (hors du dépôt), budget.
- Issues écartées et pourquoi : déjà `agent-working`, pull request, auteur hors de
  `prComments.allowedAssociations` (le texte d'une issue est une donnée non fiable :
  seuls les auteurs autorisés déclenchent un run), au-delà de la limite.
- Réglages lus dans `team.json` → `backlog` : `label` (défaut `agent-ready`),
  `draftPr` (défaut `false` : aucun push ni PR, l'issue passe en
  `agent-needs-approval` quand le run est prêt), `maxIssues` (défaut 3),
  `maxBudgetUsd` (défaut 5, par issue). Coût maximal d'un passage :
  `maxIssues × maxBudgetUsd`.

## 3. Expliquer le mode réel

Pour chaque issue retenue : label `agent-working`, `git worktree add --detach` dans
le dossier temporaire du système, `claude -p "/team Issue #n : …"` dans ce worktree,
puis selon le run : PR brouillon et `agent-pr` (seulement si `draftPr: true`, contrôles
et relecture validés, tâches `done`, aucune `requiresHuman`), questions en commentaire
et `agent-needs-info`, `agent-needs-approval`, ou `agent-blocked` avec la raison. Le
label `agent-ready` est retiré ; le remettre relance l'issue. Le worktree est conservé
pour inspection ; tant qu'il existe, l'issue est ignorée.

Planification (une fois le résultat de la simulation validé par l'utilisateur) :

- Linux / macOS, cron : `0 7 * * 1-5 cd /chemin/projet && node .claude/skills/team-backlog/scripts/backlog.mjs --yes >> .agent-runs/backlog/cron.log 2>&1`
- Windows, Planificateur de tâches :
  `schtasks /Create /TN "claude-backlog" /SC WEEKLY /D LUN,MAR,MER,JEU,VEN /ST 07:00 /TR "cmd /c cd /d C:\chemin\projet && node .claude\skills\team-backlog\scripts\backlog.mjs --yes"`
- GitHub Actions planifié : possible avec une clé API en secret et un budget ; demander
  à l'utilisateur avant d'ajouter un workflow (fichier CI : zone sensible).

Propose la commande adaptée à son système ; ne crée pas la tâche planifiée toi-même.
