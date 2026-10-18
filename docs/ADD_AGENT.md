# Ajouter un agent ou modifier le workflow

## Avant : en a-t-on besoin ?

Passe la question à la skill `which-surface`. Un agent se justifie quand le travail
inonderait la conversation et peut être délégué par un message autonome. Sinon : une
consigne dans le workflow, une skill, ou rien.

## Ajouter un agent

1. Crée `template/.claude/agents/<nom>.md` :

   ```markdown
   ---
   name: <nom>
   description: <ce qu'il fait et quand l'utiliser — c'est ce que lit l'orchestrateur>
   tools: Read, Grep, Glob, Bash          # le strict nécessaire, jamais *
   disallowedTools: Edit, Write, NotebookEdit   # si lecture seule
   model: sonnet                          # haiku | sonnet | opus | fable
   effort: medium                         # low | medium | high | xhigh | max
   maxTurns: 60
   color: blue
   skills:
     - team-rules                         # règles communes, toujours
   ---

   <Rôle, entrées, livrable attendu, limites. ≤ 100 lignes.>
   ```

2. Déclare-le dans `template/.claude/team.json` (`agents`).
3. Branche-le dans `skills/team/workflow.md` : l'étape, ses entrées, son livrable, ses
   conditions de réussite et de blocage.
4. `npm run check`, puis ajoute une entrée au `CHANGELOG.md`.
5. Réinstalle dans un projet de test et fais un run réel avant de le généraliser.

Choisir un nom qui n'existe pas déjà dans les projets cibles : un agent du projet
portant le même nom serait signalé en conflit à l'installation.

## Modifier le workflow

- Étapes, pistes et limites : `template/.claude/skills/team/workflow.md`.
- Comportement de l'orchestrateur : `template/.claude/skills/team/SKILL.md`.
- Règles qui doivent être garanties (portes, statuts) : `scripts/check-state.mjs`, avec
  un test dans `tests/check-state.test.mjs` vu échouer avant correction.
- Règles communes à tous les agents : `template/.claude/skills/team-rules/SKILL.md`.
