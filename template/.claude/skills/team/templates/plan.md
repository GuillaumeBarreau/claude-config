# Plan technique — <titre>

Run : `<id>` · Spécification : `spec.md`

## Existant

<Ce que fait le code aujourd'hui, avec les fichiers lus : `chemin/fichier.ext:ligne`.>

## Solution

<L'approche retenue et pourquoi c'est la plus simple qui respecte l'architecture.
Alternatives écartées en une ligne chacune.>

## Impacts

| Domaine         | Impact                                  |
| --------------- | --------------------------------------- |
| API / contrats  | <aucun / description>                   |
| Données         | <aucun / migration…>                    |
| Dépendances     | <aucune / ajout, retrait — requiresHuman> |
| Configuration   | <aucune / description>                  |

## Contrats d'interface

<Signatures, formats d'échange, codes d'erreur — si plusieurs tâches en dépendent.>

## Risques et points de vigilance

- <Risque> → <mitigation>

## Tâches

| Id | Titre | Dépend de | AC couverts | Tests attendus |
| -- | ----- | --------- | ----------- | -------------- |
| T1 | …     | —         | AC1, AC2    | …              |

## Bloc des tâches

Recopié tel quel par l'orchestrateur dans `state.json` (`tasks`), puis vérifié par
`scripts/check-plan.mjs` (seul le dernier bloc `json` de cette section compte).
Valeurs possibles : `type` ∈ feature, bug, refactoring, test, documentation,
infrastructure ; `priority` ∈ P0, P1, P2 ; `complexity` ∈ S, M, L.

- `files` : fichiers **existants** que la tâche modifie ; `newFiles` : fichiers qu'elle
  crée. Tests compris. Chemins relatifs à la racine du projet, sans `..`, sans glob,
  sans `…` ni `<…>`.
- Chaque `AC` de `spec.md` est cité par au moins une tâche ; aucune tâche ne cite un
  `AC` inconnu.
- Fichier sensible (dépendances, migrations, CI, authentification et permissions,
  secrets, `.claude/`, motifs `sensitivePaths` de `team.json`) → `requiresHuman: true`.
- `origin` : `plan` pour les tâches de ce bloc.
- `agent` : le développeur qui réalise la tâche (routage ci-dessous) ; absent =
  `implementer`. `check-plan` refuse un agent inconnu ou désactivé dans `team.json`
  (`agents.<nom>: false`).

### Routage des tâches

Une tâche est confiée selon ses fichiers (`files` + `newFiles`, tests compris ; le
côté se lit dans l'arborescence et dans les skills `conventions-backend` /
`conventions-frontend` quand elles le précisent) :

| Fichiers de la tâche                                  | `agent`                |
| ----------------------------------------------------- | ---------------------- |
| tous côté serveur (API, services, données, jobs)      | `implementer-backend`  |
| tous côté interface (composants, pages, styles)       | `implementer-frontend` |
| uniquement de la documentation (README, docs/, CHANGELOG, ADR) | `documentation` |
| mixtes, outillage, configuration, ou doute            | `implementer`          |

Un spécialiste désactivé dans `team.json` est remplacé par `implementer`. Si le
changement modifie un comportement visible, une API ou la configuration, le plan
comprend une tâche `type: "documentation"` (agent `documentation` s'il est activé,
sinon `implementer`), qui dépend des tâches qu'elle documente.

```json
[
  {
    "id": "T1",
    "title": "…",
    "description": "…",
    "type": "feature",
    "priority": "P1",
    "complexity": "S",
    "acceptanceCriteria": ["AC1", "AC2"],
    "dependsOn": [],
    "files": ["src/…"],
    "newFiles": [],
    "origin": "plan",
    "agent": "implementer",
    "tests": ["…"],
    "risks": [],
    "requiresHuman": false,
    "status": "draft",
    "attempts": 0,
    "consultations": 0,
    "validation": { "checks": "not_run", "review": null, "evidence": [] }
  }
]
```
