# 0001 — Architecture de l'équipe d'agents

Date : 2026-10-18 · Statut : acceptée

## Contexte

Objectif : une équipe d'agents de développement (orchestrateur, PO, architecte,
développeurs, QA, relecteur, release) réutilisable dans tous les projets, supervisée,
qui va d'une demande à une PR prête à relire.

Références étudiées :
- Moteurs d'agents autonomes existants : bon cycle planifier → vérifier le plan →
  implémenter → tester → relire → livrer, mais des portes qui ne sont que des
  consignes dans les prompts et une infrastructure disproportionnée.
- Système d'agents de Chatlock : garde-fous déterministes, vérification à codes de
  sortie, worktree par tâche, limite de tentatives. Orienté backlog autonome et lié à
  Chatlock.

## Décision

- **Mécanismes natifs de Claude Code uniquement** : sous-agents, skills, hooks. Pas
  d'agent teams (expérimental, interactif seulement).
- **Dépôt source unique installé dans chaque projet** (`install.mjs`), avec un
  manifeste pour mettre à jour sans écraser les modifications locales. Seule la partie
  propre au projet (`team.json`) est adaptée, par `/team-init`.
- **Orchestrateur dans la session principale** (skill `/team`) : il doit pouvoir poser
  des questions et demander les validations, ce qu'un sous-agent ne peut pas faire.
- **Équipe réduite au départ** : `planner` (PO + architecte), `code-reviewer`
  (relecture + QA), puis `implementer`. Spécialisations plus tard, si un run réel le
  justifie.
- **État en fichiers** dans `.agent-runs/<id>/` (ignoré par Git) ; `state.json` vérifié
  par un script qui fait respecter les portes.
- **Node sans dépendance** pour les scripts : fonctionne sous Windows, contrairement
  aux hooks bash.
- **Exécution séquentielle** : pas de parallélisme tant que l'isolation n'est pas
  éprouvée.

## Conséquences

- Chaque projet a sa copie de `.claude/` ; une mise à jour passe par `install.mjs`.
- Les noms d'agents doivent éviter ceux déjà utilisés par les projets (Chatlock a
  `developer`, `qa`, `reviewer`).
- Les règles laissées au modèle (« ne pas pousser sans accord ») seront doublées par un
  hook de garde à l'incrément 3.
