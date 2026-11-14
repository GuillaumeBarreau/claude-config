# Relire une PR GitHub : `/team-review`

`/team-review` relit une pull request avec des agents, fait trier leurs remarques par
toi, puis publie **une seule** revue GitHub avec ce que tu as validé. Sur ta propre PR,
rien ne part sur GitHub : tu obtiens une liste de corrections locale.

État : implémenté et testé avec `gh` simulé. Rien n'a encore tourné sur une vraie PR :
voir « Limites connues ».

```
/team-review <n>
  → pr-fetch (PR, CI, diff, fichiers par axe) → round k
  → relecteurs en parallèle : frontend, backend, architecture (selon les fichiers)
  → findings (fusion, identifiants R1…) → cc-pr-verifier (constats critical et major)
  → findings (verdicts appliqués) → résumé
  → triage : rapport local (127.0.0.1) ou conversation
  → publish --dry-run (aperçu) → ton accord → publish (une revue GitHub, COMMENT)
     ou, sur ta PR : fixes.md, rien sur GitHub
```

## Prérequis

- `gh` installé et authentifié (`gh auth status`), avec la lecture des PR du dépôt et,
  pour publier, le droit de relire.
- L'équipe installée (`install.mjs`) : les quatre agents de revue, la skill
  `team-review`, l'entrée `.agent-reviews/` dans le `.gitignore` du projet.
- Les motifs `review.axes` dans `team.json` (voir ci-dessous). Sans eux, la revue
  marche, mais seul le relecteur d'architecture lit les fichiers.

## Régler les axes : `/team-init`

`/team-init` propose `review.axes` : les motifs glob (`*`, `**`, `?`) qui répartissent
les fichiers d'une PR entre le relecteur `frontend` et le relecteur `backend`. Il les
déduit de la structure du projet (par exemple `client/**` et `server/**`) et te les
fait valider.

| Clé (`team.json` → `review`) | Défaut | Effet |
| ---------------------------- | ------ | ----- |
| `axes.frontend`, `axes.backend` | `[]` | Motifs des fichiers de chaque axe. Un fichier qui correspond aux deux va dans les deux ; sans correspondance, dans « other » |
| `architectureMinLines`       | `150`  | Au-delà de ce nombre de lignes modifiées, le relecteur d'architecture est lancé même sur un seul axe |
| `maxInlineCould`             | `5`    | Nombre de `COULD` publiés en ligne ; les suivants sont regroupés dans le corps de la revue |
| `batch.maxPrs`               | `3`    | PR préparées au plus par `review-batch.mjs --yes` |
| `event`                      | `COMMENT` | Validé, mais **sans effet** : seul `--event` change le type de revue |
| `language`                   | `fr`   | Validé et lu, mais **sans effet** : les agents écrivent en français dans tous les cas |

Un relecteur se désactive dans `team.json` → `agents` (`"cc-pr-reviewer-backend": false`…) :
son axe est alors signalé comme non relu.

## Les commandes

```
/team-review list              PR ouvertes et leur état de revue local
/team-review stats             justesse des agents, d'après tes notes
/team-review 42                revue complète de la PR #42
/team-review 42 --worktree     idem, le code de la PR lu dans un worktree jetable (voir ci-dessous)
/team-review 42 --prepare      relecture et fusion seulement, sans triage ni publication
```

`/team-review` ne se lance qu'à la main (la skill n'est jamais déclenchée d'elle-même).

`list` affiche, pour chaque PR ouverte : numéro, état local, auteur, titre, et si ta
relecture est demandée ou si tu en es l'auteur.

| État local       | Signification |
| ---------------- | ------------- |
| jamais revue     | Aucun dossier `.agent-reviews/pr-<n>/` |
| à trier          | Revue faite sur le commit de tête actuel, pas encore publiée |
| publiée          | Revue publiée (ou `fixes.md` écrit) sur le commit de tête actuel |
| modifiée depuis  | Le commit de tête n'est plus celui du dernier round |

## Déroulé d'une revue

1. **Relève de la PR** (`pr-fetch.mjs`). Seule une PR ouverte se relit (un brouillon
   aussi). Le script lit la PR, la CI, les commentaires existants, le diff et ton login
   `gh`, et ouvre un **round** quand le commit de tête a changé. Il annonce le mode :
   - `comments` : PR d'un collègue, la sortie est une revue GitHub ;
   - `fixes` : ta propre PR (son auteur est ton login `gh`), la sortie est `fixes.md`.

   Il choisit aussi **où les agents liront le code de la PR** (`working-tree`,
   `git-show` ou `worktree`, voir « Lire le code de la PR ») et l'orchestrateur te dit
   lequel et pourquoi.
2. **Relecteurs**, lancés en parallèle selon les fichiers :

   | Situation | Relecteurs |
   | --------- | ---------- |
   | fichiers dans `axes.frontend` | `cc-pr-reviewer-frontend` |
   | fichiers dans `axes.backend` | `cc-pr-reviewer-backend` |
   | plus d'un axe touché (frontend, backend, other), ou plus de `architectureMinLines` lignes | `cc-pr-reviewer-architecture` |
   | seulement des fichiers « other » | `cc-pr-reviewer-architecture` seul : pas de relecture ligne à ligne, l'orchestrateur le dit |

   Chaque relecteur reçoit le dossier de revue, le round, la source du round, ses
   fichiers et les faux positifs passés de `calibration.json`. Rien d'autre.
3. **Fusion** (`findings.mjs`) : dédoublonnage, identifiants `R1`, `R2`…, étiquettes,
   ancrage, suivi entre rounds.
4. **Contre-vérification** : les constats `critical` et `major` partent à
   `cc-pr-verifier`, réduits à `id`, `file`, `line`, `title`, `problem`, `scenario`. Il ne
   voit ni la preuve ni le raisonnement du relecteur. Verdicts :
   - `confirmed` : le constat est gardé tel quel ;
   - `downgraded` : sévérité baissée (l'étiquette suit, sauf si tu l'as changée) ;
   - `rejected` : le constat reste visible, décision `ko`, avec le motif ; tu peux le
     repêcher.
5. **Résumé** : compteurs par étiquette, constats écartés ou revus à la baisse, et les
   limites (fichiers non relus, rien d'exécuté, fichiers hors PR lus sur ta branche en
   mode `git-show`). Avec `--prepare`, la revue s'arrête là (worktree retiré s'il y en
   a un).
6. **Triage**, par toi (voir ci-dessous).
7. **Publication**, après aperçu et accord (voir ci-dessous).
8. **Clôture** : le worktree est retiré s'il y en a un, et l'orchestrateur rappelle les
   constats `discuss`, ceux sans décision et ceux sans note.

## Lire le code de la PR : trois modes

Le diff ne suffit pas à relire : les agents lisent le code **autour** de chaque
changement (appelants, tests, contrats). Pour que ce code soit celui de la PR et pas
celui de la branche où tu te trouves, `pr-fetch` choisit un mode de lecture, l'enregistre
dans le round (`review.json` → `rounds[k].source`, et `pr.json` → `source` :
`{ mode, headSha, path }`), et l'orchestrateur le rappelle aux quatre agents. **Aucun
mode ne change ta branche** : jamais de `checkout`, `switch`, `reset` ni `stash` dans ta
copie de travail.

| `mode` | Quand | Les agents lisent… |
| ------ | ----- | ------------------ |
| `working-tree` | ta copie de travail est sur le commit de tête de la PR (`git rev-parse HEAD`) | ta copie de travail, normalement. Si elle a des modifications non commitées (`git status --porcelain`), `pr-fetch` l'annonce : les agents les liront |
| `git-show` | par défaut, dès que ta copie de travail est ailleurs | les fichiers modifiés par la PR avec `git show <headSha>:<chemin>` (et cherchent avec `git grep -n <motif> <headSha> -- <chemins>`), jamais avec `Read` ; les autres fichiers dans ta copie de travail, donc dans la version de ta branche — le résumé et `notReviewed` le rappellent quand un constat en dépend |
| `worktree` | `/team-review <n> --worktree` seulement | uniquement `.agent-reviews/pr-<n>/worktree/`, un worktree Git détaché sur le commit de tête, pour tout le code |

Ce que fait `pr-fetch`, par mode :

- `working-tree` : `git rev-parse HEAD`, `git status --porcelain`. Rien d'autre.
- `git-show` : `git fetch --no-tags --quiet origin +refs/pull/<n>/head:refs/claude-config/pr-<n>`
  (fonctionne aussi pour une PR venue d'un fork ; la référence `refs/claude-config/pr-<n>`
  est hors `refs/heads`, donc invisible pour `git branch`, et empêche Git de nettoyer le
  commit), puis `git cat-file -e <headSha>^{commit}`. En cas d'échec : sortie 2, rien
  n'est écrit.
- `worktree` : les deux commandes de `git-show`, puis `git worktree add --detach
  .agent-reviews/pr-<n>/worktree <headSha>`. Un ancien worktree de la PR est d'abord
  retiré (`git worktree remove --force`, `git worktree prune`) ; un nouveau round le
  recrée sur le nouveau commit. Aucun `npm install` n'y est fait : les agents y lisent,
  ils n'y exécutent rien qui demande des dépendances.

Le worktree est retiré à la clôture de la revue (et avant l'arrêt de `--prepare`) :

```
node .claude/skills/team-review/scripts/source.mjs .agent-reviews/pr-<n> --remove-worktree
```

Ce script, comme `pr-fetch`, ne peut retirer qu'un dossier sous `.agent-reviews/` ;
`guard-bash` demande ton accord pour tout autre `git worktree remove --force`. Un round
déjà à jour revérifie sa source à chaque `pr-fetch` : worktree recréé s'il manque (avec
`--worktree`), retiré sans l'option, `source` mise à jour si le mode a changé.

Dans tous les modes, les agents restent en lecture seule : ni `gh`, ni `git fetch`
(c'est `pr-fetch` qui l'a fait), ni checkout, ni écriture. Un test ciblé ne se lance
qu'en `working-tree` ou dans le worktree.

## Les quatre étiquettes

| Étiquette | Par défaut pour |
| --------- | --------------- |
| `MUST`    | constat `critical` |
| `SHOULD`  | constat `major` |
| `COULD`   | constat `minor` |
| `ASK`     | question (`kind: "question"`), ou constat sans preuve (`proof: "none"`), quelle que soit la sévérité |

Tu peux changer l'étiquette au triage. Elle est ajoutée au début du commentaire publié :
`**SHOULD** · <titre>`.

## Ancrage : ligne du diff ou corps de la revue

- **Ligne** : la ligne visée est ajoutée ou de contexte, côté version de la PR, dans un
  bloc du diff. Le commentaire est posé sur cette ligne. Une plage (`line`..`endLine`)
  est gardée si elle tient dans le même bloc ; sinon le commentaire vise la première
  ligne seule et la suggestion est retirée.
- **Corps** : tout le reste (ligne hors du diff, fichier non modifié, pas de ligne). La
  remarque part dans le corps de la revue, sous « Hors diff ».

Un bloc `suggestion` GitHub n'est ajouté que pour un constat ancré sur une ligne.

## Trier : rapport local ou conversation

**Rapport local.** `serve.mjs` lance un petit serveur HTTP :

```
node .claude/skills/team-review/scripts/serve.mjs .agent-reviews/pr-<n> [--port <n>]
```

- Il écoute sur `127.0.0.1` seulement, et refuse une requête venue d'ailleurs ou adressée
  à un autre nom d'hôte (403).
- L'URL affichée contient un jeton aléatoire (`?t=…`) ; sans lui, tout est refusé.
- Il n'a **aucune route de publication** : la page ne peut rien envoyer sur GitHub.
- Chaque changement est enregistré dans `review.json` aussitôt (le texte, après une
  courte pause de frappe). Le serveur tourne jusqu'à Ctrl+C.

Le rapport est personnel : il n'est ni hébergé ni partagé.

**Dans la conversation.** L'orchestrateur te présente chaque constat et enregistre ton
choix avec `decisions.mjs` :

```
node .claude/skills/team-review/scripts/decisions.mjs .agent-reviews/pr-<n> R3 --decision ok
node .claude/skills/team-review/scripts/decisions.mjs .agent-reviews/pr-<n> R3 --rating incorrect --note "déjà géré par le middleware"
node .claude/skills/team-review/scripts/decisions.mjs .agent-reviews/pr-<n> --summary
```

Pour chaque constat, trois choses distinctes :

| Champ | Valeurs | Question |
| ----- | ------- | -------- |
| décision | `ok`, `ko`, `discuss`, aucune | Faut-il le publier ? |
| note de justesse | `correct`, `incorrect`, aucune | Le constat était-il juste ? |
| note personnelle | texte libre | Jamais publiée |

Un constat juste peut ne pas mériter d'être posté : la décision et la note de justesse
sont indépendantes. C'est la note de justesse qui alimente les statistiques et la
calibration.

Tu peux aussi réécrire le commentaire (le brouillon de l'agent est gardé, et
« Rétablir le brouillon » le remet) et changer l'étiquette. Refus : une décision `ok`
avec un commentaire vide, et toute modification du commentaire, de l'étiquette ou de la
décision d'un constat déjà publié.

## Publier

```
node .claude/skills/team-review/scripts/publish.mjs .agent-reviews/pr-<n> --dry-run
node .claude/skills/team-review/scripts/publish.mjs .agent-reviews/pr-<n> [--event COMMENT|APPROVE|REQUEST_CHANGES]
```

1. L'aperçu `--dry-run` montre le corps de la revue et chaque commentaire en ligne, et
   écrit la charge utile dans `rounds/<k>/publish-payload.json`. Rien n'est envoyé.
2. L'orchestrateur te montre l'aperçu en entier et demande ton accord **pour cet
   envoi**.
3. Seulement après un oui explicite, il relance sans `--dry-run`. Le hook `guard-bash`
   te redemande confirmation : `publish.mjs` sans `--dry-run` n'est jamais autorisé
   d'office.

Ce qui part :

- les constats du dernier round dont la décision est `ok` et qui ne sont pas encore
  publiés, triés du plus grave au moins grave ;
- **une seule** revue GitHub, de type `COMMENT` par défaut. `APPROVE` et
  `REQUEST_CHANGES` seulement avec `--event`, sur ta demande ;
- un corps de revue (« Relecture : N remarques (… MUST, … SHOULD…) »), avec les
  sections « Hors diff » et « Suggestions » (les `COULD` au-delà de `maxInlineCould`) ;
- des commentaires en ligne : `**<ÉTIQUETTE>** · <titre>`, le texte validé, puis le
  bloc `suggestion` éventuel.

Les commentaires sont en français et ne mentionnent ni IA ni outil.

Avant d'envoyer, `publish.mjs` vérifie que le commit de tête de la PR est toujours celui
du round. Sinon il sort en 3 et rien ne part : relance `/team-review <n>` pour ouvrir
un nouveau round. La publication est notée dans `review.json` dès la réponse de GitHub :
un second lancement n'envoie rien.

| Script     | 0 | 1 | 2 | 3 |
| ---------- | - | - | - | - |
| `pr-fetch` | déjà à jour | nouveau round | erreur (PR fermée, `gh`…) | |
| `findings` | fusion faite | | erreur (aucun livrable…) | |
| `decisions`| enregistré | modification refusée | usage | |
| `publish`  | publié, ou rien à publier | | erreur | PR modifiée, rien envoyé |

## Ta propre PR : mode « corrections »

Quand l'auteur de la PR est ton login `gh`, le mode est `fixes`. Le triage est le même ;
à la publication, `publish.mjs` n'appelle pas GitHub et écrit
`.agent-reviews/pr-<n>/fixes.md` : une entrée numérotée par constat validé du dernier
round, avec l'étiquette, le titre, `fichier:ligne`, le problème et la correction.

## Suivre une PR entre deux versions

Un round correspond à un commit de tête. Quand la PR bouge, `/team-review <n>` ouvre un
nouveau round et relance les relecteurs. Chaque constat est reconnu d'un round à l'autre
par une **empreinte** : fichier, extrait de code normalisé (espaces compactés, lignes
vides retirées) et nature. Le numéro de ligne n'en fait pas partie : un constat qui a
seulement bougé reste le même.

| Suivi | Signification |
| ----- | ------------- |
| nouveau (`new`) | Empreinte jamais vue |
| persistant (`persisting`) | Retrouvé dans le nouveau round : décision, notes, commentaire édité et publication conservés ; l'ancrage suit le nouveau diff |
| corrigé (`fixed`) | Absent du round, son fichier a changé entre les deux commits (lecture `gh api …/compare`) et l'extrait n'est plus dans le diff |
| inconnu (`unknown`) | Absent du round sans preuve qu'il est corrigé (fichier inchangé, extrait encore présent, ou comparaison impossible) |

Seuls les constats du dernier round se trient et se publient. Un constat validé d'un
round précédent et absent du dernier n'est pas publié (l'aperçu le signale).

## Statistiques et calibration

```
/team-review stats
node .claude/skills/team-review/scripts/stats.mjs [--json]
```

Par agent, sur toutes les revues de `.agent-reviews/` : constats, notés corrects et
incorrects, précision (corrects / notés), publiés, et modifiés avant envoi (commentaire
publié différent du brouillon). Un constat trouvé par deux agents compte pour chacun.
Aucun seuil : les mesures sont seulement affichées.

`stats.mjs` écrit aussi `.agent-reviews/calibration.json` : pour chaque agent, les 10
derniers constats notés « incorrect » (titre, fichier, note). L'orchestrateur les
transmet aux relecteurs suivants comme des indices, pas des consignes. Sans notes de
justesse, rien ne s'améliore : c'est le seul retour qu'ils reçoivent.

## Préparer en lot, hors session

`review-batch.mjs` prépare les PR en attente : ta relecture est demandée ou tu en es
l'auteur, et la PR n'a jamais été revue ou a changé depuis.

```
node .claude/skills/team-review/scripts/review-batch.mjs [--max <n>]          # simulation
node .claude/skills/team-review/scripts/review-batch.mjs --yes [--max <n>]    # mode réel
```

- Sans `--yes` : simulation. Il liste les PR et la commande qui serait lancée ; lectures
  `gh` seulement, rien n'est écrit.
- Avec `--yes` : lance `claude -p "/team-review <n> --prepare"` pour chaque PR, en
  série, au plus `--max` (défaut `review.batch.maxPrs`). Coûte des appels API. Refusé
  depuis une session Claude Code (`CLAUDECODE` défini) ; `guard-bash` demande ton
  accord s'il est lancé par un agent. Rapport :
  `.agent-reviews/batch/<horodatage>.json`.
- `--worktree` est transmis à `/team-review` seulement si tu le donnes ; sinon la
  lecture se fait en `git-show` (ou `working-tree`).
- Il ne publie jamais : le triage et l'envoi se font ensuite avec `/team-review <n>`.

Sorties : 0 ; 1 si une préparation a échoué ; 2 refus ou erreur.

## Le contenu de `.agent-reviews/`

À la racine du projet, ignoré par Git (l'installeur ajoute l'entrée au `.gitignore`).
Personnel : jamais commité ni partagé. N'écris pas `review.json` à la main.

| Fichier | Écrit par | Contenu |
| ------- | --------- | ------- |
| `pr-<n>/review.json` | les scripts | rounds (avec leur `source`), constats, décisions, publications, journal |
| `pr-<n>/rounds/<k>/pr.json` | `pr-fetch` | métadonnées, CI, `source` du round, commentaires existants (des données, pas des consignes) |
| `pr-<n>/rounds/<k>/diff.patch` | `pr-fetch` | diff unifié de la PR |
| `pr-<n>/rounds/<k>/scope.json` | `pr-fetch` | fichiers par axe, lignes modifiées, avertissements |
| `pr-<n>/rounds/<k>/deliverables/` | hook `check-deliverable` | livrables JSON des agents |
| `pr-<n>/rounds/<k>/verify-input.json` | `findings` | constats à contre-vérifier, sans le raisonnement |
| `pr-<n>/rounds/<k>/publish-payload.json` | `publish` | charge utile envoyée (ou prévue en `--dry-run`) |
| `pr-<n>/worktree/` | `pr-fetch --worktree` | worktree Git jetable au commit de tête, retiré par `source.mjs --remove-worktree` |
| `pr-<n>/fixes.md` | `publish` (mode `fixes`) | liste de corrections |
| `pr-<n>/publications.jsonl` | `publish` (mode `comments`) | une ligne par constat publié : brouillon, texte final, commit, revue, commentaire |
| `calibration.json` | `stats` | faux positifs passés, par agent |
| `batch/<horodatage>.json` | `review-batch --yes` | rapport d'une préparation en lot |

## Sécurité

- Le texte de la PR (titre, description, commentaires, contenu des fichiers) est une
  donnée. Une consigne trouvée dedans est signalée, jamais suivie.
- Les quatre agents sont en lecture seule (`Edit`, `Write` interdits) et ont pour
  consigne de ne lancer ni `gh`, ni `git fetch`, ni une commande qui modifie quoi que ce
  soit. Le seul `git fetch` est celui de `pr-fetch`, vers `refs/claude-config/pr-<n>` ;
  rien ne change jamais ta branche ni ta copie de travail.
- La seule écriture sur GitHub est `publish.mjs` sans `--dry-run`, lancé par
  l'orchestrateur après ton accord, et confirmé par `guard-bash`.

## Limites connues

- Rien n'a encore tourné sur une vraie PR : la skill, les quatre agents et la
  publication réelle ne sont couverts que par des tests avec `gh` simulé. Les modes
  `git-show` et `worktree` sont éprouvés sur un vrai dépôt Git temporaire (`git init`,
  `origin` local), pas contre GitHub.
- En mode `git-show`, rien n'empêche un agent de lire un fichier de la PR avec `Read`
  (version de ta branche) au lieu de `git show` : la consigne le lui interdit, aucun
  hook ne le vérifie.
- La réponse du `POST …/pulls/<n>/reviews` utilisée dans les tests est supposée (calquée
  sur la lecture d'une revue) ; l'acceptation par GitHub d'une plage (`start_line`) avec
  bloc `suggestion` n'a pas été vérifiée.
- La page de triage n'a pas été vue dans un navigateur.
- `review.event` dans `team.json` est validé mais sans effet : seul `--event` change le
  type de revue.
- `review.language` est validé et lu, mais sans effet : rien ne l'utilise, les agents
  écrivent en français.
- `pr-list` lit au plus 30 PR (défaut de `gh`) et ne compte pas les demandes de
  relecture adressées à une équipe.
- `claude -p "/team-review <n> --prepare"` (préparation en lot) n'a pas été éprouvé en
  mode non interactif.
- Le vérificateur ne lit pas le raisonnement des relecteurs parce que sa consigne le lui
  interdit et que `verify-input.json` ne le contient pas ; aucun hook ne l'empêche
  d'ouvrir `deliverables/` ou `review.json`.

## Prévu, non implémenté

**Tests d'exécution de la PR dans le navigateur.** Aujourd'hui aucun agent n'exécute la
PR ; le résumé le dit dans les limites. Décisions déjà prises pour cette étape :

- l'API et le front de la branche sont lancés en local, sur les données de
  l'environnement de dev ;
- les tests passent uniquement par l'interface, aucun appel direct aux routes ;
- l'outil ne joue aucune migration ;
- les captures sont visibles par l'auteur de la PR (hébergement à choisir).
