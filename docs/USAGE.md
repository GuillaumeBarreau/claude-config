# Utiliser l'équipe au quotidien

## Installer ou mettre à jour

```bash
node <claude-config>/install.mjs <projet> --dry-run
node <claude-config>/install.mjs <projet>
```

| Message de l'installeur | Signification                                                   |
| ----------------------- | --------------------------------------------------------------- |
| ajouté / mis à jour     | Fichier du template copié dans le projet                         |
| conservé (appartient au projet) | `team.json` : jamais remplacé, même avec `--force`       |
| CONFLIT                 | Fichier modifié dans le projet (ou fichier du projet de même nom) : non remplacé. Compare avec `template/.claude/`, reporte ta modification dans le template si elle vaut pour tous les projets, puis `--force` |
| écrasé (--force)        | Conflit remplacé par la version du template (sans sauvegarde)    |
| non recréé              | Fichier supprimé volontairement dans le projet ; `--force` le restaure |
| supprimé                | Fichier retiré du template, intact dans le projet                |
| conservé (retiré du template mais modifié) | À supprimer à la main si tu n'en veux plus      |
| IGNORÉ — chemin hors de .claude/ | Entrée suspecte du manifeste, jamais touchée            |
| fusionné                | `settings.json` : hooks et permissions de l'équipe remplacés, le reste de ton fichier conservé |

Code de sortie : 0 tout appliqué, 2 conflits restants, 1 erreur.

`settings.json` n'est jamais copié par-dessus le tien : l'installeur retire les hooks
de l'équipe (ceux sous `.claude/hooks/team/`) et les permissions qu'il avait ajoutées,
puis remet ceux du template. Tes propres hooks, permissions et réglages restent. Un
`settings.json` illisible est signalé en conflit et laissé tel quel.

Faut-il commiter `.claude/` dans le projet ? Oui pour partager l'équipe et ses
garde-fous avec le projet (agents, skills, hooks, `settings.json`, `team.json`).
`.agent-runs/` est ignoré par Git.

## Première fois dans un projet : `/team-init`

Découvre la branche de base, la convention de commit et les commandes de contrôle (en
priorité celles de la CI), te les présente, propose de les exécuter une fois, puis les
enregistre dans `.claude/team.json` après ton accord.

## Lancer une demande : `/team <demande>`

```
/team Le bouton « Exporter » plante quand la liste est vide
/team Ajouter un export CSV des sessions, filtrable par date
/team reprendre 2026-10-18-export-csv
```

1. L'orchestrateur crée le run dans `.agent-runs/<id>/` et annonce la piste.
2. `planner` rend la spécification et le plan ; s'il manque une information, tu reçois
   des questions numérotées.
3. **Porte 1** : tu valides le plan par un « oui » explicite, ou tu demandes des
   modifications. En mode `autonomous`, l'orchestrateur valide seul les plans sans
   tâche sensible et t'affiche le résumé.
4. **Exécution**, sans interruption : l'arbre de travail doit être propre ; une branche
   `team/<id>` est créée depuis la branche de base. Pour chaque tâche, `implementer`
   code et teste, `run-checks.mjs` lance les contrôles, `code-reviewer` relit, puis
   l'orchestrateur commite la tâche. Contrôles en échec ou constats bloquants :
   correction, au plus `maxAttempts` fois, puis le run se bloque et te rend la main.
5. **Porte 4** : contrôles finaux, puis `pr.md` rédigé selon les
   [conventions de PR](../template/.claude/skills/team/pr-conventions.md) et vérifié
   par `check-pr.mjs` (titre, sections, statuts conformes à `state.json`, critères
   d'acceptation). Push et PR en brouillon seulement avec ton accord (Claude Code te le
   redemande au moment du push). La fusion reste à toi : un agent ne fusionne jamais.

Piste quick : l'orchestrateur fait le changement lui-même, puis contrôles, relecture et
porte 4.

Pendant l'exécution, des hooks te demandent ton accord si un agent tente un push, une
PR, une action destructive ou l'ajout d'une dépendance ; ils refusent tout commit sur
la branche de base et toute lecture de `.env`.

## Relire un run

| Fichier       | Contenu                                                   |
| ------------- | --------------------------------------------------------- |
| `request.md`  | La demande telle que tu l'as écrite                       |
| `spec.md`     | Objectif, critères d'acceptation, hors périmètre, questions |
| `plan.md`     | Solution, impacts, risques, tâches                        |
| `state.json`  | Piste, statut, portes, tâches, contrôles, journal         |
| `review-<Tn>-<k>.md` | Verdicts de `code-reviewer`, par tâche et par tour |
| `checks/*.log`| Sortie complète de chaque contrôle (`run-checks.mjs`)     |
| `pr.md`       | Description de PR préparée                                |
| `pr-body.md`  | Corps de PR (sans le titre) écrit par `check-pr.mjs`, passé à `gh pr create --body-file` |

Vérifier un état à la main :
`node .claude/skills/team/scripts/check-state.mjs .agent-runs/<id>/state.json`.
Relancer les contrôles d'un run :
`node .claude/skills/team/scripts/run-checks.mjs .agent-runs/<id>`.

## Régler le comportement

Dans `.claude/team.json` du projet :

| Clé                      | Effet                                                    |
| ------------------------ | -------------------------------------------------------- |
| `checks`                 | Contrôles (`name`, `command`, `required`)                |
| `autonomy`               | `supervised` (tu valides chaque plan) ou `autonomous` (l'orchestrateur valide seul les plans sans tâche sensible, hors piste full) |
| `baseBranch`             | Branche sur laquelle aucun agent ne commite (refus par hook) |
| `pullRequest`            | Conventions de PR : `draft` (brouillon, défaut `true`), `titlePattern` (expression régulière du titre), `maxChangedLines` (taille au-delà de laquelle `check-pr` avertit, 400), `labels` |
| `branchPrefix`           | Préfixe des branches de travail (`team/`)                |
| `maxAttempts`            | Tours de correction avant blocage (2)                    |
| `maxClarificationRounds` | Tours de questions avant blocage (2)                     |
| `agents`                 | Activer ou désactiver un agent (`false` = jamais lancé)  |

## Modifier les règles ou ajouter un agent

Toujours dans le dépôt `claude-config`, jamais dans la copie d'un projet :
[ADD_AGENT.md](ADD_AGENT.md).
