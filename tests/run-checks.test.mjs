import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkState, planDigest } from '../template/.claude/skills/team/scripts/check-state.mjs';
import { runChecks } from '../template/.claude/skills/team/scripts/run-checks.mjs';
import { templateCopy, writeFile } from './helpers.mjs';

const PASS = 'node -e "process.exit(0)"';
const FAIL = 'node -e "console.log(\'boom\'); process.exit(1)"';

/** Projet installé avec des contrôles et un run en cours d'exécution. */
function setup(checks, { initialized = true } = {}) {
  const root = templateCopy();
  const claudeDir = join(root, '.claude');
  const teamPath = join(claudeDir, 'team.json');
  const team = JSON.parse(readFileSync(teamPath, 'utf8'));
  writeFileSync(teamPath, JSON.stringify({ ...team, initialized, checks }));

  const state = JSON.parse(readFileSync(join(claudeDir, 'skills/team/templates/state.json'), 'utf8'));
  state.status = 'executing';
  state.branch = 'team/2026-10-18-exemple';
  state.gates.plan = { status: 'passed', by: 'user', at: null, notes: '' };
  state.tasks[0].status = 'in_progress';
  state.planCheck = { status: 'passed', at: null, by: 'check-plan', digest: planDigest(state.tasks), errors: [] };
  state.checks = [];
  const runDir = join(root, '.agent-runs', state.id);
  writeFile(join(runDir, 'state.json'), JSON.stringify(state, null, 2));
  const read = () => JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
  return { root, claudeDir, runDir, read };
}

test('contrôles obligatoires réussis : statuts, journaux et porte 2 posés par le script', () => {
  const { claudeDir, runDir, read } = setup([{ name: 'tests', command: PASS, required: true }]);
  const result = runChecks({ claudeDir, runDir });
  assert.equal(result.ok, true);
  const state = read();
  assert.equal(state.checks[0].status, 'passed');
  assert.ok(existsSync(join(runDir, state.checks[0].log)));
  assert.deepEqual(state.gates.checks.status, 'passed');
  assert.equal(state.gates.checks.by, 'run-checks');
  assert.deepEqual(checkState(state), []);
});

test('contrôle obligatoire en échec : porte 2 en échec, résumé de la sortie ; un facultatif ne bloque pas', () => {
  const { claudeDir, runDir, read } = setup([
    { name: 'tests', command: FAIL, required: true },
    { name: 'lint', command: FAIL, required: false },
  ]);
  assert.equal(runChecks({ claudeDir, runDir }).ok, false);
  const state = read();
  assert.equal(state.gates.checks.status, 'failed');
  assert.equal(state.checks[0].status, 'failed');
  assert.match(state.checks[0].summary, /boom/);
  assert.match(readFileSync(join(runDir, state.checks[0].log), 'utf8'), /boom/);

  const { claudeDir: c2, runDir: r2, read: read2 } = setup([
    { name: 'tests', command: PASS, required: true },
    { name: 'lint', command: FAIL, required: false },
  ]);
  assert.equal(runChecks({ claudeDir: c2, runDir: r2 }).ok, true);
  assert.equal(read2().gates.checks.status, 'passed');
});

test('--task : résultat et preuves enregistrés sur la tâche', () => {
  const { claudeDir, runDir, read } = setup([{ name: 'tests', command: PASS, required: true }]);
  runChecks({ claudeDir, runDir, taskId: 'T1' });
  const task = read().tasks[0];
  assert.equal(task.validation.checks, 'passed');
  assert.ok(task.validation.evidence.some((e) => e.includes('checks/')));
  assert.throws(() => runChecks({ claudeDir, runDir, taskId: 'T9' }), /tâche « T9 » absente/);
});

test('sans contrôle configuré : erreur qui renvoie vers /team-init', () => {
  const { claudeDir, runDir } = setup([], { initialized: false });
  assert.throws(() => runChecks({ claudeDir, runDir }), /\/team-init/);
});

test('ligne de commande : 0 si les obligatoires passent, 1 sinon', () => {
  const ok = setup([{ name: 'tests', command: PASS, required: true }]);
  const script = join(ok.claudeDir, 'skills/team/scripts/run-checks.mjs');
  assert.match(execFileSync(process.execPath, [script, ok.runDir], { encoding: 'utf8', cwd: ok.root }), /tests\s+passed/);

  const ko = setup([{ name: 'tests', command: FAIL, required: true }]);
  const script2 = join(ko.claudeDir, 'skills/team/scripts/run-checks.mjs');
  assert.throws(() => execFileSync(process.execPath, [script2, ko.runDir], { stdio: 'pipe', cwd: ko.root }), (err) => err.status === 1);
});
