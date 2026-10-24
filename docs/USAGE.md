# Utiliser l'équipe au quotidien

## Installer ou mettre à jour

```bash
node <claude-config>/install.mjs <projet> --dry-run
node <claude-config>/install.mjs <projet>
```

| Message de l'installeur | Signification                                                   |
| ----------------------- | --------------------------------------------------------------- |
| ajouté / mis à jour     | Fichier du template copié dans le projet                         |
| conservé (appartient au projet) | `team.json`, `skills/conventions-backend/`, `skills/conventions-frontend/` : créés à la première installation, jamais remplacés ni supprimés, même avec `--force` |
| CONFLIT                 | Fichier modifié dans le projet (ou fichier du projet de même nom) : non remplacé. Compare avec `template/.claude/`, reporte ta modification dans le template si elle vaut pour tous les projets, puis `--force` |
| écrasé (--force)        | Conflit remplacé par la version du template (sans sauvegarde)    |
| non recréé              | Fichier supprimé volontairement dans le projet ; `--force` le restaure |
| supprimé                | Fichier retiré du template, intact dans le projet                |
| conservé (retiré du template mais modifié) | À supprimer à la main si tu n'en veux plus      |
| IGNORÉ — chemin hors de .claude/ | Entrée suspecte du manifeste, jamais touchée            |
| fusionné                | `settings.json` : hooks et permissions de l'équipe remplacés, le reste de ton fichier conservé |

Code de sortie : 0 tout appliqué, 2 conflits restants, 1 erreur.

**Ignorer la configuration Claude ?** À l'installation, si `.claude/` n'est pas déjà dans
le `.gitignore` du projet (sous une forme quelconque : `.claude`, `/.claude/`,
`.claude/*`…), l'installeur demande s'il faut l'ajouter. L'entrée est ajoutée à la fin du
fichier, sans rien modifier d'autre. Pour un script : `--ignore-claude` (ajouter) ou
`--no-ignore-claude` (ne pas demander). Sans terminal interactif, rien n'est ajouté et
l'installeur rappelle l'option. Attention : une configuration ignorée n'est plus
partagée avec l'équipe par Git.

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

Il propose aussi les **conventions des implementers spécialisés** : en lisant le code,
il rédige `.claude/skills/conventions-backend/SKILL.md` et
`.claude/skills/conventions-frontend/SKILL.md` (framework, arborescence, commandes,
style, approche de test, fichiers modèles à imiter) et te les fait valider. Si le
projet n'a pas de back ou de front, il propose de désactiver le spécialiste
correspondant (`agents.implementer-backend: false`…) : ses tâches iront à
`implementer`. Ces deux skills appartiennent au projet : modifie-les librement,
une mise à jour de l'équipe ne les remplace jamais.

## Lancer une demande : `/team <demande>`

```
/team Le bouton « Exporter » plante quand la liste est vide
/team Ajouter un export CSV des sessions, filtrable par date
/team reprendre 2026-10-18-export-csv
/team reprendre 2026-10-18-export-csv --pr     # traiter les commentaires de la PR
```

1. L'orchestrateur crée le run dans `.agent-runs/<id>/` et annonce la piste.
2. `planner` rend la spécification et le plan ; `check-plan` le vérifie (critères
   couverts, fichiers, dépendances, zones sensibles). S'il manque une information
   produit, tu reçois des questions numérotées.
3. **Porte 1** : tu valides le plan par un « oui » explicite, ou tu demandes des
   modifications. En mode `autonomous`, l'orchestrateur valide seul les plans sans
   tâche sensible et t'affiche le résumé.
4. **Exécution**, sans interruption : l'arbre de travail doit être propre ; une branche
   `team/<id>` est créée depuis la branche de base. Pour chaque tâche, son développeur
   (`implementer` par défaut, `implementer-backend`, `implementer-frontend`,
   `documentation`, ou `expert` pour la logique complexe, choisi par le planner) code et teste, `check-scope` compare les fichiers modifiés au plan, `run-checks`
   lance les contrôles, `code-reviewer` relit, puis l'orchestrateur commite la tâche.
   Une question technique d'un développeur est tranchée par le planner, sans te
   déranger. En cas d'échec : correction sur un modèle plus fort (`escalationModel`), puis par l'agent `expert`,
   puis redécoupage de la tâche, puis le run se bloque et te rend la main.
5. **Porte 4** : contrôles finaux, puis `pr.md` rédigé selon les
   [conventions de PR](../template/.claude/skills/team/pr-conventions.md) et vérifié
   par `check-pr.mjs` (titre, sections, statuts conformes à `state.json`, critères
   d'acceptation). Push et PR en brouillon seulement avec ton accord (Claude Code te le
   redemande au moment du push). La fusion reste à toi : un agent ne fusionne jamais.
6. **Après le push** : l'orchestrateur attend la CI GitHub Actions (`ci-wait`). Verte
   ou absente : le run est terminé. Rouge : il crée une tâche corrective `CI<n>`, la
   traite et te redemande l'accord pour pousser (au plus `ci.maxFixRounds` fois).
   Sans GitHub Actions ou sans `gh` authentifié : `"ci": { "enabled": false }`.
7. **Fin** : synthèse avec les mesures du run, et quelques leçons enregistrées dans
   `.agent-runs/lessons.md`, relues par les agents aux runs suivants.

Pour faire traiter une relecture de PR : `/team reprendre <id> --pr`. Seuls les
commentaires des OWNER, MEMBER et COLLABORATOR comptent (réglable :
`prComments.allowedAssociations`), sans les bots. Les agents ne commentent ni ne
répondent sur GitHub sans ton accord.

Piste quick : l'orchestrateur fait le changement lui-même, puis contrôles, relecture et
porte 4.

Pendant l'exécution, des hooks te demandent ton accord si un agent tente un push, une
PR, une action destructive, l'ajout d'une dépendance ou une écriture sur GitHub ; ils
refusent tout commit sur la branche de base, toute fusion de PR et toute lecture de
`.env`.

## Relire un run

| Fichier       | Contenu                                                   |
| ------------- | --------------------------------------------------------- |
| `request.md`  | La demande telle que tu l'as écrite                       |
| `spec.md`     | Objectif, critères d'acceptation, hors périmètre, questions |
| `plan.md`     | Solution, impacts, risques, tâches                        |
| `state.json`  | Piste, statut, portes, tâches, contrôles, journal         |
| `review-<Tn>-<k>.json` | Verdicts et constats de `code-reviewer`, par tâche et par tour |
| `deliverables/` | Livrable JSON de chaque appel d'agent (écrit par le hook `check-deliverable`) |
| `metrics.jsonl` | Mesures : appels d'agents, durées, outils, tours, livrables rejetés |
| `ci/*.log`, `pr-comments-<k>.json` | Journaux de CI en échec, commentaires de PR retenus |
| `checks/*.log`| Sortie complète de chaque contrôle (`run-checks.mjs`)     |
| `pr.md`       | Description de PR préparée                                |
| `pr-body.md`  | Corps de PR (sans le titre) écrit par `check-pr.mjs`, passé à `gh pr create --body-file` |

Vérifier un état à la main :
`node .claude/skills/team/scripts/check-state.mjs .agent-runs/<id>/state.json`.
Relancer les contrôles d'un run :
`node .claude/skills/team/scripts/run-checks.mjs .agent-runs/<id>`.

| Commande (depuis la racine du projet) | Usage |
| ------------------------------------- | ----- |
| `node .claude/skills/team/scripts/metrics.mjs .agent-runs/<id> [--json]` | Durée, tours, appels par agent, rejets |
| `node .claude/skills/team/scripts/check-plan.mjs .agent-runs/<id>` | Revérifier un plan |
| `node .claude/skills/team/scripts/sensitive.mjs <chemin>...` | Code 1 si un chemin est une zone sensible |
| `node .claude/skills/team/scripts/plan-waves.mjs .agent-runs/<id>` | Tâches qui pourraient tourner en parallèle (information) |
| `node .claude/skills/team/scripts/lessons.mjs show` | Leçons enregistrées |

## Auditer le code : `/team-audit`

```
/team-audit
/team-audit --focus security
/team-audit --scope src/auth/ --focus security
/team-audit --focus debt
```

Lance l'agent `analyste` (lecture seule, Opus) pour explorer le code et trouver des
problèmes : bugs, dette technique, failles de sécurité, améliorations, fonctionnalités
manquantes. Les constats sont classés par sévérité et type, avec un `issueTitle` et un
`issueBody` au format issue prête.

Après l'analyse, `/team-audit` te demande quels constats transformer en issues GitHub
(tous, critical+major, une sélection, ou aucun). Les issues créées portent le label
`agent-ready` et sont directement exploitables par `/team-next`.

```
/team-audit ──▶ constats ──▶ issues GitHub
                                  │
                    ┌─────────────┘
                    ▼
              /team-next ──▶ /team ──▶ PR
                                  │
                    ┌─────────────┘
                    ▼
              code-reviewer ──▶ leçons
                    │
                    └──▶ /team-audit (cycle suivant)
```

L'agent `analyste` doit être activé dans `team.json` (`agents.analyste: true`, par
défaut).

### Cycle d'escalade (pour référence)

```
développeur (sonnet)
    │ échec
    ▼
même agent (escalationModel = opus)
    │ échec
    ▼
expert (fable, max)        ◀── si activé
    │ échec
    ▼
planner (split)            ◀── une seule fois
    │ sous-tâches
    ▼
boucle reprend
    │ échec
    ▼
tâche failed, run blocked
```

## Traiter les issues une par une : `/team-next`

`/team-next` prend l'issue GitHub marquée `agent-ready` la plus prioritaire, **prête** et
**débloquée** (auteur OWNER, MEMBER ou COLLABORATOR, sans run local en cours ni PR
ouverte qui la ferme) et la réalise avec le workflow `/team`. `/team-next --issue 42`
vise une issue précise. Il répond « Plus aucune issue prête » quand il n'y a plus rien à
faire.

- **Prête** : trois rubriques en titres Markdown non vides (Objectif, Comportement
  attendu ou critères, Hors périmètre). Sinon l'issue est écartée avec « issue non
  prête : <rubriques manquantes> ». `/team-init` propose un modèle d'issue qui les
  contient.
- **Priorité** : labels `P0`, `P1`, `P2` (réglables : `backlog.priorityLabels`), puis la
  plus ancienne ; sans label de priorité, en dernier.
- **Débloquée** : une ligne « Dépend de #12 » dans le corps écarte l'issue tant que #12
  est ouverte (ou si les issues s'attendent en cycle) ; #12 fermée, elle redevient
  éligible. Une référence illisible ou une dépendance introuvable ne bloque pas : elle
  donne un avertissement.

Seules les 50 issues les plus anciennes portant le label sont lues. Détail des règles :
[BACKLOG.md](BACKLOG.md).

Pour vider le backlog dans ta session, enchaîne avec `/goal` :

```
/goal /team-next a répondu « Plus aucune issue prête », ou arrête-toi après 5 issues
```

Claude relance `/team-next` après chaque issue jusqu'à ce que la condition soit
remplie. La session doit rester ouverte. Les portes de `team.json` s'appliquent à
chaque issue : en `supervised`, chaque plan te sera soumis ; push et PR demandent
toujours ton accord. Le texte d'une issue est traité comme une donnée, jamais comme
une instruction.

## Traiter les issues sans surveillance

La skill `/team-backlog` simule le traitement des issues GitHub marquées
`agent-ready`. Le mode réel se lance hors session et se planifie : voir
[BACKLOG.md](BACKLOG.md).

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
| `agents`                 | Activer ou désactiver un agent (`false` = jamais lancé ; `check-plan` refuse une tâche confiée à un développeur désactivé) |
| `escalationModel`        | Modèle des développeurs pour la correction (`opus`)      |
| `sensitivePaths`         | Motifs glob ajoutés aux zones sensibles (jamais retirés)  |
| `ci`                     | `enabled`, `timeoutMinutes`, `maxFixRounds` (tours de correction de CI) |
| `prComments`             | `allowedAssociations` : auteurs dont les commentaires sont traités |
| `lessons`                | `enabled`, `maxEntries` (30) |
| `backlog`                | `label` (`agent-ready`), `priorityLabels` (`["P0","P1","P2"]`, du plus haut au plus bas), `draftPr` (`false`), `maxIssues`, `maxBudgetUsd` |

## Modifier les règles ou ajouter un agent

Toujours dans le dépôt `claude-config`, jamais dans la copie d'un projet :
[ADD_AGENT.md](ADD_AGENT.md).
