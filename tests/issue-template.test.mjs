import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { install } from '../install.mjs';
import { READY_SECTIONS, dependencyRefs, missingSections } from '../template/.claude/skills/team-backlog/scripts/issue-queue.mjs';
import { TEMPLATE_CLAUDE, tempDir } from './helpers.mjs';

const TEMPLATE_PATH = join(TEMPLATE_CLAUDE, 'skills/team-init/issue-template.md');
const SKILL_PATH = join(TEMPLATE_CLAUDE, 'skills/team-init/SKILL.md');
const read = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/** Corps du modèle : ce qui suit le front matter. */
function templateBody() {
  const m = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(read(TEMPLATE_PATH));
  assert.ok(m, 'front matter absent');
  return m[1];
}

const headings = (text) => text.split('\n').filter((l) => /^#{1,6}(\s|$)/.test(l));

test('le modèle a un front matter de modèle d\'issue sans le label agent-ready', () => {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(read(TEMPLATE_PATH))?.[1] ?? '';
  assert.match(front, /^name: .+$/m);
  assert.match(front, /^about: .+$/m);
  assert.match(front, /^title: ''$/m);
  assert.match(front, /^labels: ''$/m);
  assert.doesNotMatch(front, /agent-ready/);
});

test('AC9 : les titres du modèle sont exactement les rubriques de READY_SECTIONS, dans l\'ordre', () => {
  // Les titres dans les commentaires HTML (exemples) ne comptent pas.
  const visible = templateBody().replace(/<!--[\s\S]*?-->/g, '');
  assert.deepEqual(headings(visible), READY_SECTIONS.map((s) => `## ${s.label}`));
});

test('un modèle non rempli est « non prêt » : les trois rubriques manquent', () => {
  assert.deepEqual(missingSections(templateBody()), READY_SECTIONS.map((s) => s.label));
});

test('chaque rubrique remplie devient prête', () => {
  const body = templateBody();
  const filled = READY_SECTIONS.reduce((text, { label }) => text.replace(`## ${label}\n`, `## ${label}\nContenu de test.\n`), body);
  assert.deepEqual(missingSections(filled), []);
  for (const { label } of READY_SECTIONS) {
    const only = body.replace(`## ${label}\n`, `## ${label}\nContenu de test.\n`);
    assert.deepEqual(missingSections(only), READY_SECTIONS.map((s) => s.label).filter((l) => l !== label));
  }
});

test('le modèle ne déclare aucune dépendance : le commentaire d\'aide n\'est pas lu', () => {
  assert.match(templateBody(), /D[ée]pend de #/, 'l\'aide doit montrer la ligne « Dépend de #n »');
  assert.deepEqual(dependencyRefs(read(TEMPLATE_PATH)), { numbers: [], unreadable: [] });
});

test('le commentaire d\'aide mentionne les labels de priorité', () => {
  for (const p of ['P0', 'P1', 'P2']) assert.ok(read(TEMPLATE_PATH).includes(p), p);
});

test('team-init/SKILL.md : écriture après accord explicite, jamais d\'écrasement', () => {
  const skill = read(SKILL_PATH);
  assert.ok(skill.includes('issue-template.md'));
  assert.ok(skill.includes('.github/ISSUE_TEMPLATE/agent-ready.md'));
  assert.match(skill, /accord explicite/);
  assert.match(skill, /n['’]écrase jamais|jamais (?:d['’])?écras/i);
  assert.match(skill, /seulement les différences/);
  assert.ok(skill.includes('priorityLabels'));
  assert.ok(skill.includes('["P0","P1","P2"]'));
});

test('installation : le modèle est installé avec la skill, .github/ISSUE_TEMPLATE n\'est pas créé', () => {
  const projectDir = tempDir('projet-');
  install({ templateDir: TEMPLATE_CLAUDE, projectDir, version: 'test' });
  assert.ok(existsSync(join(projectDir, '.claude/skills/team-init/issue-template.md')));
  assert.equal(existsSync(join(projectDir, '.github/ISSUE_TEMPLATE')), false);
});
