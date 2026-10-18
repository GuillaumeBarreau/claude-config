// new-run.mjs : création déterministe d'un run (dates réelles, valeurs de team.json).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkState } from '../template/.claude/skills/team/scripts/check-state.mjs';
import { newRun } from '../template/.claude/skills/team/scripts/new-run.mjs';
import { templateCopy } from './helpers.mjs';

function project(teamPatch = {}) {
  const root = templateCopy();
  const teamPath = join(root, '.claude/team.json');
  const team = { ...JSON.parse(readFileSync(teamPath, 'utf8')), ...teamPatch };
  writeFileSync(teamPath, JSON.stringify(team));
  return { root, claudeDir: join(root, '.claude'), team };
}
const NOW = new Date('2026-10-19T08:30:00.000Z');

test('crée un run valide : date réelle, session, valeurs de team.json, contrôles recopiés', () => {
  const { root, claudeDir, team } = project({
    initialized: true, autonomy: 'autonomous', maxAttempts: 3, baseBranch: 'develop',
    checks: [{ name: 'tests', command: 'npm test', required: true }],
  });
  const out = newRun({ claudeDir, slug: 'export-csv', track: 'standard', sessionId: 'S1', title: 'Export CSV', now: () => NOW });
  assert.equal(out.code, 0);
  assert.equal(out.id, '2026-10-19-export-csv');
  const state = JSON.parse(readFileSync(join(root, '.agent-runs', out.id, 'state.json'), 'utf8'));
  assert.equal(state.createdAt, NOW.toISOString());
  assert.equal(state.updatedAt, NOW.toISOString());
  assert.equal(state.sessionId, 'S1');
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.autonomy, 'autonomous');
  assert.equal(state.baseBranch, 'develop');
  assert.deepEqual(state.limits, { maxAttempts: 3, maxClarificationRounds: 2 });
  assert.deepEqual(state.tasks, []);
  assert.deepEqual(state.checks.map((c) => [c.name, c.status]), [['tests', 'not_run']]);
  assert.equal(state.log.length, 1);
  assert.equal(state.log[0].at, NOW.toISOString());
  assert.equal(state.planCheck, null);
  assert.deepEqual(checkState(state, team), []);
});

test('identifiant déjà pris : suffixe -2, -3 ; numéro d\'issue enregistré', () => {
  const { root, claudeDir } = project();
  const args = { claudeDir, slug: 'bug', track: 'quick', sessionId: 'S1', now: () => NOW };
  assert.equal(newRun(args).id, '2026-10-19-bug');
  assert.equal(newRun(args).id, '2026-10-19-bug-2');
  const third = newRun({ ...args, issue: 12 });
  assert.equal(third.id, '2026-10-19-bug-3');
  assert.equal(JSON.parse(readFileSync(join(root, '.agent-runs', third.id, 'state.json'), 'utf8')).issue, 12);
});

test('entrées invalides refusées sans rien écrire : slug, piste, session', () => {
  const { root, claudeDir } = project();
  for (const bad of [{ slug: '../x' }, { slug: 'Avec Espace' }, { track: 'rapide' }, { sessionId: '' }]) {
    const out = newRun({ claudeDir, slug: 'ok', track: 'quick', sessionId: 'S1', now: () => NOW, ...bad });
    assert.equal(out.code, 2, JSON.stringify(bad));
  }
  assert.ok(!existsSync(join(root, '.agent-runs', '2026-10-19-ok')));
});

test('ligne de commande : affiche l\'identifiant, sortie 0', () => {
  const { root, claudeDir } = project();
  const script = join(claudeDir, 'skills/team/scripts/new-run.mjs');
  const out = execFileSync(process.execPath, [script, '--slug', 'cli', '--track', 'quick', '--session', 'S9'], { encoding: 'utf8', cwd: root });
  assert.match(out, /\d{4}-\d{2}-\d{2}-cli/);
});
