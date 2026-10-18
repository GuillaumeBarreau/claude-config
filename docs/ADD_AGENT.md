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

   <Rôle, entrées, limites. ≤ 100 lignes. Le livrable : renvoi vers
   .claude/skills/team/deliverables.md, jamais le schéma recopié.>
   ```

2. Livrable structuré : ajoute sa section (champs, cohérence, exemple) dans
   `template/.claude/skills/team/deliverables.md`, son schéma dans
   `validateDeliverable` (`skills/team/scripts/deliverable.mjs`, liste `AGENTS`) avec
   un test dans `tests/deliverable.test.mjs`, et son nom dans le matcher
   `SubagentStop` de `settings.json` et dans `TEAM_AGENTS` de
   `hooks/team/record-metrics.mjs`. Sans schéma, le hook `check-deliverable` ne le
   contrôle pas et ses appels ne sont pas mesurés.
3. Déclare-le dans `template/.claude/team.json` (`agents`).
   **Agent développeur** (réalise une tâche du plan, comme `implementer-backend`) :
   ajoute-le à `DEVELOPERS` dans `deliverable.mjs` (schéma implementer, mesures,
   `check-plan`) et à `GUARDED_AGENTS` dans `hooks/team/guard-files.mjs` (refus
   d'écrire dans `.claude/` et `.agent-runs/` ; un test vérifie que les deux listes
   concordent), précharge `team-rules` et `team-implementer` (procédure commune, à ne
   pas recopier), et ajoute sa ligne à la règle « Routage des tâches » de
   `skills/team/templates/plan.md`. Des conventions propres au projet vont dans une
   skill ajoutée à `PROJECT_OWNED` (`install.mjs`), avec un test d'installation.
4. Branche-le dans `skills/team/workflow.md` : l'étape, ses entrées, son livrable, ses
   conditions de réussite et de blocage.
5. `npm run check`, puis ajoute une entrée au `CHANGELOG.md`.
6. Réinstalle dans un projet de test et fais un run réel avant de le généraliser.

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
   erreur au modèle. SubagentStop / Stop : `{ "decision": "block", "reason" }` sur
   stdout relance l'agent ; ne bloque jamais quand `stop_hook_active` est vrai, et
   laisse passer une entrée illisible (un Stop qui bloque boucle). Un hook de mesure
   ne bloque jamais (sortie 0).
3. Déclare-le dans `template/.claude/settings.json`, avec une commande de la forme
   `node "$CLAUDE_PROJECT_DIR/.claude/hooks/team/<script>.mjs"` : c'est ce chemin qui
   permet à `install.mjs` de reconnaître les hooks de l'équipe lors d'une mise à jour.
4. Test (dans `tests/hooks.test.mjs` ou un fichier de test dédié) qui lance le
   script avec le vrai payload, **vu échouer** contre le défaut qu'il attrape.
