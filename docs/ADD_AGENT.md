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

## Ajouter un garde-fou (hook)

Seulement pour une règle qui doit tenir **à chaque fois** (question 1 de
`which-surface`). Sinon c'est une consigne dans `team-rules`.

1. Script Node dans `template/.claude/hooks/team/` (jamais bash ni Python), qui lit
   son entrée en JSON sur stdin avec `readPayload()` de `lib.mjs`. Claude Code ne
   passe rien en arguments ni en variables d'environnement propres à l'outil.
2. Décision PreToolUse : `emitDecision({ decision: 'deny' | 'ask', reason })`. Entrée
   illisible → `failClosed()` (code 2) : un garde qui laisse passer dans le doute est
   pire que pas de garde. PostToolUse : code 2 et message sur stderr pour renvoyer une
   erreur au modèle.
3. Déclare-le dans `template/.claude/settings.json`, avec une commande de la forme
   `node "$CLAUDE_PROJECT_DIR/.claude/hooks/team/<script>.mjs"` : c'est ce chemin qui
   permet à `install.mjs` de reconnaître les hooks de l'équipe lors d'une mise à jour.
4. Test dans `tests/hooks.test.mjs` qui lance le script avec le vrai payload, **vu
   échouer** contre le défaut qu'il attrape.
