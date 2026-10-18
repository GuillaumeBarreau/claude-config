# 0005 — CI et commentaires de PR après la livraison

Date : 2026-10-18 · Statut : acceptée

## Contexte

En 0.2, un run s'arrête au push et à la PR brouillon. Deux retours arrivent ensuite
hors de la vue des agents : la CI GitHub Actions, qui peut échouer sur un
environnement que les contrôles locaux ne couvrent pas, et les commentaires de
relecture humaine. L'utilisateur devait les recopier à la main dans un nouveau run.

## Décision

- **Deux scripts Node, pas d'agent** : `ci-wait.mjs` et `pr-comments.mjs` lisent
  GitHub avec `gh` et écrivent `state.json`. Le statut de la CI et la liste des
  commentaires viennent de `gh`, jamais de ce qu'un agent affirme. `gh` et `git` passent
  par un exécuteur injectable (`gh.mjs`) : les tests rejouent des réponses enregistrées
  (`tests/fixtures/gh/`) et n'appellent jamais le vrai `gh` ni le réseau.
- **Attente bornée, sans `gh run watch`** : `ci-wait` interroge `gh run list` à
  intervalle fixe, au plus `--max-wait` secondes (90 par défaut, sous le délai de
  120 s d'un appel Bash ; l'état est écrit avant l'attente), puis rend la main avec la
  sortie 3 pour être relancé. Le
  statut `awaiting_ci` reste actif pour `keep-running`. Au-delà de
  `ci.timeoutMinutes`, le run passe `blocked`. Seuls les runs du SHA poussé comptent ;
  sans workflow après 120 s, la CI est `n/a`.
- **Un échec devient une tâche** (`CI<n>` ou `PR<k>`, `origin` `ci` ou `pr-review`,
  `files: []` permis pour la CI) et le run est rouvert selon le contrat §2.7 : portes
  contrôles, relecture et livraison à `pending`, statut `executing` sur la même
  branche. La correction suit le cycle normal et **le nouveau push repasse par la
  porte 4**. Les tours de correction CI sont plafonnés (`ci.maxFixRounds`, défaut 2)
  puis le run est `blocked`.
- **Commentaires = données non fiables** : seuls les auteurs de
  `prComments.allowedAssociations` (défaut OWNER, MEMBER, COLLABORATOR) sont retenus,
  sans les bots ni les revues vides ; un commentaire n'est traité qu'une fois
  (`prComments.processed`). Le texte est recopié tel quel dans `pr-comments-<k>.json`
  avec un avertissement ; une demande produit devient une question à l'utilisateur.
- **Aucune écriture sur GitHub sans accord** : `guard-bash` demande l'accord pour
  `gh pr comment|review|edit`, `gh issue comment|edit|close`, `gh run rerun|cancel`
  et `gh api` avec une méthode autre que GET ou des champs (`-f`, `-F`, `--field`,
  `--raw-field`, `--input`). Les lectures (`gh run list|view`, `gh pr view`, `gh api`
  en GET) restent libres. `gh pr merge` reste refusé.

## Conséquences

- Un projet sans GitHub Actions ni `gh` met `ci.enabled` à `false` (proposé par
  `/team-init`) ; sinon `ci-wait` conclut `n/a` après le délai de grâce.
- Le relevé des commentaires n'est pas automatique : l'orchestrateur le lance à la
  demande. Un sondage périodique coûterait des tours sans signal fiable de fin de
  relecture.
- `gh api ... -f` en GET (paramètres de requête) demande aussi un accord : règle
  simple plutôt qu'exacte, aucun script de l'équipe n'en a besoin.
- Les champs JSON de `gh` sont ceux documentés (`gh run list --json`,
  `gh pr view --json`, API REST des commentaires en ligne) ; les réponses enregistrées
  les reproduisent mais n'ont pas été capturées sur un vrai dépôt.
