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

Code de sortie : 0 tout appliqué, 2 conflits restants, 1 erreur.

Faut-il commiter `.claude/` dans le projet ? Oui pour partager l'équipe avec le
projet (agents, skills, `team.json`). `.agent-runs/` est ignoré par Git.

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
   modifications.
4. Piste quick : changement, contrôles, relecture, puis préparation de la PR. Push et
   PR seulement si tu donnes ton accord.
   Pistes standard et full : le run s'arrête à `ready_for_execution` dans cette
   version (exécution par `implementer` à l'incrément 2).

## Relire un run

| Fichier       | Contenu                                                   |
| ------------- | --------------------------------------------------------- |
| `request.md`  | La demande telle que tu l'as écrite                       |
| `spec.md`     | Objectif, critères d'acceptation, hors périmètre, questions |
| `plan.md`     | Solution, impacts, risques, tâches                        |
| `state.json`  | Piste, statut, portes, tâches, contrôles, journal         |
| `review-N.md` | Verdicts de `code-reviewer`                               |
| `pr.md`       | Description de PR préparée                                |

Vérifier un état à la main :
`node .claude/skills/team/scripts/check-state.mjs .agent-runs/<id>/state.json`.

## Régler le comportement

Dans `.claude/team.json` du projet :

| Clé                      | Effet                                                    |
| ------------------------ | -------------------------------------------------------- |
| `checks`                 | Contrôles (`name`, `command`, `required`)                |
| `baseBranch`             | Branche sur laquelle aucun agent ne commite              |
| `branchPrefix`           | Préfixe des branches de travail (`team/`)                |
| `maxAttempts`            | Tours de correction avant blocage (2)                    |
| `maxClarificationRounds` | Tours de questions avant blocage (2)                     |
| `agents`                 | Activer ou désactiver un agent (`false` = jamais lancé)  |

## Modifier les règles ou ajouter un agent

Toujours dans le dépôt `claude-config`, jamais dans la copie d'un projet :
[ADD_AGENT.md](ADD_AGENT.md).
