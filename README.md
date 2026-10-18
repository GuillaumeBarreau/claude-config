# claude-config

Une petite équipe d'agents Claude Code pour le développement logiciel, installable dans
n'importe quel projet. Elle transforme une demande en spécification, puis en plan
validé, et encadre l'exécution jusqu'à une PR prête à relire. **La fusion reste
humaine.**

> État : **v0.1, incrément 1**. Planification complète (spécification, plan, porte de
> validation) et piste *quick*. L'exécution des tâches par un agent `implementer`
> arrive à l'incrément 2 (voir [CHANGELOG](CHANGELOG.md)).

## L'équipe

| Rôle                         | Forme                                  | Écrit                         |
| ---------------------------- | -------------------------------------- | ----------------------------- |
| Orchestrateur / tech lead    | Skill `/team`, dans ta session         | État du run, synthèse         |
| `planner` (PO + architecte)  | Sous-agent, lecture seule, Opus        | Spécification et plan (rendus)|
| `code-reviewer` (relecture + QA) | Sous-agent, lecture seule, Opus    | Verdict et constats (rendus)  |
| `implementer`                | *Incrément 2* — sous-agent en worktree | Code sur une branche dédiée   |

Trois pistes (`quick`, `standard`, `full`) et quatre portes : plan validé par toi,
contrôles obligatoires réussis, relecture sans constat bloquant, accord explicite avant
push et PR. Détail : [workflow](template/.claude/skills/team/workflow.md).

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
template/.claude/     ce qui est installé dans un projet (agents, skills, team.json)
install.mjs           installation et mise à jour, avec manifeste et détection des conflits
validate.mjs          contrôle d'une config (template ou projet installé)
tests/                tests de l'installeur, du validateur et des règles de portes
docs/                 usage, ajout d'un agent, décisions
```

Vérifier le dépôt : `npm run check` (validateur puis tests, aucune dépendance).

## Origine

Principes repris de [VALORA](https://github.com/windagency/valora.ai) (cycle planifier →
vérifier le plan → implémenter → tester → relire → livrer) et de
[claude-agent-framework](https://github.com/ciscoittech/claude-agent-framework) (licence
MIT : agents courts, choix du bon mécanisme, validateur et tests de la configuration).
La skill `which-surface` et une partie des contrôles du validateur en sont adaptées.
Les pratiques de garde-fous viennent du système d'agents de Chatlock.
