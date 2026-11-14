# 0012 — Préfixe `cc-` des agents

Date : 2026-11-13 · Statut : acceptée

## Contexte

Les agents du template portaient des noms de rôle (`planner`, `implementer`,
`code-reviewer`, `documentation`…). Ces noms entrent en collision avec les agents
propres aux projets cibles. Cas réel : un projet cible avait son propre
`.claude/agents/code-reviewer.md`. À l'installation, le fichier était signalé en conflit
et conservé, mais le hook `SubagentStop` `check-deliverable` visait tout agent nommé
`code-reviewer` : il aurait exigé de l'agent du projet un livrable JSON qu'il ne produit
pas, et l'aurait renvoyé au travail à chaque fin de revue.

Le problème vaut pour tout nom de rôle courant : `planner`, `expert`, `documentation`
sont des noms qu'un projet peut choisir pour ses propres agents.

## Décision

**Tous les agents du template portent le préfixe `cc-`** (claude-config) : `cc-planner`,
`cc-implementer`, `cc-implementer-backend`, `cc-implementer-frontend`,
`cc-documentation`, `cc-expert`, `cc-code-reviewer`, `cc-analyste`,
`cc-pr-reviewer-frontend`, `cc-pr-reviewer-backend`, `cc-pr-reviewer-architecture`,
`cc-pr-verifier`. Le nom préfixé est l'identifiant partout : fichier et `name:`, listes
`AGENTS` / `DEVELOPERS` / `PR_REVIEWERS` / `REVIEW_AGENTS` (`deliverable.mjs`, source
unique), `GUARDED_AGENTS`, matcher `SubagentStop`, clés `agents` de `team.json`, champ
`agent` des livrables et des tâches, descriptions d'appel (`cc-implementer T1 #1`). Les
skills ne changent pas de nom : `/team`, `/team-review`… ne sont pas des agents et
n'entrent pas dans le matcher.

**`validate.mjs` fait respecter la convention** : un agent géré par claude-config
(template, ou fichier présent dans le manifeste d'un projet installé) sans préfixe `cc-`
est une erreur. Les agents propres au projet ne sont pas concernés.

**Migration des projets installés avant 0.10**, par `install.mjs` :

- les anciens fichiers `agents/<nom>.md` sont des fichiers « retirés du template » : le
  mécanisme existant les supprime s'ils sont intacts (empreinte du manifeste) et conserve
  en le signalant tout fichier modifié localement ; aucun code nouveau ;
- `team.json` appartient au projet et n'est jamais remplacé ; l'installeur y fait une
  seule écriture ciblée : renommer les clés `agents` sans préfixe vers le nouveau nom, à
  leur place, valeur `true`/`false` conservée (action « migré », respectée par
  `--dry-run`). `validate.mjs` signale par ailleurs toute ancienne clé restante avec le
  nouveau nom à utiliser ;
- les runs en cours dans `.agent-runs/` (`agent: "implementer"`, `"implementer-backend"`…)
  restent valides : `check-plan` et `check-state` lisent un ancien nom comme son
  équivalent préfixé (`LEGACY_AGENTS`, `canonicalAgent`), et l'empreinte du plan garde
  l'agent tel qu'écrit, pour qu'un `planCheck` enregistré avant la mise à jour reste
  vérifiable.

## Conséquences

- Changement cassant pour les projets installés : relancer `install.mjs`, qui retire les
  anciens agents et migre `team.json` ; les ADR antérieurs et les entrées passées du
  CHANGELOG citent les anciens noms et ne sont pas réécrits.
- Les agents de l'équipe sont reconnaissables au premier coup d'œil dans
  `.claude/agents/` d'un projet, à côté des agents du projet.
- Le matcher `SubagentStop` ne peut plus capturer un agent du projet : seul un agent
  `cc-*` est renvoyé au travail par `check-deliverable`.
- Les noms sont un peu plus longs dans les prompts et les descriptions d'appel.

## Alternatives écartées

- **Renommer seulement `code-reviewer`** : règle le cas rencontré, pas la classe de
  problème ; `planner` ou `documentation` sont tout aussi probables dans un projet.
- **Ancrer le matcher `SubagentStop`** (`^code-reviewer$`) sans renommer : le conflit de
  fichier à l'installation subsiste, et un agent du projet homonyme reste capturé.
- **Supprimer les anciennes clés de `team.json` au lieu de les renommer** : perd le
  réglage `false` d'un spécialiste désactivé, que l'utilisateur aurait à refaire.
- **Ne pas toucher `team.json` et laisser `validate.mjs` signaler** : conforme au
  principe « appartient au projet », mais chaque projet installé aurait une étape
  manuelle pour une transformation sans ambiguïté ; le renommage de clés, valeur
  conservée, n'est pas un remplacement du fichier.
