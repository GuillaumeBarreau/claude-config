---
name: which-surface
description: Décide si un besoin récurrent doit devenir un hook, une ligne de CLAUDE.md, un sous-agent, une skill, ou rien du tout. À utiliser quand on se demande s'il faut créer un agent, une skill, un hook ou une règle.
allowed-tools: Read, Grep, Glob
---

Décide où placer un travail qu'on veut rendre reproductible. La plupart du temps, la
réponse est « nulle part de nouveau ».

Adapté de la skill `which-surface` de claude-agent-framework (ciscoittech, licence MIT).

## Pose les questions dans l'ordre. Prends le premier oui.

1. **Cela doit-il arriver à chaque fois, même si le modèle est convaincu du
   contraire ?** → **Hook**, dans `.claude/settings.json`.
2. **Un fait court, vrai à chaque tour, utile sans qu'on le demande ?** →
   **`CLAUDE.md`**. S'il ne concerne que certains fichiers : un fichier
   `.claude/rules/` avec un champ `paths:`.
3. **Le faire inonderait-il la conversation d'une sortie que personne ne relira ?** →
   **Sous-agent**.
4. **Une procédure aux étapes connues, lancée par son nom ?** → **Skill**.
5. **Rien de tout cela ?** → **Rien.**

## Puis confirme la réponse

Chaque mécanisme a une question qui attrape l'erreur courante :

- **Hook** — nomme le cas où le modèle aurait *raison* de s'en passer. Si tu en trouves
  un, c'est une consigne, pas un hook : un hook là se déclencherait sur du travail où il
  n'a pas de sens, jusqu'à ce que quelqu'un le désactive.
- **`CLAUDE.md`** — fait-il moins de trois lignes ? Sinon, c'est une règle ou une
  skill.
- **Sous-agent** — écris maintenant le message de délégation. L'agent ne reçoit rien
  de cette conversation. Si le message devient long, le travail est trop imbriqué :
  fais-le directement.
- **Skill** — le corps restera-t-il sous ~150 lignes ? Il reste en contexte après son
  chargement. Si ce ne sont que des consignes, pas de `context: fork` : une skill
  forkée sans tâche impérative ne rend rien, sans erreur.
- **Rien** — l'as-tu vraiment fait trois fois ? Deux fois, c'est une coïncidence.

## Rapport

Indique : le mécanisme, la question qui l'a désigné, le chemin exact du fichier à
créer, et la vérification qu'il a passée. Si la réponse est « rien », dis quoi taper à
la place.
