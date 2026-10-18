# 0006 — Leçons, backlog sans surveillance, parallélisme différé

Date : 2026-10-18 · Statut : acceptée

## Contexte

Trois demandes pour aller plus loin dans l'autonomie :
- que l'équipe retienne ce qui a coûté des tours d'un run à l'autre ;
- qu'elle traite des issues GitHub sans qu'on lance chaque run à la main ;
- qu'elle exécute en parallèle les tâches indépendantes d'un plan.

Contraintes héritées : ce qui doit toujours s'appliquer va dans un script
(0002) ; un texte relu par un agent et écrit par un autre agent, ou par un tiers sur
GitHub, est une donnée non fiable.

## Décision

**Leçons : un fichier de données filtré par un script.** En fin de run,
l'orchestrateur écrit `lessons-proposed.json` (au besoin à partir des candidats de
`lessons.mjs suggest`, tirés de l'état : tentatives, contrôles en échec, écarts de
périmètre, constats récurrents) ; `lessons.mjs apply` les ajoute à
`.agent-runs/lessons.md`, ignoré par Git. Le planner et l'implementer le lisent.
Le script n'accepte qu'une phrase d'une ligne (≤ 200 caractères), sans URL, bloc de
code, balise ni caractère invisible, d'un des cinq types connus ; 20 propositions par
run au plus ; dédoublonnage normalisé ; plafond `lessons.maxEntries` (30), les plus
anciennes sortent. Les filtres s'appliquent aussi aux lignes déjà présentes : une ligne
ajoutée à la main hors format disparaît à l'écriture suivante. Le fichier se présente
comme des indices, jamais comme des instructions.
Écartés : CLAUDE.md (commité, chargé partout, ce n'est pas la place d'un retour
d'expérience non relu) ; la mémoire automatique de Claude Code (non filtrable ni
plafonnable par un script).

**Backlog : un script lancé hors session, simulé par défaut.** `backlog.mjs` lance
`claude -p "/team Issue #n : …"` par issue éligible, dans un worktree détaché hors du
dépôt, puis décide de l'issue à partir du `state.json` (`decideOutcome`, fonction pure
testée). Garde-fous : mode réel seulement avec `--yes`, refusé si `CLAUDECODE` est
défini ; aucun push ni PR sauf `backlog.draftPr: true` **et** run prêt (vérifié champ par
champ, plus `check-state`) ; PR toujours en brouillon ; seuls les auteurs autorisés
(`prComments.allowedAssociations`) déclenchent un run ; titre aplati et corps tronqué
à 4 000 caractères ; prompt passé par l'entrée standard, jamais en argument (pas
d'injection via le shell sous Windows) ; budget par issue et nombre d'issues par passage
plafonnés ; un worktree existant n'est jamais écrasé. La skill `team-backlog`
(`disable-model-invocation`) ne lance que `--dry-run`. Exécuteur `gh`/`git`/`claude`
injectable : les tests n'appellent jamais les vrais outils.

**Parallélisme : différé ; `plan-waves.mjs` mesure ce qu'il rapporterait.** Le script
regroupe les tâches restantes en vagues (dépendances satisfaites, aucun fichier commun
dans `files ∪ newFiles`, tâche `requiresHuman` ou sans fichier seule). Il ne lance rien.

Pourquoi pas maintenant (0002 tient toujours) :
- un seul arbre de travail par run : deux `implementer` simultanés y mélangeraient
  leurs changements, et le diff de relecture ne serait plus celui d'une tâche ;
- `isolation: worktree` crée une branche par appel : il faudrait fusionner, gérer les
  conflits hors des fichiers déclarés (un plan sous-estime souvent les fichiers
  touchés), puis relancer les contrôles sur le résultat ;
- les contrôles d'un projet partagent souvent ports, base de données ou caches ;
- aucune mesure ne montre encore que l'attente des tâches domine la durée d'un run.

Conditions pour l'implémenter :
1. **Gain mesuré** : sur au moins dix runs réels (banc d'essai, `metrics.jsonl`),
   `plan-waves` trouve des vagues de deux tâches ou plus dans au moins un tiers des
   runs, et le temps des `implementer` dépasse la moitié de la durée murale.
2. **Périmètre fiable** : `check-scope` montre que les tâches restent dans leurs
   fichiers déclarés (écarts hors tests rares), car la sécurité du parallélisme repose
   sur des ensembles de fichiers disjoints.
3. **Contrôles isolables** par worktree, ou exécutés seulement après fusion.
4. **Un seul écrivain de `state.json`** : l'orchestrateur (déjà le cas : les hooks
   écrivent des fichiers à côté, jamais l'état).
5. **Fusion définie** : une branche de tâche par worktree, partie de la branche du run ;
   après relecture approuvée, l'orchestrateur intègre les tâches une par une
   (un commit par tâche conservé), relance les contrôles sur la branche du run ; un
   conflit renvoie la tâche en exécution séquentielle.
6. **Activation explicite** : `team.json` → `parallel.enabled` (réservé, `false`),
   concurrence plafonnée à deux ou trois tâches.

## Conséquences

- Les agents disposent d'un retour d'expérience borné, que personne n'a à relire avant
  chaque run, sans risque qu'un texte arbitraire devienne une consigne permanente.
- Le backlog peut tourner seul (cron, Planificateur de tâches, GitHub Actions :
  `docs/BACKLOG.md`), mais ne livre rien sans humain par défaut, et jamais au-delà
  d'une PR brouillon.
- `plan-waves` donne la donnée qui manquait pour trancher sur le parallélisme, sans
  ajouter de mécanisme d'exécution.
- À vérifier sur des runs réels : passage du prompt `/team` par l'entrée standard de
  `claude -p`, liste `--allowedTools` suffisante pour un run complet, comportement de
  la branche de base locale dans un worktree détaché, utilité réelle des leçons.
