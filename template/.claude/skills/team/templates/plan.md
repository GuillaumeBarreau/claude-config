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

Recopié par l'orchestrateur dans `state.json` (`tasks`). Valeurs possibles :
`type` ∈ feature, bug, refactoring, test, documentation, infrastructure ;
`priority` ∈ P0, P1, P2 ; `complexity` ∈ S, M, L.

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
    "agent": "implementer",
    "tests": ["…"],
    "risks": [],
    "requiresHuman": false,
    "status": "draft",
    "attempts": 0,
    "validation": { "checks": "not_run", "review": null, "evidence": [] }
  }
]
```
