# 0003 — Livrables structurés et mesures des runs

Date : 2026-10-18 · Statut : acceptée

## Contexte

Les agents rendaient leur livrable en prose (« Statut : ready », tableaux, listes).
L'orchestrateur devait l'interpréter puis recopier les constats dans
`review-<Tn>-<k>.md` : une étape de jugement là où il ne devrait y avoir qu'une
lecture, et des formats qui dérivent d'un run à l'autre. Un verdict `approve`
accompagné d'un constat majeur confirmé passait sans que rien ne le relève.

Par ailleurs, rien ne mesurait un run : ni la durée, ni le nombre d'appels d'agents,
ni les tokens, ni les livrables refusés. Impossible de savoir si une modification de
la configuration rend l'équipe plus rapide ou plus fiable.

## Décision

- **Un livrable = le dernier bloc ```json du message final, rien après.** Schémas
  communs et par agent dans `skills/team/deliverables.md` ; validation dans
  `scripts/deliverable.mjs` (`extractDeliverable`, `validateDeliverable`), y compris
  la cohérence (`needs_input` ⇒ question, implementer `ready` ⇒ fichiers et preuves,
  `approve` ⇒ aucun constat critical/major confirmé). La prose avant le bloc reste
  pour l'humain. Les constats de relecture, de commentaires de PR et de CI partagent
  un seul format.
- **Hook SubagentStop `check-deliverable`** (matcher sur les trois agents ; le script
  revérifie `agent_type`). Livrable invalide → `decision: block` avec les erreurs :
  l'agent corrige sans repasser par l'orchestrateur. Une seule relance
  (`stop_hook_active`) ; au second échec l'agent s'arrête et le rejet est mesuré.
  Entrée illisible → on laisse s'arrêter : exception assumée au principe d'échec
  fermé, car un hook d'arrêt qui bloque sans condition boucle.
- **Le hook enregistre, l'orchestrateur décide.** Un livrable valide d'un run
  existant est copié dans `deliverables/<NNN>-<agent>[-<tâche>].json` et, pour le
  relecteur, dans `review-<Tn>-<k>.json`. Le hook n'écrit jamais `state.json` : les
  transitions restent à l'orchestrateur, contrôlées par `check-state`.
- **Mesures par hooks, jamais bloquants** : `record-metrics` (PostToolUse sur
  `Agent|Task`, et Stop) ajoute des lignes à `metrics.jsonl` à partir de
  `tool_response` (`totalDurationMs`, `totalToolUseCount`, `totalTokens`). La tâche
  est lue dans la `description` de l'appel (`"<agent> <Tn|spec|plan|consult|split>
  #<k>"`). `scripts/metrics.mjs` agrège (durée murale, tours, par agent, par tâche).
- `deliverable.mjs` reste utilisable en CLI : repli si le hook ne se déclenche pas
  (version de Claude Code, hooks désactivés).

## Alternatives écartées

- **Sortie structurée imposée par l'API** : nous ne l'avons pas trouvée dans la
  définition des sous-agents de Claude Code ; le bloc final validé par hook en donne
  l'essentiel. À reconsidérer si elle apparaît.
- **Livrable écrit dans un fichier par l'agent** : planner et relecteur sont en
  lecture seule, et l'implementer n'a pas le droit d'écrire dans `.agent-runs/`.
- **Valider dans l'orchestrateur (prompt)** : c'est une règle qui doit toujours
  s'appliquer, donc un hook (voir `which-surface`).

## Conséquences

- Les agents gagnent un contrat explicite ; un oubli du bloc coûte une relance, pas
  un run.
- `review-<Tn>-<k>.md` devient `review-<Tn>-<k>.json`, écrit par le hook ; le
  workflow de l'orchestrateur doit lire ces fichiers au lieu de recopier le rapport.
- Ajouter un agent à l'équipe impose d'ajouter son schéma (voir `docs/ADD_AGENT.md`).
- Le coût en dollars n'est pas mesuré par le hook (absent de `tool_response`) ; le
  banc d'essai le relève via `total_cost_usd` de `claude -p`.
- Limite : le hook ne voit que le message final. Un agent peut produire un bloc
  conforme mais faux ; la véracité reste vérifiée par les scripts (`run-checks`,
  `check-scope`) et la relecture.
