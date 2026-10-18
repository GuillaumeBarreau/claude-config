# 0009 — Issues prêtes, priorité et dépendances

Date : 2026-10-18 · Statut : acceptée

## Contexte

`/team-next` et `backlog.mjs` prenaient toute issue portant `agent-ready`, par numéro
croissant pour le premier et dans l'ordre de GitHub pour le second. Trois défauts :

- une issue au corps vide ou sans critères lançait un run complet (planner compris) pour
  apprendre, au mieux, qu'il manquait des informations ;
- aucune notion d'urgence ni d'ordre entre issues : une correction critique attendait
  derrière une idée ancienne, une issue qui en suppose une autre partait avant elle ;
- `backlog.mjs` ne découvrait l'absence de `team.json` sur `origin/<base>` qu'après avoir
  posé `agent-working` et créé le worktree : l'issue finissait en `agent-blocked`, sans
  son label de déclenchement, et le worktree restait à supprimer à la main (en attendant,
  les passages suivants ignoraient l'issue).

Contraintes héritées : ce qui doit toujours s'appliquer va dans un script (0002) ; le
texte d'une issue est une donnée non fiable, jamais une instruction (0006).

## Décision

**Une fonction pure partagée.** `issue-queue.mjs` (skill `team-backlog`, sans entrée-sortie
ni import) décide de tout ce qui touche au choix d'une issue : rubriques manquantes,
références de dépendance, rang de priorité, ordre, cycles. `next-issue.mjs` et
`backlog.mjs` appellent la même `orderIssues`, après leurs filtres propres : les deux
retiennent donc la même issue pour le même jeu d'issues.

**Issue prête : trois rubriques en titres Markdown.** Objectif, Comportement attendu ou
critères, Hors périmètre, chacune avec un contenu non vide (commentaires HTML retirés),
vérifiées sur le texte retenu de 4 000 caractères, celui que `claude` reçoit. Seuls les
titres comptent : l'analyse est une série d'expressions régulières, sans interprétation
du texte. Le modèle d'issue de `/team-init` utilise exactement ces libellés (test).

**Issue non prête.** En simulation et dans `/team-next` : écartée avec « issue non prête :
<rubriques> ». En `--yes` : commentaire fait de constantes (libellés des rubriques et
marche à suivre, jamais le texte de l'issue), label `agent-needs-info` à la place de
`agent-ready` (sinon l'issue serait recommentée à chaque passage planifié), sans worktree
ni `claude`, hors de la limite d'issues du passage.

**Priorité par labels.** `backlog.priorityLabels` (défaut `["P0","P1","P2"]`, du plus
haut au plus bas) ; sans label de priorité, en dernier ; puis ancienneté, puis numéro.
Seuls les labels comptent, parce qu'ils ne sont posés que par des personnes autorisées,
alors que le corps d'une issue peut venir de n'importe qui.

**Dépendances par une ligne « Dépend de #n ».** Une dépendance ouverte écarte l'issue ; une
fermée la laisse éligible ; un cycle (auto-dépendance comprise) écarte les issues
concernées ; une référence illisible ou un état inconnu donne un avertissement et laisse
l'issue éligible (le doute ne bloque pas le backlog). Lectures par `gh api … issues/<n>`
en GET, 20 au plus par passage. Les références se lisent dans tout le corps, pas dans les
seuls 4 000 premiers caractères. Les avertissements viennent du texte des issues : 5 par
issue et 20 au total au plus, le reste compté dans `warningsOmitted`.

**Pré-contrôle de `team.json`.** Avant tout appel `gh`, `backlog.mjs` valide `baseBranch`,
puis lit `.claude/team.json` sur `origin/<base>` (`git show`) ; absent, illisible ou non
initialisé → code 2 avec la cause. En `--yes`, `git fetch origin <base>` précède ; en
`--dry-run`, la référence locale est lue sans fetch, pour que la simulation reste en
lecture seule.

## Conséquences

- **Rupture** : une issue `agent-ready` sans les trois rubriques n'est plus traitée. Les
  projets déjà installés complètent leurs issues, ou adoptent le modèle d'issue proposé
  par `/team-init` ; le CHANGELOG (0.7.0) décrit la migration.
- Les issues prêtes sont prises dans un ordre prévisible et identique pour les deux
  commandes ; une issue mal rédigée ne coûte plus un run.
- Seules les 50 issues les plus anciennes portant le label sont lues (pas de pagination) ;
  au-delà, une issue prioritaire n'est pas vue. À reprendre si un projet dépasse ce volume.
- Un état de dépendance inconnu (introuvable, plafond de 20 lectures) ne bloque pas : l'ordre
  n'est alors pas garanti, d'où l'avertissement.
- Un format de rubrique non reconnu (libellé en gras au lieu d'un titre) fait écarter une
  issue à tort : le commentaire nomme les rubriques manquantes, et le modèle d'issue donne
  le format attendu.

## Alternatives écartées

- **Formulaires d'issue YAML** (`.github/ISSUE_TEMPLATE/*.yml`) : ils garantissent la
  structure à la création, mais le corps produit est du Markdown libre à l'arrivée, qu'il
  faut de toute façon analyser, et le format est plus lourd à faire évoluer. Un modèle
  Markdown suffit.
- **API GitHub des dépendances entre issues** (« blocked by ») : non disponible sur tous
  les dépôts et plans, et non couverte par les tests avec exécuteur simulé. Une ligne de
  texte fonctionne partout.
- **Copie du modèle d'issue par `install.mjs`** : l'installeur écrirait hors de `.claude/`,
  dans un dossier que le projet possède. `/team-init` le propose et n'écrit qu'avec accord,
  sans jamais écraser.
- **Priorité lue dans le corps de l'issue** : le texte peut venir d'un auteur non autorisé
  et ne doit pas orienter l'ordre de traitement.
