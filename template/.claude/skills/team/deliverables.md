# Livrables structurés des agents

Chaque agent de l'équipe (`planner`, les développeurs, `code-reviewer`, `analyste`)
**termine** son message final par un bloc ```json, **sans aucun texte après**. Ce bloc
est la seule partie que l'orchestrateur et les scripts lisent ; la prose qui précède
sert à l'utilisateur.

Le hook `check-deliverable` (SubagentStop) valide ce bloc. S'il est absent ou
invalide, l'agent est renvoyé une fois au travail avec la liste des erreurs. Un
livrable valide d'un run existant est copié dans `.agent-runs/<id>/deliverables/`
et, pour le relecteur, dans `review-<Tn>-<k>.json` (`review-<k>.json` sans tâche).
Vérification manuelle (repli) :
`node .claude/skills/team/scripts/deliverable.mjs <fichier> --agent <type>`.

## Champs communs

| Champ       | Valeur                                                                 |
| ----------- | ---------------------------------------------------------------------- |
| `agent`     | ton nom d'agent : `planner`, `implementer`, `implementer-backend`, `implementer-frontend`, `documentation`, `code-reviewer` ou `analyste` |
| `run`       | id du run (`.agent-runs/<id>/`), ou `null` hors run                    |
| `status`    | `ready`, `blocked` ou `needs_input`                                    |
| `questions` | `[{ "kind": "technical" \| "product", "text": "…" }]`, liste vide sinon |

- `needs_input` ⇒ au moins une question.
- `technical` : une question que le code ou le `planner` peut trancher (choix
  d'implémentation, contrat d'interface). `product` : une règle métier ou un
  arbitrage que seul l'utilisateur peut donner.
- `blocked` : la raison va dans la prose et, si elle appelle une réponse, dans
  `questions`.

## planner

| Champ                | Quand                                  | Valeur                                         |
| -------------------- | -------------------------------------- | ---------------------------------------------- |
| `mode`               | toujours                               | `spec`, `plan`, `spec+plan`, `consult`, `split` |
| `acceptanceCriteria` | `spec`, `spec+plan` avec `ready`       | `["AC1", "AC2"]` (ceux de `spec.md`)            |
| `taskIds`            | `plan`, `spec+plan` avec `ready`       | `["T1", "T2"]` (ceux du bloc des tâches)        |
| `answer`             | `consult` avec `ready`                 | `{ "decision", "rationale", "constraints": [] }` |
| `replaces`, `tasks`  | `split` avec `ready`                   | tâche remplacée et nouvelles tâches (format du bloc des tâches de `plan.md`, ids `T3.1`, `T3.2`…) |

```json
{
  "agent": "planner",
  "run": "2026-10-18-export-csv",
  "status": "ready",
  "questions": [],
  "mode": "spec+plan",
  "acceptanceCriteria": ["AC1", "AC2"],
  "taskIds": ["T1"]
}
```

## implementer

Schéma commun aux **développeurs** : `implementer`, `implementer-backend`,
`implementer-frontend` et `documentation` ; seul `agent` change (le tien).

| Champ        | Valeur                                                                         |
| ------------ | ------------------------------------------------------------------------------ |
| `task`       | id de la tâche (`T1`…)                                                         |
| `files`      | `[{ "path", "change" }]` : fichiers modifiés ; non vide si `ready`              |
| `acceptance` | `[{ "id": "AC1", "status": "covered" \| "not_covered" \| "not_verifiable", "evidence": "test/x.test.js:12" }]` |
| `evidence`   | `[{ "command", "result" }]` : commandes lancées, résultat réel ; non vide si `ready` |
| `deviations` | `[{ "path", "reason" }]` : écarts au plan (fichier hors plan…), liste vide sinon |

```json
{
  "agent": "implementer",
  "run": "2026-10-18-export-csv",
  "status": "ready",
  "questions": [],
  "task": "T1",
  "files": [{ "path": "src/export.js", "change": "ajout de toCsv()" }],
  "acceptance": [{ "id": "AC1", "status": "covered", "evidence": "test/export.test.js:8" }],
  "evidence": [{ "command": "npm test", "result": "1 échec (attendu) puis 14 passed" }],
  "deviations": []
}
```

## code-reviewer

| Champ        | Valeur                                                                 |
| ------------ | ---------------------------------------------------------------------- |
| `task`       | id de la tâche relue, ou `null` (piste quick, relecture hors run)      |
| `verdict`    | `approve`, `changes_requested` ou `blocked`                            |
| `findings`   | constats (format ci-dessous), du plus grave au moins grave             |
| `acceptance` | même format que pour `implementer`                                     |
| `checks`     | `[{ "command", "result" }]` : contrôles exécutés et résultat réel       |

Cohérence : `approve` ⇒ aucun constat `critical` ou `major` **confirmé** ;
`changes_requested` ⇒ au moins un.

```json
{
  "agent": "code-reviewer",
  "run": "2026-10-18-export-csv",
  "status": "ready",
  "questions": [],
  "task": "T1",
  "verdict": "changes_requested",
  "findings": [
    {
      "id": "F1",
      "severity": "major",
      "file": "src/export.js",
      "line": 42,
      "problem": "Les virgules dans un champ ne sont pas échappées.",
      "scenario": "toCsv([{ nom: 'Dupont, Jean' }]) produit trois colonnes au lieu de deux.",
      "fix": "Entourer de guillemets les champs contenant , \" ou un saut de ligne.",
      "confidence": "confirmed",
      "source": "review"
    }
  ],
  "acceptance": [{ "id": "AC1", "status": "not_covered", "evidence": "aucun test avec virgule" }],
  "checks": [{ "command": "npm test", "result": "14 passed" }]
}
```

## Constat

| Champ        | Valeur                                                              |
| ------------ | ------------------------------------------------------------------- |
| `id`         | `F1`, `F2`… (unique dans le livrable)                               |
| `severity`   | `critical`, `major` ou `minor`                                      |
| `file`       | chemin relatif à la racine du projet                                |
| `line`       | entier > 0, ou `null`                                               |
| `problem`    | une ou deux phrases                                                 |
| `scenario`   | l'entrée ou l'état qui le déclenche, et ce qui se passe             |
| `fix`        | le plus petit changement qui règle le problème                      |
| `confidence` | `confirmed` (tracé ou reproduit) ou `plausible`                     |
| `source`     | `review` (relecture), `pr-comment` (commentaire de PR), `ci`        |
| `url`        | facultatif : lien vers le commentaire ou le job de CI               |

Les constats des commentaires de PR (`pr-comments-<k>.json`) et de la CI suivent le
même format : le développeur les lit tels quels.

## analyste

| Champ      | Valeur                                                                 |
| ---------- | ---------------------------------------------------------------------- |
| `mode`     | `audit` ou `targeted`                                                  |
| `scope`    | chemin ou aspect ciblé (texte non vide en mode `targeted`, `null` sinon) |
| `focus`    | `security`, `debt`, `features`, `performance`, `architecture` ou `all` |
| `findings` | constats (format ci-dessous), du plus grave au moins grave             |
| `summary`  | résumé en une à trois phrases                                          |

Cohérence : chaque constat porte un `type`, un `issueTitle` et un `issueBody` en plus
des champs du format constat commun. Le champ `source` vaut toujours `review`.

```json
{
  "agent": "analyste",
  "run": null,
  "status": "ready",
  "questions": [],
  "mode": "audit",
  "scope": null,
  "focus": "all",
  "findings": [
    {
      "id": "F1",
      "severity": "major",
      "type": "security",
      "file": "src/auth.js",
      "line": 18,
      "problem": "Le token JWT n'est pas vérifié côté serveur.",
      "scenario": "Un token expiré ou forgé donne accès à toutes les routes protégées.",
      "fix": "Ajouter la vérification de signature et d'expiration dans le middleware auth.",
      "confidence": "confirmed",
      "source": "review",
      "issueTitle": "Vérifier le token JWT côté serveur",
      "issueBody": "## Objectif\n\nSécuriser les routes protégées en vérifiant la signature et l'expiration du token JWT dans le middleware auth.\n\n## Comportement attendu ou critères\n\n- Le middleware rejette un token expiré (401).\n- Le middleware rejette un token avec une signature invalide (401).\n\n## Hors périmètre\n\n- Renouvellement automatique du token."
    }
  ],
  "summary": "1 constat majeur de sécurité : le token JWT n'est pas vérifié côté serveur."
}
