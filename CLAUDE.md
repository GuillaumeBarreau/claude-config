# claude-config — règles pour faire évoluer la configuration

Ce dépôt produit une configuration Claude Code installée dans d'autres projets. On
modifie ici le **template**, jamais une copie installée.

## Principes

- Simplicité avant sophistication : un mécanisme nouveau doit passer la skill
  `which-surface` (`template/.claude/skills/which-surface/SKILL.md`).
- Ce qui doit toujours s'appliquer va dans un script ou un hook, pas dans un prompt.
- Les règles communes vivent une seule fois, dans `team-rules` ; les agents la
  préchargent avec `skills:`. Ne pas les recopier dans les agents.
- Corps d'agent ≤ 100 lignes ; le détail va dans les fichiers de la skill `team`.
- Distinguer ce qui est implémenté de ce qui est prévu (README, CHANGELOG).

## Structure

- `template/.claude/` : contenu installé. `team.json` appartient au projet après la
  première installation (jamais remplacé).
- `install.mjs`, `validate.mjs` : Node sans dépendance, multiplateforme (Windows
  compris). Pas de bash ni de Python.
- `docs/decisions/` : une décision structurante = un ADR.

## Avant de commiter

`npm run check` doit passer. Un nouveau contrôle ou une nouvelle règle vient avec un
test qu'on a **vu échouer** contre le défaut qu'il attrape.

Mettre à jour `CHANGELOG.md` et la version de `package.json` quand le template change.

Messages de commit et descriptions de PR : jamais de ligne `Co-Authored-By:` ni de
mention d'attribution (« Generated with Claude Code »…).

## Langue

Documentation, prompts et messages en français. Identifiants et code en anglais.
