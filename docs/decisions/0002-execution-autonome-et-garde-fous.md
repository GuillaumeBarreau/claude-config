# 0002 — Exécution autonome et garde-fous déterministes

Date : 2026-10-18 · Statut : acceptée

## Contexte

L'incrément 1 s'arrêtait au plan validé. L'objectif est d'aller seul jusqu'à une
branche prête pour une PR, en ne sollicitant l'humain qu'aux décisions qui lui
reviennent. Deux défauts constatés dans des configurations d'agents existantes :
- Beaucoup d'agents, de contextes et de configurations de hooks « prêtes à
  copier ». Plusieurs n'ont jamais tourné (hooks déclarés dans un
  fichier que Claude Code ne lit pas, scripts qui lisaient des variables shell vides
  au lieu du JSON sur stdin, `exit 1` qui ne bloque pas). Leçon retenue : un garde-fou
  non testé avec le vrai payload ne garde rien.
- L'orchestrateur s'arrête souvent au milieu d'un run pour
  « faire un point », ce qui casse l'autonomie.

## Décision

- **Un agent `implementer` (Sonnet), une tâche à la fois, sur la branche du run** dans
  l'arbre de travail courant, qui doit être propre. Il ne commite pas : l'orchestrateur
  commite chaque tâche après contrôles et relecture approuvée, ce qui donne un commit
  par tâche et un diff de relecture limité à la tâche.
- **Pas de worktree ni de parallélisme pour l'instant.** `isolation: worktree` crée une
  branche par appel qu'il faudrait ensuite fusionner : un mécanisme de plus sans gain
  tant que les tâches sont séquentielles. À reconsidérer si des runs réels montrent
  des tâches indépendantes longues.
- **Les preuves viennent de scripts** : `run-checks.mjs` exécute les contrôles de
  `team.json`, écrit les journaux et pose lui-même la porte 2 (`by: "run-checks"`).
- **Les règles qui doivent toujours s'appliquer sont des hooks Node** (Windows
  compris), fusionnés dans le `settings.json` du projet par `install.mjs` :
  `guard-bash`, `guard-files` (PreToolUse), `check-run-state` (PostToolUse),
  `keep-running` (Stop). Un hook de garde qui ne comprend pas son entrée bloque.
- **`deny` pour ce qui n'est jamais acceptable** (commit ou push sur la branche de
  base, `--no-verify`, secrets) ; **`ask` pour ce qui l'est avec accord** (push, PR,
  actions destructives, dépendances) : Claude Code pose la question à l'utilisateur,
  même en mode auto. Les permissions d'un agent (`permissionMode`) ne suffisent pas :
  elles sont ignorées quand la session est en `auto` ou `acceptEdits`.
- **Autonomie réglable** (`team.json` → `autonomy`). En `autonomous`, l'orchestrateur
  peut valider seul le plan, seulement hors piste full et sans tâche `requiresHuman`
  (règle vérifiée par `check-state`). La livraison reste toujours humaine.

## Conséquences

- Un run standard ne demande l'humain qu'à la porte 1 (sauf autonomie) et à la
  livraison, ou quand une tâche se bloque.
- `settings.json` n'est plus un fichier copié mais fusionné : les hooks de l'équipe
  sont reconnus à leur chemin `.claude/hooks/team/`. Un `settings.json` illisible est
  signalé en conflit et jamais modifié.
- Les hooks sont des filets de sécurité par motifs : une commande assez détournée leur
  échappe. Les règles de `team-rules` restent la référence.
- À valider sur un run réel : le comportement de `keep-running` sur des runs longs, le
  choix de Sonnet pour `implementer`.
