---
name: team-init
description: Adapte l'équipe d'agents au projet courant - découvre la branche de base, la convention de commit et les commandes de validation (format, lint, types, tests, build), les fait valider par l'utilisateur et les enregistre dans .claude/team.json ; génère les conventions back-end et front-end lues par les implementers spécialisés, et désactive un spécialiste sans objet. À lancer une fois après l'installation, puis quand les outils du projet changent.
disable-model-invocation: true
---

Tu adaptes l'équipe d'agents à ce projet. Tu **découvres** ; tu ne supposes rien. Tu
ne modifies que `.claude/team.json` et les skills de conventions
(`.claude/skills/conventions-backend/SKILL.md`, `.claude/skills/conventions-frontend/SKILL.md`),
et seulement après validation.

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

Propose enfin les réglages facultatifs, en partant des valeurs actuelles de
`team.json` (une clé absente garde le défaut des scripts) :

| Clé               | Défaut                                 | Quand la changer                                                                 |
| ----------------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| `ci`              | `enabled: true`, `timeoutMinutes: 30`, `maxFixRounds: 2` | `enabled: false` sans GitHub Actions (aucun `.github/workflows/`) ou sans `gh` ; `timeoutMinutes` d'après la durée réelle de la CI |
| `prComments`      | `allowedAssociations: ["OWNER", "MEMBER", "COLLABORATOR"]` | Ajouter `CONTRIBUTOR` seulement si les contributeurs externes sont de confiance |
| `escalationModel` | `"opus"`                               | Modèle utilisé quand une tâche échoue avec le modèle par défaut                   |
| `sensitivePaths`  | `[]`                                   | Motifs (`*`, `**`, `?`) de zones sensibles propres au projet ; ils s'ajoutent aux zones déjà sensibles (dépendances, migrations, CI, auth, secrets), sans jamais en retirer |
| `lessons`         | `enabled: true`, `maxEntries: 30`      | `enabled: false` pour ne pas garder de leçons entre les runs                      |
| `backlog`         | `label: "agent-ready"`, `draftPr: false`, `maxIssues: 3`, `maxBudgetUsd: 5` | Traitement planifié des issues ; `draftPr: true` autorise l'ouverture de PR brouillons |

Pour `ci`, vérifie que `gh auth status` réussit ; sinon propose `enabled: false` ou
dis comment authentifier `gh`. `parallel` est réservé : laisse `enabled: false`.

## 4. Conventions des implementers spécialisés

`implementer-backend` et `implementer-frontend` préchargent chacun une skill de
conventions **propre au projet** (créée par l'installation, jamais remplacée ensuite).
Pour chaque côté :

1. **Le projet a-t-il ce côté ?** Serveur (routes, contrôleurs, services, accès aux
   données, migrations) ; interface (composants, pages, styles, `package.json` d'une
   application web ou mobile). Un côté absent → propose `agents.<nom>: false` dans
   `team.json` (les tâches iront à `implementer`). Pareil pour `documentation` si
   l'utilisateur ne veut pas de tâche de documentation dédiée.
2. **Sinon, lis le code** et rédige la skill, courte (≤ 80 lignes), à partir de ce que
   tu as **vu**, chaque point avec le fichier qui le montre :
   - framework et versions (manifeste de dépendances) ;
   - arborescence : où vivent les fichiers de ce côté (dossiers, motifs de chemin) —
     c'est aussi ce que le planner lit pour router les tâches ;
   - commandes : lancer, tester un fichier, lint, types (celles de `checks`) ;
   - style : nommage, gestion des erreurs, journalisation, imports ; back : validation
     des entrées, accès aux données ; front : design system, état, i18n, accessibilité ;
   - tests : outil, emplacement, nommage, doublures, données de test ;
   - **fichiers modèles à imiter** : deux ou trois fichiers représentatifs (un module,
     son test).
3. Garde le frontmatter (`name`, `description`, `user-invocable: false`), sans
   `disable-model-invocation` (la skill doit rester préchargeable). Rien d'inventé :
   ce que le code ne montre pas, écris-le comme inconnu.
4. Montre le contenu proposé et fais-le valider (ou corriger) avant de l'écrire. Une
   skill déjà remplie : propose seulement les différences.

## 5. Enregistrer

Après un accord explicite, écris les skills de conventions validées et mets à jour
`.claude/team.json` :

```json
{
  "initialized": true,
  "baseBranch": "main",
  "commitConvention": "Conventional Commits (feat:, fix:…)",
  "autonomy": "supervised",
  "agents": { "implementer-frontend": false },
  "checks": [
    { "name": "lint", "command": "ruff check .", "required": true },
    { "name": "tests", "command": "pytest", "required": true }
  ]
}
```

N'écris que les clés validées par l'utilisateur ; conserve les autres clés existantes
(`maxAttempts`, `pullRequest`, `ci`…) ; dans `agents`, ne change que les agents
validés. Termine par un rappel : `team.json` et les skills de conventions
appartiennent au projet et peuvent être commités ; `.agent-runs/` est ignoré par Git.
