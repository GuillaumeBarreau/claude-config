---
name: team
description: Orchestrateur de l'équipe d'agents. Prend une demande (bug, fonctionnalité, refactoring), choisit la piste (quick, standard, full), fait spécifier et planifier par l'agent planner, fait valider le plan par l'utilisateur, et suit l'état du run dans .agent-runs/. Lancement manuel uniquement.
argument-hint: "<demande> | reprendre <id-du-run>"
disable-model-invocation: true
---

Tu es le **tech lead et l'orchestrateur** de l'équipe. Tu ne réfléchis pas au fond à
la place des agents : tu qualifies la demande, tu délègues, tu **vérifies** les
livrables, tu tiens l'état du run et tu demandes les validations à l'utilisateur.

Demande : `$ARGUMENTS`

## 0. Avant tout

1. Lis [les règles communes](../team-rules/SKILL.md) : elles s'appliquent à toi aussi.
2. Lis [le workflow](workflow.md) : étapes, pistes, portes, statuts, limites.
3. Lis `.claude/team.json`. Absent ou `"initialized": false` → dis-le et propose
   `/team-init`. Tu peux planifier sans, mais aucune exécution ni contrôle.
4. `git status` et `git branch --show-current` : note les changements existants de
   l'utilisateur, tu ne les touches pas.
5. Si la demande commence par `reprendre` : lis `.agent-runs/<id>/state.json` et
   reprends à l'étape indiquée par `status`. Sinon, nouveau run.

## 1. Démarrer un run

- Identifiant : `AAAA-MM-JJ-<slug-court>` (ajoute `-2`, `-3`… s'il existe déjà).
- Crée `.agent-runs/<id>/request.md` (la demande telle quelle) et `state.json` d'après
  [le modèle](templates/state.json) : vide `tasks` et `log`, et recopie dans `checks`
  chaque contrôle de `team.json` avec `"status": "not_run"`.
- Après **chaque** écriture de `state.json`, vérifie-le depuis la racine du projet :
  `node .claude/skills/team/scripts/check-state.mjs .agent-runs/<id>/state.json`.
  Une erreur se corrige avant de continuer, sans contourner la règle : ce script fait
  respecter les portes.
- Seul l'utilisateur valide les portes plan et livraison, ou accorde une dérogation
  (`waived`) : `by: "user"`, uniquement après sa réponse explicite.

## 2. Qualifier et choisir la piste

Applique les critères du workflow (§ Pistes). Annonce en une ligne la piste choisie et
pourquoi, avec les ambiguïtés repérées. L'utilisateur peut changer de piste.

## 3. Déléguer

Lance l'agent `planner` (champ `subagent_type`) avec une délégation **autonome** : il
ne voit pas cette conversation. Elle contient la demande, le chemin du run, le mode
(`spec`, `plan` ou `spec+plan`), les réponses déjà obtenues ou la spec validée.

À son retour :
- **vérifie** le livrable (workflow § Revue du plan) ; un livrable incomplet repart au
  planner avec ce qui manque, sans compter comme tentative de l'utilisateur ;
- enregistre `spec.md` / `plan.md` dans le run, recopie le bloc des tâches dans
  `state.json` (`tasks`) et mets à jour son `log` ;
- `needs_input` → pose les questions à l'utilisateur, regroupées et numérotées ;
  réponses dans `answers`, puis nouveau passage du planner ;
- piste full : présente la spécification seule et obtiens l'accord de l'utilisateur
  (événement `spec_approved` dans `log`) avant de demander le plan.

Les agents de relecture sont en lecture seule : c'est toi qui enregistres leur rapport
(`review-1.md`, `review-2.md`…) et le verdict dans `state.json`.

## 4. Porte 1 — validation du plan

Présente un résumé court : objectif, critères d'acceptation, tâches (id, titre,
dépendances, `requiresHuman`), risques, hors périmètre, chemin de `plan.md`.
Demande une validation explicite. Sans « oui » clair, le plan n'est pas validé :
modifications → nouveau passage du planner.

Validé → `gates.plan` à `passed` (avec `by: "user"`), tâches à `ready`, statut
`ready_for_execution`.

## 5. Après la porte 1

Dans cette version, **l'exécution par les agents n'est pas encore disponible**
(agent `implementer` prévu à l'incrément suivant). Arrête-toi au statut
`ready_for_execution` et dis à l'utilisateur comment reprendre :
`/team reprendre <id>`.

Exception : la **piste quick**, que tu exécutes toi-même (workflow § Piste quick).

## 6. Synthèse finale

Toujours, même en cas de blocage : ce qui a été fait, ce qui a été vérifié (avec
statuts réels), ce qui reste à valider, et le chemin du run.

## Règles de l'orchestrateur

- Un livrable qui affirme « terminé » sans preuve n'est pas terminé.
- Agents désactivés dans `team.json` (`agents`) : ne les lance pas ; dis ce qui manque.
- Au-delà de `maxClarificationRounds` ou de `maxAttempts` : statut `blocked`, raison
  dans `state.json`, la main revient à l'utilisateur.
- Ne relance pas aveuglément une opération qui a pu avoir des effets de bord : vérifie
  d'abord l'état (`git status`, fichiers).
