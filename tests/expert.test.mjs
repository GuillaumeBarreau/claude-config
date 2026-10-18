// Agent expert (logique complexe) : développeur à part entière, donc soumis aux mêmes
// garde-fous et au même livrable que les autres développeurs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { evaluateFile, GUARDED_AGENTS } from '../template/.claude/hooks/team/guard-files.mjs';
import { DEVELOPERS, validateDeliverable } from '../template/.claude/skills/team/scripts/deliverable.mjs';
import { parseFrontmatter, splitList } from '../validate.mjs';
import { TEMPLATE_CLAUDE } from './helpers.mjs';

test('expert est un développeur, gardé comme les autres', () => {
  assert.ok(DEVELOPERS.includes('expert'));
  assert.ok(GUARDED_AGENTS.includes('expert'));
  const ctx = { projectDir: '/projet', agentType: 'expert' };
  assert.equal(evaluateFile('Write', { file_path: '/projet/.agent-runs/r/state.json' }, ctx)?.decision, 'deny');
  assert.equal(evaluateFile('Edit', { file_path: '/projet/.claude/settings.json' }, ctx)?.decision, 'deny');
  assert.equal(evaluateFile('Edit', { file_path: '/projet/src/algo.ts' }, ctx), null);
});

test('expert : modèle le plus capable, effort maximal, procédure commune des développeurs', () => {
  const fm = parseFrontmatter(readFileSync(join(TEMPLATE_CLAUDE, 'agents/expert.md'), 'utf8'));
  assert.equal(fm.data.model, 'fable');
  assert.equal(fm.data.effort, 'max');
  assert.deepEqual(splitList(fm.data.skills).sort(), ['team-implementer', 'team-rules']);
});

test('expert : livrable au schéma implementer, vérifié par check-deliverable (matcher SubagentStop)', () => {
  const deliverable = {
    agent: 'expert', run: 'r1', status: 'ready', questions: [], task: 'T1',
    files: [{ path: 'src/algo.ts', change: 'algorithme corrigé' }],
    acceptance: [{ id: 'AC1', status: 'covered', evidence: 'test/algo.test.ts:12' }],
    evidence: [{ command: 'npm test', result: 'passed' }], deviations: [],
  };
  assert.deepEqual(validateDeliverable(deliverable, 'expert'), []);
  const settings = JSON.parse(readFileSync(join(TEMPLATE_CLAUDE, 'settings.json'), 'utf8'));
  const matchers = settings.hooks.SubagentStop.map((g) => g.matcher.split('|'));
  assert.ok(matchers.some((m) => m.includes('expert')));
});

test('team.json : expert activé par défaut', () => {
  const team = JSON.parse(readFileSync(join(TEMPLATE_CLAUDE, 'team.json'), 'utf8'));
  assert.equal(team.agents.expert, true);
});
