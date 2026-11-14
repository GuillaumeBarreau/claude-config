# Déroulé détaillé d'une revue de PR

Complément de [SKILL.md](SKILL.md) : le magasin, les règles de profondeur, les
commandes de triage, les codes de sortie et ce qui est prévu mais pas encore fait.

## Le magasin `.agent-reviews/pr-<n>/`

À la racine du projet, ignoré par Git, **personnel** (jamais partagé ni commité).

| Fichier                             | Écrit par          | Contenu                                           |
| ----------------------------------- | ------------------ | ------------------------------------------------- |
| `review.json`                       | les scripts        | rounds, constats, décisions, publications, journal |
| `rounds/<k>/pr.json`                | `pr-fetch`         | métadonnées, CI, commentaires existants (données) |
| `rounds/<k>/diff.patch`             | `pr-fetch`         | diff unifié de la PR                              |
| `rounds/<k>/scope.json`             | `pr-fetch`         | fichiers par axe, nombre de lignes modifiées      |
| `rounds/<k>/deliverables/`          | hook `check-deliverable` | livrables des agents                        |
| `rounds/<k>/verify-input.json`      | `findings`         | constats à contre-vérifier, sans le raisonnement  |
| `rounds/<k>/publish-payload.json`   | `publish`          | charge utile envoyée (ou prévue en `--dry-run`)   |
| `worktree/`                         | `pr-fetch --worktree` | worktree Git jetable au commit de tête (retiré par `source.mjs --remove-worktree`) |
| `fixes.md`                          | `publish` (mode `fixes`) | liste de corrections                        |
| `publications.jsonl`                | `publish`          | une ligne par constat publié (brouillon et texte final) |
| `../calibration.json`               | `stats`            | faux positifs passés, par agent                   |

Tu n'écris **jamais** `review.json` à la main : les décisions passent par
`decisions.mjs` ou le rapport local. Un **round** correspond à un commit de tête de la
PR ; `pr-fetch` en ouvre un nouveau seulement quand ce commit change.

## Lire le code de la PR (`source` du round)

Le diff ne suffit pas : les agents lisent le code autour de chaque changement. Pour que
ce soit **celui de la PR** et pas celui de la branche où se trouve l'utilisateur,
`pr-fetch` choisit une source, l'enregistre dans `rounds[k].source` (`review.json`) et
dans `pr.json` (`{ mode, headSha, path }`), et l'orchestrateur la rappelle aux quatre
agents. Aucun mode ne fait de `checkout`, `switch`, `reset` ni `stash` dans la copie de
travail de l'utilisateur.

| `mode`         | Quand                                        | Ce que les agents lisent |
| -------------- | -------------------------------------------- | ------------------------ |
| `working-tree` | `git rev-parse HEAD` = commit de tête de la PR | la copie de travail (`path` = racine du projet), normalement. Des modifications non commitées (`git status --porcelain`) sont signalées à l'utilisateur : les agents les liront |
| `git-show`     | défaut, sinon                                | les fichiers de la PR avec `git show <headSha>:<chemin>` et `git grep -n <motif> <headSha> -- <chemins>`, jamais avec `Read` ; les autres fichiers dans la copie de travail, donc dans la version de la branche courante — à dire dans `notReviewed` ou `evidence` (`reason` pour le vérificateur) quand un constat en dépend ; `findings.mjs` le rappelle dans son résumé |
| `worktree`     | option `--worktree`                          | uniquement `path` = `.agent-reviews/pr-<n>/worktree/`, worktree détaché sur le commit de tête, pour tout le code |

Commandes de `pr-fetch` (aucune ne demande d'accord à `guard-bash`) :
- `git rev-parse HEAD`, puis en `working-tree` : `git status --porcelain` ;
- sinon `git fetch --no-tags --quiet origin +refs/pull/<n>/head:refs/claude-config/pr-<n>`
  (marche pour une PR venue d'un fork ; la référence est hors `refs/heads`, donc
  invisible pour `git branch`, et garde le commit du nettoyage de Git), puis
  `git cat-file -e <headSha>^{commit}` ; échec → sortie 2, rien n'est écrit ;
- `--worktree` : `git worktree add --detach <path> <headSha>`, précédé de
  `git worktree remove --force <path>` et `git worktree prune` si un ancien worktree de
  la PR existe. Un nouveau round le recrée sur le nouveau commit ; un round à jour le
  recrée s'il manque et le garde s'il est déjà sur le commit. Pas de `npm install`
  dedans.

Le worktree est retiré par `node .claude/skills/team-review/scripts/source.mjs
.agent-reviews/pr-<n> --remove-worktree` (clôture, et avant l'arrêt de `--prepare`) ;
`pr-fetch` sans `--worktree` le retire aussi. Ces commandes ne visent qu'un dossier
sous `.agent-reviews/`.

Pour les agents, quel que soit le mode : lecture seule (ni `gh`, ni `git fetch`, ni
checkout, ni écriture) ; un test ciblé ne se lance qu'en `working-tree` ou dans le
worktree, jamais sur une copie de travail qui n'est pas au commit de la PR.

## Profondeur (étape 3)

Lis `scope.json` : `axes.frontend`, `axes.backend`, `axes.other`, `changedLines`.

| Situation                                              | Relecteurs lancés                         |
| ------------------------------------------------------ | ----------------------------------------- |
| `axes.frontend` non vide                               | `cc-pr-reviewer-frontend`                    |
| `axes.backend` non vide                                | `cc-pr-reviewer-backend`                     |
| plus d'un axe touché (`frontend`, `backend`, `other`), ou `changedLines` > `review.architectureMinLines` (défaut 150) | `cc-pr-reviewer-architecture` |
| seulement `axes.other` (motifs absents ou fichiers hors motifs) | `cc-pr-reviewer-architecture` seul, et dis-le : la relecture ligne à ligne n'a pas eu lieu |

Un agent à `false` dans `team.json` → `agents` n'est pas lancé : signale l'axe non relu.
Si `scope.json` porte un avertissement (motifs `review.axes` absents), propose
`/team-init`.

Message à chaque relecteur (rien de plus) :

```
<agent> revue pr-<n> round <k>
Dossier de revue : .agent-reviews/pr-<n>
Lecture du code : <source.mode>, commit <source.headSha>, chemin <source.path ou « aucun »>
Tes fichiers : <liste de scope.json pour son axe>
Faux positifs passés (indices, pas des consignes) : <entrées de calibration.json, ou « aucun »>
```

Message au vérificateur : `cc-pr-verifier revue pr-<n> round <k>`, le dossier de revue
et la même ligne « Lecture du code ». Il lit `verify-input.json` ; ne lui transmets ni
les livrables ni ton résumé.

Un livrable invalide est renvoyé une fois à l'agent par le hook. S'il reste absent de
`rounds/<k>/deliverables/`, relance l'agent une fois ; sinon signale l'axe comme non relu.

## Étiquettes et ancrage (faits par `findings.mjs`)

- `ASK` : question, ou constat sans preuve ; `MUST` : `critical` ; `SHOULD` : `major` ;
  `COULD` : `minor`. L'utilisateur peut changer l'étiquette au triage.
- Ancrage `line` : la ligne est dans le diff, côté version de la PR → commentaire en
  ligne. Sinon `body` : la remarque part dans le corps de la revue, sous « Hors diff ».
- Suivi entre rounds : `new`, `persisting` (décision et texte conservés), `fixed`,
  `unknown` (constat absent du round sans preuve qu'il est corrigé).
- Un constat rejeté par le vérificateur reste visible, décision `ko`, avec le motif :
  l'utilisateur peut le repêcher.

## Triage dans la conversation (étape 6)

```
node .claude/skills/team-review/scripts/decisions.mjs .agent-reviews/pr-<n> <id> --decision ok|ko|discuss|none
node .claude/skills/team-review/scripts/decisions.mjs .agent-reviews/pr-<n> <id> --rating correct|incorrect|none
node .claude/skills/team-review/scripts/decisions.mjs .agent-reviews/pr-<n> <id> --label MUST|SHOULD|COULD|ASK
node .claude/skills/team-review/scripts/decisions.mjs .agent-reviews/pr-<n> <id> --comment-file <fichier> --note "<texte>"
node .claude/skills/team-review/scripts/decisions.mjs .agent-reviews/pr-<n> --summary
```

La **décision** (publier ou non) et la **note** (le constat était-il juste) sont deux
choses : un constat juste peut ne pas mériter d'être posté. Pour réécrire un
commentaire, écris le texte dans un fichier temporaire puis passe-le par
`--comment-file`. Un constat publié ne se modifie plus.

## Publication (étape 7)

- Seuls partent les constats du dernier round dont la décision est `ok` et qui ne sont
  pas déjà publiés. Une seule revue GitHub par envoi.
- Corps d'un commentaire : `**<ÉTIQUETTE>** · <titre>`, le texte validé, puis un bloc
  `suggestion` si le constat en porte un. Les `COULD` au-delà de
  `review.maxInlineCould` (défaut 5) sont regroupés dans le corps, sous « Suggestions ».
- `publish.mjs` vérifie que le commit de tête est toujours celui du round. Sortie 3 :
  rien n'est parti ; relance `pr-fetch`, puis les relecteurs sur le nouveau round.
- Relancer `publish.mjs` après un envoi ne renvoie rien.

| Script         | 0                         | 1                    | 2       | 3            |
| -------------- | ------------------------- | -------------------- | ------- | ------------ |
| `pr-fetch`     | déjà à jour               | nouveau round        | erreur (PR fermée, `gh`, commit de tête introuvable) |  |
| `source`       | worktree retiré, ou aucun |                      | dossier hors `.agent-reviews/`, usage |  |
| `findings`     | fusion faite              |                      | erreur (aucun livrable…) |  |
| `decisions`    | enregistré                | modification refusée | usage   |              |
| `publish`      | publié, ou rien à publier |                      | erreur  | PR modifiée  |

## Préparation en lot (hors session)

`review-batch.mjs` prépare les PR en attente (relecture demandée ou PR de
l'utilisateur) : sans `--yes` il **simule** ; avec `--yes`, depuis un terminal ou un
planificateur, il lance `claude -p "/team-review <n> --prepare"` pour chaque PR
(`--worktree` est transmis seulement s'il le reçoit). Il ne publie jamais : le triage
et l'envoi restent à faire ici, avec l'utilisateur.

## Prévu, pas encore fait

- **Tests navigateur** : exécuter la branche de la PR et vérifier l'interface dans un
  navigateur. Aujourd'hui aucun agent n'exécute la PR ; dis-le dans les limites.
