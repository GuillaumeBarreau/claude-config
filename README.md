# claude-config

Une petite équipe d'agents Claude Code pour le développement logiciel, installable dans
n'importe quel projet. Elle transforme une demande en spécification, puis en plan
vérifié, exécute les tâches une à une (code, périmètre, contrôles, relecture, commit),
prépare une PR, puis suit la CI et les commentaires de relecture. Elle relit aussi les
PR de tes collègues (`/team-review`) et ne publie que ce que tu as validé. **Push, PR et
fusion restent humains.**

> État : **v0.10.0**. Tout ce qui est décrit ici est implémenté et couvert par des tests
> unitaires (hooks lancés avec leurs vrais payloads, `gh` et `claude` simulés). Rien
> n'a encore été éprouvé sur un run réel complet : c'est le rôle du
> [banc d'essai](bench/README.md). La revue de PR n'a encore tourné sur aucune vraie PR
> (voir ses [limites](docs/REVIEW.md#limites-connues)). Voir le [CHANGELOG](CHANGELOG.md).

## L'équipe

| Rôle                         | Forme                                  | Écrit                         |
| ---------------------------- | -------------------------------------- | ----------------------------- |
| Orchestrateur / tech lead    | Skill `/team`, dans ta session         | État du run, commits, synthèse|
| `cc-planner` (PO + architecte)  | Sous-agent, lecture seule, Opus        | Spécification, plan, consultations, redécoupages |
| `cc-implementer` (développeur, par défaut) | Sous-agent, Sonnet (Opus en escalade) | Code et tests d'une tâche mixte ou sans spécialiste |
| `cc-implementer-backend`        | Sous-agent, Sonnet (Opus en escalade)  | Code et tests d'une tâche côté serveur (API, données, sécurité) |
| `cc-implementer-frontend`       | Sous-agent, Sonnet (Opus en escalade)  | Code et tests d'une tâche côté interface (composants, accessibilité, états) |
| `cc-documentation`              | Sous-agent, Sonnet                     | README, docs/, CHANGELOG, ADR d'après le diff |
| `cc-expert`                     | Sous-agent, Fable (le plus capable), effort max | Logique complexe (algorithme, concurrence, états, bug de cause inconnue), dernier recours en correction |
| `cc-code-reviewer` (relecture + QA) | Sous-agent, lecture seule, Opus    | Verdict et constats           |
| `cc-analyste` (audit proactif)    | Sous-agent, lecture seule, Opus    | Constats classés et issues prêtes |

Le planner attribue chaque tâche à un développeur selon ses fichiers (tout back,
tout front, documentation seule, sinon `cc-implementer`) ; `check-plan` refuse un agent
inconnu ou désactivé dans `team.json`. Les trois implementers partagent une procédure
commune (skill `team-implementer`) ; les spécialistes préchargent en plus les
conventions **propres au projet** (`conventions-backend`, `conventions-frontend`),
générées par `/team-init` en lisant le code et jamais écrasées par une mise à jour.
Un spécialiste se désactive dans `team.json` (`agents`) si le projet n'a pas ce côté.

Chaque agent termine par un **livrable JSON** vérifié par un hook : l'orchestrateur et
les autres agents le lisent tel quel, sans reformulation.

Tous les agents installés par claude-config portent le préfixe `cc-` : ils ne se
confondent pas avec les agents propres au projet (`code-reviewer`, `planner`…), et les
hooks de l'équipe ne visent qu'eux (ADR 0012). Les skills (`/team`, `/team-review`…) ne
sont pas préfixées.

Agents de la revue de PR (`/team-review`, hors workflow `/team`) :

| Rôle                         | Forme                                  | Écrit                         |
| ---------------------------- | -------------------------------------- | ----------------------------- |
| `cc-pr-reviewer-frontend`       | Sous-agent, lecture seule, Opus 5.5 (effort medium) | Constats et brouillons de commentaires sur la partie interface |
| `cc-pr-reviewer-backend`        | Sous-agent, lecture seule, Opus 5.5 (effort medium) | Constats et brouillons de commentaires sur la partie serveur |
| `cc-pr-reviewer-architecture`   | Sous-agent, lecture seule, Opus 5.5 (effort medium) | Constats sur les contrats entre couches, consommateurs non touchés, déploiement |
| `cc-pr-verifier`                | Sous-agent, lecture seule, Opus 5.5 (effort medium) | Verdict sur chaque constat grave, sans voir le raisonnement du relecteur |

```
/team <demande> → cc-planner (spec + plan) → check-plan → porte 1
  → pour chaque tâche : développeur de la tâche → check-scope → run-checks → cc-code-reviewer → commit
      question technique → cc-planner (consultation) ; question produit → toi
      échec → correction sur un modèle plus fort, puis par l'agent cc-expert, puis redécoupage, puis blocage
  → run-checks final → pr.md vérifié par check-pr → porte 4 (push / PR brouillon avec ton accord)
  → ci-wait : CI rouge → tâche corrective ; commentaires de PR → tâches de correction
  → leçons du run, mesures
```

Trois pistes (`quick`, `standard`, `full`) et quatre portes : plan validé (par toi, ou
par l'orchestrateur en mode `autonomous` quand aucune tâche ne touche une zone
sensible), contrôles obligatoires réussis (posés par `run-checks.mjs`), relecture sans
constat bloquant, accord explicite avant push et PR. Détail :
[workflow](template/.claude/skills/team/workflow.md).

Les PR suivent des [conventions](template/.claude/skills/team/pr-conventions.md) : une PR
par run, un commit par tâche, titre au format des commits du projet, sections
obligatoires, statuts des contrôles identiques à ceux enregistrés, brouillon par
défaut, et jamais de fusion par un agent.

## Vérifications déterministes

Ce qu'on peut vérifier ne repose pas sur le jugement du modèle :

| Script            | Vérifie |
| ----------------- | ------- |
| `check-plan`      | Chaque critère couvert, tâches fidèles au plan, fichiers existants ou déclarés nouveaux, dépendances, zones sensibles ⇒ validation humaine |
| `check-scope`     | Fichiers réellement modifiés par une tâche comparés au plan ; zone sensible ⇒ accord |
| `run-checks`      | Contrôles du projet exécutés, journaux et porte 2 écrits par le script |
| `check-pr`        | `pr.md` conforme aux conventions et aux statuts réels du run |
| `check-state`     | Aucun état de run qui contourne une porte |
| `ci-wait`, `pr-comments` | CI après push, commentaires de PR transformés en tâches |
| `findings` (revue de PR) | Fusion des constats, étiquettes, ancrage dans le diff, suivi d'une version de la PR à l'autre |
| `publish` (revue de PR) | Seuls les constats validés partent, PR inchangée depuis la relecture, jamais deux fois |

## Les garde-fous

Des hooks Node (Windows compris), fusionnés dans le `.claude/settings.json` du projet.

| Hook                | Effet |
| ------------------- | ----- |
| `guard-bash`        | Refuse commit ou push sur la branche de base, fusion de PR, `Co-Authored-By`, `--no-verify`, lecture de `.env`, `rm -rf` massif. Demande ton accord pour push, PR, publication, actions destructives, nouvelle dépendance, écriture sur GitHub, publication d'une revue de PR (`publish.mjs` sans `--dry-run`) et préparation en lot (`review-batch.mjs --yes`) |
| `guard-files`       | Refuse les fichiers de secrets. Les développeurs (`cc-implementer`, `cc-implementer-backend`, `cc-implementer-frontend`, `cc-documentation`, `cc-expert`) n'écrivent ni dans `.claude/` ni dans `.agent-runs/`. Demande ton accord pour modifier les garde-fous |
| `check-run-state`   | Vérifie chaque `state.json` écrit : un état qui contourne une porte revient au modèle |
| `check-deliverable` | Renvoie un agent au travail si son livrable JSON manque ou est invalide |
| `record-metrics`    | Mesures par run (appels, durée, outils, rejets) |
| `keep-running`      | Empêche l'orchestrateur de s'arrêter tant que le run progresse |

## Installation dans un projet

Prérequis : Node ≥ 20, Git, Claude Code ; `gh` authentifié pour la CI et les PR.

```bash
git clone <ce dépôt> claude-config
node claude-config/install.mjs <chemin/du/projet> --dry-run   # voir ce qui changerait
node claude-config/install.mjs <chemin/du/projet>             # appliquer (demande s'il faut ignorer .claude/ dans Git)
node claude-config/install.mjs <chemin/du/projet> --local     # usage personnel : rien de visible pour Git ni pour les collègues
```

`--local` écrit les réglages dans `.claude/settings.local.json`, ne touche pas au
`.gitignore` et inscrit chaque fichier installé (jamais `.claude/` en entier) dans
l'exclusion locale du dépôt (`.git/info/exclude`), dans un bloc réécrit à chaque mise à
jour. Deux limites : `git clean -fdx` supprime la configuration installée (relancer
l'installation), et un fichier déjà suivi par Git ne peut pas être caché (il est
signalé). Détail dans [docs/USAGE.md](docs/USAGE.md).

Puis, dans le projet : lancer Claude Code et taper `/team-init` pour découvrir et
valider les commandes de contrôle et les réglages. Ensuite : `/team <ta demande>`.

Pour mettre à jour un projet, `git pull` dans `claude-config` puis relancer
`install.mjs`. Les fichiers que tu as modifiés dans le projet ne sont jamais écrasés :
ils sont signalés en conflit. Depuis une version antérieure à 0.10 (agents sans préfixe
`cc-`) : les anciens agents intacts sont retirés et les clés `agents` de `team.json`
renommées, réglages conservés. Usage détaillé : [docs/USAGE.md](docs/USAGE.md).

## Revue de PR

`/team-review <n>` relit la PR d'un collègue, te fait trier les remarques et publie une
seule revue GitHub (`COMMENT`) avec ce que tu as validé, après un aperçu et ton accord.
Sur ta propre PR, il écrit une liste de corrections locale et n'envoie rien.

```
/team-review <n> → pr-fetch (PR, CI, diff, fichiers par axe)
  → cc-pr-reviewer-frontend / -backend / -architecture (en parallèle, selon les fichiers)
  → findings → cc-pr-verifier (constats graves, sans le raisonnement) → findings
  → triage par toi : rapport local (127.0.0.1) ou conversation
  → publish --dry-run → ton accord → publish (une revue GitHub) ou fixes.md (ta PR)
```

Étiquettes `MUST`, `SHOULD`, `COULD`, `ASK` ; commentaires en français ; suivi des
constats d'une version de la PR à l'autre ; magasin personnel `.agent-reviews/`, ignoré
par Git. Les agents lisent le code **au commit de la PR** (`git show`, ou un worktree
jetable avec `--worktree`), jamais ta branche à sa place, et rien ne change ta copie de
travail. Détail et limites : [docs/REVIEW.md](docs/REVIEW.md).

## Autres skills

- `/team-review` : revue de PR (voir ci-dessus). `list` pour les PR ouvertes et leur
  état, `stats` pour la justesse des agents, `--prepare` pour relire sans trier.
- `/team-audit` : lance l'agent `cc-analyste` pour explorer le code (bugs, dette
  technique, sécurité, améliorations), présente les constats classés et crée des issues
  GitHub `agent-ready` avec ton accord.
- `/team-next` : prend la prochaine issue GitHub prête et la réalise avec `/team`.
  Avec `/goal`, enchaîne les issues jusqu'à ce qu'il n'en reste plus (voir
  [docs/USAGE.md](docs/USAGE.md)).
- `/team-backlog` : simulation du traitement automatique des issues GitHub marquées
  `agent-ready`. Le mode réel se planifie hors session (cron, Planificateur de tâches
  Windows, GitHub Actions), sans push ni PR par défaut. Voir
  [docs/BACKLOG.md](docs/BACKLOG.md).
- `/team-init`, `which-surface` (choisir entre hook, CLAUDE.md, sous-agent, skill ou
  rien).

## Vue d'ensemble

```
┌──────────────── /team-audit ─────────────────┐
│                                               │
│  ┌───────────┐  constats   ┌──────────────┐  │
│  │cc-analyste│────────────▶│ utilisateur  │  │
│  └───────────┘             │  approuve ?  │  │
│                            └──────┬───────┘  │
│                                   ▼          │
│                          gh issue create     │
│                          (agent-ready)       │
└──────────────────────────────────────────────┘

┌──────────────── /team <demande> ─────────────┐
│                                               │
│  demande ──▶ cc-planner ──▶ check-plan ──▶ P1│
│                                          │    │
│              ┌───────────────────────────┘    │
│              ▼  (pour chaque tâche)           │
│  ┌──────────────────────────────────────────┐ │
│  │ développeur ──▶ check-scope              │ │
│  │      ──▶ run-checks (P2)                 │ │
│  │      ──▶ cc-code-reviewer (P3) ──▶ commit│ │
│  │                                           │ │
│  │ échec ──▶ escalade ──▶ cc-expert         │ │
│  │       ──▶ redécoupage ──▶ blocked        │ │
│  └──────────────────────────────────────────┘ │
│              ▼                                │
│  pr.md + check-pr ──▶ P4 (accord) ──▶ push  │
│  ──▶ ci-wait ──▶ pr-comments ──▶ done        │
└──────────────────────────────────────────────┘

P1 = porte plan   P2 = porte contrôles
P3 = porte revue  P4 = porte livraison
```

```
         ┌─────────┐
         │  user   │
         └────┬────┘
              │ /team
              ▼
     ┌────────────────┐
     │  orchestrateur  │◀─── team-rules
     │    (/team)      │◀─── workflow.md
     └──┬──┬──┬──┬──┬─┘
        │  │  │  │  │
  spec/ │  │  │  │  │ review
  plan  │  │  │  │  │
   ┌────┘  │  │  │  └────┐
   ▼       │  │  │       ▼
┌────────┐ │  │  │  ┌──────────┐
│planner │ │  │  │  │  code-   │
│ (opus) │ │  │  │  │ reviewer │
└────────┘ │  │  │  │  (opus)  │
           │  │  │  └──────────┘
      code │  │  │
   ┌───────┘  │  └───────┐
   ▼          ▼          ▼
┌──────┐ ┌────────┐ ┌────────┐
│back- │ │implmtr │ │front-  │
│end   │ │(défaut)│ │end     │
└──────┘ └────────┘ └────────┘
              │
     escalade │
              ▼
         ┌────────┐  ┌────────────┐
         │ expert │  │documentation│
         │(fable) │  └────────────┘
         └────────┘
```

## Banc d'essai

`bench/` lance `/team` en vrai sur un petit projet d'essai et vérifie le résultat
(état du run, portes, Git, fichiers, coût estimé). Il lance un vrai `claude -p` (usage décompté de ton abonnement, ou facturé avec une clé API) :
`npm run bench -- run <scénario|all> --yes [--budget-usd <n>]`. `npm run bench -- list`,
`prepare` et `verify` n'appellent jamais claude, et `npm run check` non plus.
Scénarios : `quick-bug`, `standard-feature`, `ambiguous`, `sensitive`. Détail :
[bench/README.md](bench/README.md).

## Ce que contient le dépôt

```
template/.claude/     ce qui est installé dans un projet (agents, skills, hooks, settings.json, team.json)
install.mjs           installation et mise à jour, avec manifeste et détection des conflits
validate.mjs          contrôle d'une config (template ou projet installé)
bench/                banc d'essai de bout en bout (appelle l'API, hors CI)
tests/                tests de l'installeur, du validateur, des scripts, des hooks et du banc
docs/                 usage, revue de PR, ajout d'un agent, backlog, décisions (ADR)
```

Vérifier le dépôt : `npm run check` (validateur puis tests, aucune dépendance).

## Origine

Les pratiques de garde-fous viennent du système d'agents de Chatlock.
