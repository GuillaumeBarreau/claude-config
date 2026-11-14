# 0011 — Revue de PR

Date : 2026-11-13 · Statut : acceptée

## Contexte

L'équipe écrit du code et traite les commentaires reçus sur ses propres PR
(`pr-comments`), mais rien n'aide à **relire la PR d'un collègue**. Une relecture par un
modèle a trois risques propres :

- un constat faux posté chez un collègue coûte plus cher qu'un constat manqué ;
- un agent qui écrit sur GitHub peut publier sans que l'utilisateur ait tout lu ;
- le texte de la PR (description, commentaires, code) vient de tiers et peut contenir
  des consignes.

Il faut aussi suivre une PR qui évolue : un constat d'une première version doit être
reconnu, ou déclaré corrigé, dans la suivante.

## Décision

**Module `/team-review` à côté de `/team`**, qui réutilise le socle : `team-rules`,
`gh.mjs` (exécution de `gh`, lecture de `team.json`), `sensitive.mjs` (motifs glob),
livrables JSON validés par `check-deliverable`, garde-fous de `guard-bash`. Quatre
agents en lecture seule : `pr-reviewer-frontend`, `pr-reviewer-backend`,
`pr-reviewer-architecture` (un par axe, lancés selon les fichiers touchés) et
`pr-verifier`. La skill n'est lancée qu'à la main.

**Publication par un script déterministe, jamais par un agent.** `publish.mjs` est la
seule écriture sur GitHub. L'orchestrateur le lance d'abord en `--dry-run`, montre
l'aperçu en entier, puis le relance après un accord explicite pour cet envoi.
`guard-bash` demande en plus l'accord pour `publish.mjs` sans `--dry-run` et pour
`review-batch.mjs --yes`. Le script vérifie que le commit de tête n'a pas bougé (sortie
3, rien envoyé) et note la publication pour ne jamais renvoyer deux fois.

**Vérificateur aveugle au raisonnement.** Les constats `critical` et `major` sont
contre-vérifiés par `pr-verifier`, qui reçoit `verify-input.json` réduit à `id`, `file`,
`line`, `title`, `problem`, `scenario` : ni preuve, ni raisonnement, ni résumé de
l'orchestrateur. Il doit retrouver le défaut par sa propre lecture. Un constat rejeté
reste visible avec le motif (décision `ko`), pour que l'utilisateur puisse le repêcher.

**Magasin en fichiers JSON** : `.agent-reviews/pr-<n>/` (`review.json`, un dossier par
round), à la racine du projet et ignoré par Git, comme `.agent-runs/`. Pas de base de
données : le dépôt reste sans dépendance.

**Empreinte par fichier et extrait de code**, pas par numéro de ligne : sha256 du
chemin, de l'extrait normalisé (espaces compactés, lignes vides retirées) et de la
nature du constat. Un constat déplacé par un ajout plus haut reste le même d'un round à
l'autre. Suivi : `new`, `persisting`, `fixed` (fichier modifié et extrait absent du
diff), `unknown` (pas de preuve de correction).

**Décision et note séparées.** Publier ou non (`ok`, `ko`, `discuss`) et « le constat
était-il juste » (`correct`, `incorrect`) sont deux champs. Seule la note alimente les
statistiques et `calibration.json` (faux positifs passés, transmis comme indices aux
relecteurs suivants).

**Quatre étiquettes** : `MUST` (critical), `SHOULD` (major), `COULD` (minor), `ASK`
(question ou constat sans preuve). L'étiquette est modifiable au triage et figure en
tête de chaque commentaire publié.

**Commentaires en français, sans mention d'assistance.** Les agents rédigent un
brouillon court adressé à l'auteur ; l'utilisateur le valide ou le réécrit. Le texte
publié ne mentionne ni IA ni outil.

**Type de revue `COMMENT` par défaut.** `APPROVE` et `REQUEST_CHANGES` seulement avec
`--event`, sur demande explicite.

**Rapport de triage local et personnel** : `serve.mjs` sur `127.0.0.1`, jeton aléatoire
dans l'URL, aucune route de publication. Le triage peut aussi se faire dans la
conversation (`decisions.mjs`, même fonction `applyDecision`).

**Mode « corrections » pour sa propre PR** : si l'auteur est l'utilisateur `gh`, la
sortie est `fixes.md`, sans appel à GitHub.

## Conséquences

- Les agents de revue sont hors workflow `/team` : `run` vaut `null` dans leur
  livrable, qui est rangé par `check-deliverable` dans
  `.agent-reviews/<review>/rounds/<round>/deliverables/`. Ils ne sont pas des
  développeurs (`DEVELOPERS`) et ne sont pas dans `GUARDED_AGENTS` : leur lecture seule
  tient à `disallowedTools`.
- L'aveuglement du vérificateur tient au contenu de `verify-input.json` et à sa
  consigne ; aucun hook ne l'empêche de lire `deliverables/` ou `review.json`.
- `install.mjs` ajoute `.agent-reviews/` au `.gitignore` du projet ; `validate.mjs`
  contrôle la section `review` de `team.json`.
- `review.event` est validé mais sans effet : sans `--event`, la revue part en
  `COMMENT` et `publish.mjs` signale que le réglage est ignoré.
- Un relecteur désactivé dans `team.json` laisse son axe non relu, signalé dans le
  résumé.
- Aucun agent n'exécute la PR : les tests dans le navigateur sont prévus, pas faits.

## Alternatives écartées

- **Application hébergée** (service web pour trier et publier) : un serveur à déployer,
  des jetons GitHub à stocker, des données de PR hors du poste. Un petit serveur
  local, sans dépendance, suffit pour une personne.
- **Agent qui publie** : la publication dépendrait du jugement du modèle au moment de
  l'envoi. Un script qui ne publie que les constats `ok`, après aperçu et accord, est
  vérifiable et testable.
- **Rapport partagé** (avec l'auteur ou l'équipe) : les constats non triés, rejetés ou
  notés « incorrect » n'ont pas à circuler. Seule la revue publiée est visible.
- **Commentaire au niveau du fichier** pour un constat hors diff : incertitude sur la
  prise en charge par l'API de création de revue (`POST …/pulls/<n>/reviews`). Ces
  constats partent dans le corps de la revue, sous « Hors diff ».
