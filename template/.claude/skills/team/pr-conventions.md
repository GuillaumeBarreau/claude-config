# Conventions de PR

Référence de l'orchestrateur `/team` pour préparer une livraison. Les valeurs
réglables sont dans `.claude/team.json` → `pullRequest`. Ce qui est vérifiable l'est
par `scripts/check-pr.mjs` (contenu de `pr.md`) et par le hook `guard-bash` (actions
Git et `gh`).

## Une PR = un run

- Une PR par run, depuis la branche `<branchPrefix><id>` vers `baseBranch`. Jamais de
  PR depuis la branche de base, jamais deux runs dans une même branche.
- Un commit par tâche, au format de `commitConvention`, avec l'id de la tâche :
  `feat: export CSV des sessions (T1)`. Pas de commit « wip » ni « fix review » : une
  correction demandée par la relecture est intégrée avant le commit de la tâche.
- Après le push, pas de réécriture d'historique (`--force`, `rebase`, `--amend`) sans
  accord : un relecteur humain a peut-être déjà commencé.

## Titre

- Première ligne de `pr.md` : `# <titre>`, **72 caractères au plus**.
- Même format que les commits du projet (`commitConvention`) ; si `titlePattern` est
  défini, le titre doit correspondre à cette expression régulière.
- Impératif ou nominal, décrit le résultat pour l'utilisateur, pas la méthode :
  `fix: l'export ne plante plus sur une liste vide`, pas `fix: ajout d'un if`.

## Corps

D'après [le modèle](templates/pr.md). Sections obligatoires : **Résumé**,
**Changements**, **Vérification**, **Risques et migrations**, **À vérifier par
l'humain**. « Décisions techniques » est facultative.

- **Résumé** : le problème et ce qui change, en deux ou trois phrases. La demande vient
  d'une issue → `Closes #<n>`.
- **Vérification** : une ligne par contrôle du run, avec **le statut que `state.json`
  a enregistré** (`passed`, `failed`, `not_run`, `n/a`), jamais un statut déduit. Puis
  chaque critère d'acceptation et ce qui le prouve (test, chemin).
- **Risques et migrations** : « Aucun » est une réponse ; sinon la procédure de retour
  arrière.
- **À vérifier par l'humain** : ce que les agents n'ont pas pu vérifier (rendu visuel,
  comportement en production, choix produit). Jamais vide de sens : si tout a été
  vérifié, dis-le.
- Aucun texte du modèle laissé entre chevrons, aucun secret, aucune donnée
  personnelle, pas de journaux complets (le run les garde).

## Taille

Au-delà de `maxChangedLines` (défaut 400) lignes modifiées, la PR devient difficile à
relire : `check-pr` avertit. Justifie la taille dans le résumé, ou propose de découper
le run (une PR par groupe de tâches).

## Création et fusion

- Toujours après l'accord explicite de l'utilisateur (porte 4).
- `node .claude/skills/team/scripts/check-pr.mjs .agent-runs/<id>` doit réussir ; il
  écrit `pr-body.md`.
- Puis :
  `gh pr create --base <baseBranch> --head <branch> --title "<titre>" --body-file .agent-runs/<id>/pr-body.md`,
  avec `--draft` si `pullRequest.draft` vaut `true` (défaut) et un `--label` par
  entrée de `pullRequest.labels`.
- **Un agent ne fusionne jamais une PR**, ni n'active l'auto-merge : `guard-bash`
  refuse `gh pr merge`. Passer la PR de brouillon à prête (`gh pr ready`) demande un
  accord.
