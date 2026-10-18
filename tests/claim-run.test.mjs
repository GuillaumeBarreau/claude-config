import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { claimRun } from '../template/.claude/skills/team/scripts/claim-run.mjs';
import { templateCopy, writeFile } from './helpers.mjs';

/** Projet installé avec un run en exécution, ouvert par la session S1. */
function setup(overrides = {}) {
  const root = templateCopy();
  const state = JSON.parse(readFileSync(join(root, '.claude/skills/team/templates/state.json'), 'utf8'));
  Object.assign(state, { status: 'executing', sessionId: 'S1', branch: 'team/x' }, overrides);
  // Plan non validé : on reste en v1 pour ne pas dépendre de check-plan ici.
  delete state.schemaVersion;
  state.gates.plan = { status: 'passed', by: 'user', at: null, notes: '' };
  state.tasks[0].status = 'ready';
  const statePath = join(root, '.agent-runs', state.id, 'state.json');
  writeFile(statePath, JSON.stringify(state, null, 2));
  return { root, id: state.id, statePath, read: () => JSON.parse(readFileSync(statePath, 'utf8')) };
}
const claim = (root, ...args) => spawnSync(process.execPath, [join(root, '.claude/skills/team/scripts/claim-run.mjs'), ...args],
  { encoding: 'utf8', cwd: root });
const keepRunning = (root, payload) => {
  const res = spawnSync(process.execPath, [join(root, '.claude/hooks/team/keep-running.mjs')],
    { input: JSON.stringify(payload), encoding: 'utf8', cwd: root });
  return res.stdout.trim() ? JSON.parse(res.stdout) : null;
};

test('claimRun : nouvelle session et événement run_resumed', () => {
  const state = { id: 'r', sessionId: 'S1', log: [] };
  const out = claimRun(state, 'S2', '2026-10-18T12:00:00Z');
  assert.equal(out.sessionId, 'S2');
  assert.equal(out.updatedAt, '2026-10-18T12:00:00Z');
  assert.deepEqual(out.log.at(-1), { at: '2026-10-18T12:00:00Z', actor: 'claim-run', event: 'run_resumed', detail: 'session S1 → S2' });
  // Même session : rien à faire.
  assert.equal(claimRun(out, 'S2', 'x').log.length, 1);
});

test('claim-run puis keep-running : le hook suit la session qui reprend le run', () => {
  const { root, id, read } = setup();
  const payload = (session) => ({ session_id: session, stop_hook_active: false });
  assert.equal(keepRunning(root, payload('S2')), null);

  const res = claim(root, 'reprendre', id, 'S2');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(read().sessionId, 'S2');
  assert.equal(read().log.at(-1).event, 'run_resumed');

  assert.equal(keepRunning(root, payload('S2'))?.decision, 'block');
  assert.equal(keepRunning(root, payload('S1')), null);
});

test('claim-run : sans objet hors « reprendre » (0), run introuvable ou invalide (1)', () => {
  const { root, id, read, statePath } = setup();
  assert.equal(claim(root, 'corriger', 'le', 'S2').status, 0);
  assert.equal(claim(root, 'corriger').status, 0);
  assert.equal(read().sessionId, 'S1');

  assert.equal(claim(root, 'reprendre', 'inconnu', 'S2').status, 1);
  assert.equal(claim(root, 'reprendre', '../etc', 'S2').status, 1);
  assert.equal(claim(root, 'reprendre', id).status, 1);
  assert.equal(claim(root, 'reprendre', id, '').status, 1);

  writeFile(statePath, '{ pas du json');
  assert.equal(claim(root, 'reprendre', id, 'S2').status, 1);
});
