import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { install } from '../install.mjs';
import { parseFrontmatter, splitList, validate } from '../validate.mjs';
import { TEMPLATE_CLAUDE, TEMPLATE_ROOT, tempDir, templateCopy, writeFile } from './helpers.mjs';

const replaceIn = (path, from, to) => {
  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes(from), `« ${from} » absent de ${path}`);
  writeFileSync(path, text.replace(from, to));
};
const errorsOf = (root) => validate(root).errors.join('\n');

test('le template du dépôt est valide', () => {
  const { errors } = validate(TEMPLATE_ROOT);
  assert.deepEqual(errors, []);
});

test('frontmatter : scalaires, guillemets et listes', () => {
  const fm = parseFrontmatter('---\nname: "planner"\ntools: Read, Grep\nskills:\n  - team-rules\n  - autre\n---\ncorps');
  assert.equal(fm.data.name, 'planner');
  assert.deepEqual(splitList(fm.data.tools), ['Read', 'Grep']);
  assert.deepEqual(fm.data.skills, ['team-rules', 'autre']);
  assert.equal(fm.body, 'corps');
  assert.equal(parseFrontmatter('pas de frontmatter'), null);
  assert.equal(parseFrontmatter('---\nname: x\n'), null);
});

test('splitList garde les parenthèses intactes', () => {
  assert.deepEqual(splitList('Bash(git add *) Bash(git status *), Read'), ['Bash(git add *)', 'Bash(git status *)', 'Read']);
});

test('agent sans model : erreur', () => {
  const root = templateCopy();
  replaceIn(join(root, '.claude/agents/planner.md'), 'model: opus\n', '');
  assert.match(errorsOf(root), /planner\.md : clé obligatoire « model »/);
});

test('effort inconnu : erreur', () => {
  const root = templateCopy();
  replaceIn(join(root, '.claude/agents/planner.md'), 'effort: high', 'effort: extreme');
  assert.match(errorsOf(root), /effort « extreme » inconnu/);
});

test('outils en joker : erreur', () => {
  const root = templateCopy();
  replaceIn(join(root, '.claude/agents/planner.md'), 'tools: Read, Grep, Glob, Bash', 'tools: *');
  assert.match(errorsOf(root), /tools « \* »/);
});

test('name différent du nom de fichier : erreur', () => {
  const root = templateCopy();
  replaceIn(join(root, '.claude/agents/planner.md'), 'name: planner', 'name: architect');
  assert.match(errorsOf(root), /name « architect » ≠ nom du fichier/);
});

test('skill préchargée absente : erreur', () => {
  const root = templateCopy();
  replaceIn(join(root, '.claude/agents/planner.md'), '  - team-rules', '  - inexistante');
  assert.match(errorsOf(root), /skill préchargée « inexistante » introuvable/);
});

test('skill préchargée avec disable-model-invocation : erreur', () => {
  const root = templateCopy();
  replaceIn(join(root, '.claude/skills/team-rules/SKILL.md'), 'user-invocable: false', 'disable-model-invocation: true');
  assert.match(errorsOf(root), /empêche son préchargement/);
});

test('lien cassé dans une skill : erreur', () => {
  const root = templateCopy();
  replaceIn(join(root, '.claude/skills/team/SKILL.md'), '](workflow.md)', '](absent.md)');
  assert.match(errorsOf(root), /lien vers « absent\.md » introuvable/);
});

test('skill dont le name ne correspond pas au dossier : erreur', () => {
  const root = templateCopy();
  replaceIn(join(root, '.claude/skills/team/SKILL.md'), 'name: team\n', 'name: orchestrator\n');
  assert.match(errorsOf(root), /name « orchestrator » ≠ dossier « team »/);
});

test('allowed-tools en joker : erreur', () => {
  const root = templateCopy();
  replaceIn(join(root, '.claude/skills/which-surface/SKILL.md'), 'allowed-tools: Read, Grep, Glob', 'allowed-tools: Bash(*)');
  assert.match(errorsOf(root), /accorde « Bash\(\*\) » sans restriction/);
});

test('team.json : agent activé sans fichier, contrôle incomplet, JSON invalide', () => {
  const root = templateCopy();
  const path = join(root, '.claude/team.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.agents.implementer = true;
  config.checks = [{ name: 'tests', command: 'pytest' }];
  writeFileSync(path, JSON.stringify(config));
  const errors = errorsOf(root);
  assert.match(errors, /agent « implementer » activé mais agents\/implementer\.md absent/);
  assert.match(errors, /checks\[0\] doit avoir name, command et required/);

  writeFileSync(path, '{ invalide');
  assert.match(errorsOf(root), /team\.json : JSON invalide/);
});

test('settings.json invalide : erreur', () => {
  const root = templateCopy();
  writeFile(join(root, '.claude/settings.json'), '{ "hooks": ');
  assert.match(errorsOf(root), /settings\.json : JSON invalide/);
});

test('frontmatter : liste en ligne et texte replié', () => {
  const fm = parseFrontmatter('---\ntools: [Read, "Grep"]\ndescription: >-\n  Relit le code\n  et rend un verdict\nvide: |\nname: x\n---\n');
  assert.deepEqual(fm.data.tools, ['Read', 'Grep']);
  assert.equal(fm.data.description, 'Relit le code et rend un verdict');
  assert.equal(fm.data.vide, '');
  assert.equal(fm.data.name, 'x');
});

test('description repliée vide : erreur', () => {
  const root = templateCopy();
  const path = join(root, '.claude/agents/planner.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace(/^description: .*$/m, 'description: >-'));
  assert.match(errorsOf(root), /planner\.md : clé obligatoire « description »/);
});

test('un lien dans un bloc de code n\'est pas vérifié', () => {
  const root = templateCopy();
  const path = join(root, '.claude/skills/team/SKILL.md');
  writeFileSync(path, readFileSync(path, 'utf8') + '\nExemple : `[a](absent.md)`\n\n```\n[b](absent2.md)\n```\n');
  assert.deepEqual(validate(root).errors, []);
});

test('projet installé : un agent propre au projet minimal ne fait pas échouer la validation', () => {
  const projectDir = tempDir('projet-');
  install({ templateDir: TEMPLATE_CLAUDE, projectDir, version: 'test' });
  writeFile(join(projectDir, '.claude/agents/mon-agent.md'), '---\nname: mon-agent\ndescription: Agent du projet\n---\nCorps\n');
  writeFile(join(projectDir, '.claude/skills/ma-skill/SKILL.md'), 'Pas de frontmatter\n');
  const { errors, warnings } = validate(projectDir);
  assert.deepEqual(errors, []);
  assert.match(warnings.join('\n'), /ma-skill\/SKILL\.md : pas de frontmatter/);

  // Un agent installé par claude-config reste tenu aux règles strictes.
  replaceIn(join(projectDir, '.claude/agents/planner.md'), 'effort: high\n', '');
  assert.match(errorsOf(projectDir), /planner\.md : clé obligatoire « effort »/);
});

test('corps d\'agent trop long : avertissement seulement', () => {
  const root = templateCopy();
  const path = join(root, '.claude/agents/planner.md');
  writeFileSync(path, readFileSync(path, 'utf8') + '\nligne'.repeat(120));
  const { errors, warnings } = validate(root);
  assert.deepEqual(errors, []);
  assert.match(warnings.join('\n'), /planner\.md : corps de \d+ lignes/);
});
