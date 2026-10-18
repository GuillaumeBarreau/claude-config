---
name: team-init
description: Adapte l'équipe d'agents au projet courant - découvre la branche de base, la convention de commit et les commandes de validation (format, lint, types, tests, build), les fait valider par l'utilisateur et les enregistre dans .claude/team.json. À lancer une fois après l'installation, puis quand les outils du projet changent.
disable-model-invocation: true
---

Tu adaptes l'équipe d'agents à ce projet. Tu **découvres** ; tu ne supposes rien. Le
seul fichier que tu modifies est `.claude/team.json`, et seulement après validation.

Lis d'abord [les règles communes](../team-rules/SKILL.md).

## 1. État actuel

- Lis `.claude/team.json` (valeurs actuelles, à conserver si l'utilisateur ne les
  change pas).
- Lis `CLAUDE.md`, `README*`, `CONTRIBUTING*` s'ils existent.

## 2. Découvrir

| Quoi                  | Où regarder                                                                             |
| --------------------- | --------------------------------------------------------------------------------------- |
| Branche de base       | `git symbolic-ref --short refs/remotes/origin/HEAD`, sinon `main` / `master` existante  |
| Convention de commit  | `git log --oneline -20`, `CONTRIBUTING*`, configuration commitlint                      |
| Commandes de contrôle | Scripts de `package.json`, `pyproject.toml` (ruff, black, mypy, pytest), `Makefile`, `Cargo.toml`, `justfile`, `tox.ini`, `noxfile.py`, `.pre-commit-config.yaml` |
| Ce que la CI exécute  | `.github/workflows/*.yml`, `.gitlab-ci.yml` — c'est la meilleure source des contrôles obligatoires |

Pour chaque contrôle trouvé : nom court (`format`, `lint`, `types`, `tests`,
`build`…), commande exacte **lancée depuis la racine**, et proposition
obligatoire / facultatif. Un contrôle exécuté par la CI est obligatoire par défaut.
Préfère les commandes de vérification (`--check`) à celles qui réécrivent les
fichiers.

N'exécute aucune commande d'installation (`npm install`, `pip install`…). Si un
outil semble absent, dis-le.

## 3. Faire valider

Présente un tableau : nom, commande, obligatoire, source (fichier où tu l'as trouvée).
Ajoute la branche de base et la convention de commit. Propose d'exécuter chaque
contrôle une fois pour vérifier qu'il fonctionne, et rapporte les résultats réels.

Propose aussi les conventions de PR (`pullRequest`) : `titlePattern` déduit de la
convention de commit (par exemple `^(feat|fix|docs|refactor|test|chore)((.+))?: `
pour Conventional Commits), PR en brouillon (`draft`), `maxChangedLines`, `labels`.

Demande aussi le niveau d'autonomie (`autonomy`) : `supervised` (défaut, l'utilisateur
valide chaque plan) ou `autonomous` (l'orchestrateur valide seul les plans sans
tâche sensible ; la livraison reste toujours humaine).

## 4. Enregistrer

Après un accord explicite, mets à jour `.claude/team.json` :

```json
{
  "initialized": true,
  "baseBranch": "main",
  "commitConvention": "Conventional Commits (feat:, fix:…)",
  "autonomy": "supervised",
  "checks": [
    { "name": "lint", "command": "ruff check .", "required": true },
    { "name": "tests", "command": "pytest", "required": true }
  ]
}
```

Conserve les autres clés existantes (`agents`, `maxAttempts`…). Termine par un rappel :
`team.json` appartient au projet et peut être commité ; `.agent-runs/` est ignoré
par Git.
