# 0010 — Agent analyste et audit proactif

Date : 2026-10-24 · Statut : acceptée

## Contexte

L'équipe d'agents couvre le cycle de développement (planification, implémentation,
relecture, documentation), mais rien n'explore proactivement le code pour trouver des
problèmes. Les issues GitHub doivent être créées manuellement, et le code-reviewer fait
une revue statique du diff sans vérifier les critères d'acceptation par exécution.

Trois lacunes :

- aucun agent n'analyse le code en dehors d'un changement en cours ;
- les constats d'une analyse doivent être convertis en issues à la main ;
- la revue du code-reviewer ne teste pas les comportements réels.

## Décision

**Agent `analyste`** en lecture seule (comme le planner et le code-reviewer), lancé par
la skill `/team-audit` et non par `/team`. Deux modes : `audit` (complet) et `targeted`
(ciblé sur un chemin ou un aspect). Six focus : `security`, `debt`, `features`,
`performance`, `architecture`, `all`. Chaque constat porte un `type`, un `issueTitle` et
un `issueBody` au format issue prête (ADR 0009 : trois rubriques Markdown).

**Skill `/team-audit`** — orchestre l'analyste et crée des issues GitHub avec l'accord de
l'utilisateur. Le script `create-issues.mjs` appelle `gh issue create` avec le label
`agent-ready`, rendant les issues directement exploitables par `/team-next`.

**Mode QA du code-reviewer** — activé par `--qa` dans la description de la mission. Le
relecteur lance les tests, vérifie chaque critère d'acceptation par exécution et teste
les cas limites avec des commandes concrètes. Chaque constat `confirmed` cite la commande
et la sortie.

## Conséquences

- L'analyste est hors workflow `/team` : il n'intervient jamais dans la boucle
  d'exécution, n'est pas routé par le planner et n'est pas un développeur au sens de
  `DEVELOPERS`.
- `guard-files` ne le liste pas dans `GUARDED_AGENTS` : il est en lecture seule par ses
  `disallowedTools`.
- Les issues créées par `/team-audit` suivent le format prêt (ADR 0009) et sont
  directement exploitables par `/team-next` et `backlog.mjs`.
- Le mode QA enrichit la relecture sans modifier le verdict ni le format du livrable.

## Alternatives écartées

- **Analyste intégré au workflow `/team`** : l'analyse proactive n'a pas de tâche ni de
  plan ; la forcer dans le routage compliquerait le workflow sans apport.
- **Création automatique des issues** (sans accord) : les issues créées sans validation
  humaine pourraient encombrer le backlog.
- **Mode QA en agent séparé** : quelques lignes de prompt dans le code-reviewer suffisent,
  un agent dédié ajouterait de la complexité sans bénéfice.
