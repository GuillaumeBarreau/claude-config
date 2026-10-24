---
name: team-audit
description: Analyse proactive du code. Lance l'agent analyste, présente les constats classés, et crée des issues GitHub (label agent-ready) avec l'accord de l'utilisateur.
argument-hint: "[--scope <chemin>] [--focus security|debt|features|performance|architecture|all]"
allowed-tools: Bash(node .claude/skills/team-audit/scripts/create-issues.mjs *)
---

Tu lances un audit du code avec l'agent `analyste`, puis tu proposes de créer des
issues GitHub à partir de ses constats.

## 1. Préparer

Lis `.claude/team.json`. Si `agents.analyste` est absent ou `false` :
> L'agent analyste est désactivé dans `team.json`. Active-le avec `"analyste": true`.

Parse `$ARGUMENTS` :
- `--scope <chemin>` → mode `targeted`, scope = `<chemin>`
- `--focus <valeur>` → focus = `<valeur>` (par défaut `all`)
- Sans `--scope` → mode `audit`

## 2. Lancer l'analyste

Lance l'agent `analyste` comme sous-agent avec cette description :

```
analyste audit : mode=<mode> focus=<focus> scope=<scope|null>
```

Il renvoie un livrable JSON avec ses constats.

## 3. Présenter les constats

Lis le bloc JSON du livrable. Affiche les constats groupés par sévérité (`critical`,
`major`, `minor`), puis par type, dans un tableau :

```
| Id | Sévérité | Type         | Fichier         | Problème                     |
|----|----------|--------------|-----------------|------------------------------|
| F1 | major    | security     | src/auth.js:18  | Token JWT non vérifié        |
```

Affiche le résumé (`summary`) de l'analyste.

S'il n'y a aucun constat : « Aucun constat. L'analyse est terminée. » et arrête-toi.

## 4. Proposer la création d'issues

Demande à l'utilisateur quels constats transformer en issues GitHub :
- `all` : tous les constats
- `critical+major` : seulement les constats critical et major
- une liste d'identifiants : `F1, F3, F5`
- `none` : aucune issue

Si `none` : « Aucune issue créée. L'analyse est terminée. » et arrête-toi.

## 5. Créer les issues

Pour les constats approuvés, écris un fichier JSON temporaire avec les constats
sélectionnés (un tableau d'objets `{ issueTitle, issueBody }`) et lance :

```bash
node .claude/skills/team-audit/scripts/create-issues.mjs <fichier.json>
```

Le script crée les issues avec `gh issue create` et le label `agent-ready`. Il
renvoie un JSON `{ created: [...], failed: [...] }`.

## 6. Rapport

Affiche les issues créées avec leurs URLs et les éventuels échecs. Termine par :

> Audit terminé : N constats, M issues créées.
