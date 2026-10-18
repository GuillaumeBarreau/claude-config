# claude-config

Une petite équipe d'agents Claude Code pour le développement logiciel, installable dans
n'importe quel projet. Elle transforme une demande en spécification, puis en plan
validé, exécute les tâches une à une (code, contrôles, relecture, commit) et s'arrête
sur une branche prête pour une PR. **Push, PR et fusion restent humains.**

> État : **v0.2**. Planification, exécution autonome des tâches et garde-fous par
> hooks sont implémentés et couverts par des tests. Ils n'ont pas encore été éprouvés
> sur un run réel complet (voir [CHANGELOG](CHANGELOG.md)).

## L'équipe

| Rôle                         | Forme                                  | Écrit                         |
| ---------------------------- | -------------------------------------- | ----------------------------- |
| Orchestrateur / tech lead    | Skill `/team`, dans ta session         | État du run, commits, synthèse|
| `planner` (PO + architecte)  | Sous-agent, lecture seule, Opus        | Spécification et plan (rendus)|
| `implementer` (développeur)  | Sous-agent, Sonnet                     | Code et tests d'une tâche     |
| `code-reviewer` (relecture + QA) | Sous-agent, lecture seule, Opus    | Verdict et constats (rendus)  |

Trois pistes (`quick`, `standard`, `full`) et quatre portes : plan validé (par toi, ou
par l'orchestrateur en mode `autonomous`), contrôles obligatoires réussis (posés par
`run-checks.mjs`, pas par le modèle), relecture sans constat bloquant, accord explicite
avant push et PR. Détail : [workflow](template/.claude/skills/team/workflow.md).

```
/team <demande> → planner (spec + plan) → porte 1
  → pour chaque tâche : implementer → run-checks → code-reviewer → commit
      (échec ou constats → correction, au plus maxAttempts)
  → run-checks final → pr.md vérifié par check-pr → porte 4 (push / PR brouillon avec ton accord)
```

Les PR suivent des [conventions](template/.claude/skills/team/pr-conventions.md) : une PR
par run, un commit par tâche, titre au format des commits du projet, sections
obligatoires, statuts des contrôles identiques à ceux enregistrés, brouillon par
défaut, et jamais de fusion par un agent.

## Les garde-fous

Ce qui doit toujours tenir ne repose pas sur le modèle : ce sont des hooks Node
(Windows compris) fusionnés dans le `.claude/settings.json` du projet.

| Hook              | Effet |
| ----------------- | ----- |
| `guard-bash`      | Refuse commit ou push sur la branche de base, fusion de PR, `--no-verify`, lecture de `.env`, `rm -rf` massif. Demande ton accord pour push, PR, publication, actions destructives, nouvelle dépendance |
| `guard-files`     | Refuse les fichiers de secrets. L'implementer n'écrit ni dans `.claude/` ni dans `.agent-runs/`. Demande ton accord pour modifier les garde-fous |
| `check-run-state` | Vérifie chaque `state.json` écrit : un état qui contourne une porte revient au modèle |
| `keep-running`    | Empêche l'orchestrateur de s'arrêter au milieu d'une exécution |

## Installation dans un projet

Prérequis : Node ≥ 20, Git, Claude Code.

```bash
git clone <ce dépôt> claude-config
node claude-config/install.mjs <chemin/du/projet> --dry-run   # voir ce qui changerait
node claude-config/install.mjs <chemin/du/projet>             # appliquer
```

Puis, dans le projet : lancer Claude Code et taper `/team-init` pour découvrir et
valider les commandes de contrôle. Ensuite : `/team <ta demande>`.

Pour mettre à jour un projet, `git pull` dans `claude-config` puis relancer
`install.mjs`. Les fichiers que tu as modifiés dans le projet ne sont jamais écrasés :
ils sont signalés en conflit. Usage détaillé : [docs/USAGE.md](docs/USAGE.md).

## Ce que contient le dépôt

```
template/.claude/     ce qui est installé dans un projet (agents, skills, hooks, settings.json, team.json)
install.mjs           installation et mise à jour, avec manifeste et détection des conflits
validate.mjs          contrôle d'une config (template ou projet installé)
tests/                tests de l'installeur, du validateur, des portes, de run-checks et des hooks
docs/                 usage, ajout d'un agent, décisions
```

Vérifier le dépôt : `npm run check` (validateur puis tests, aucune dépendance).

## Origine

Les pratiques de garde-fous viennent du système d'agents de Chatlock.
