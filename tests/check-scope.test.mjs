import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkScope, parsePorcelain } from '../template/.claude/skills/team/scripts/check-scope.mjs';
import { checkState } from '../template/.claude/skills/team/scripts/check-state.mjs';
import { templateCopy, writeFile } from './helpers.mjs';

const RUN = '2026-10-18-exemple';
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args],
  { cwd, encoding: 'utf8' });

/** Dépôt Git propre (projet installé + src/cli.js + package.json) et un run non suivi. */
function setup({ tasks, track = 'standard' } = {}) {
  const root = templateCopy();
  writeFile(join(root, 'src/cli.js'), 'console.log(1);\n');
  writeFile(join(root, 'src/util.js'), 'export {};\n');
  writeFile(join(root, 'package.json'), '{}\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const state = JSON.parse(readFileSync(join(root, '.claude/skills/team/templates/state.json'), 'utf8'));
  state.track = track;
  state.tasks[0].files = ['src/cli.js'];
  state.tasks[0].newFiles = ['src/new.js'];
  if (tasks) state.tasks = tasks;
  const runDir = join(root, '.agent-runs', RUN);
  writeFile(join(runDir, 'state.json'), JSON.stringify(state, null, 2));
  const read = () => JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
  return { root, runDir, read };
}
const cli = (root, ...args) => spawnSync(process.execPath, [join(root, '.claude/skills/team/scripts/check-scope.mjs'), ...args],
  { encoding: 'utf8', cwd: root });

test('parsePorcelain : indexé, non indexé, non suivi, renommage vers la destination', () => {
  const out = ' M src/a.js\0M  src/b.js\0?? test/c.test.js\0R  src/new name.js\0src/old.js\0A  .agent-runs/r/x.json\0';
  assert.deepEqual(parsePorcelain(out), ['src/a.js', 'src/b.js', 'test/c.test.js', 'src/new name.js', '.agent-runs/r/x.json']);
});

test('check-scope : fichier prévu, test non prévu, hors plan, package.json sans requiresHuman', () => {
  const { root, runDir, read } = setup();
  writeFile(join(root, 'src/cli.js'), 'console.log(2);\n');
  writeFile(join(root, 'src/new.js'), 'export {};\n');
  writeFile(join(root, 'test/cli.test.js'), 'test\n');
  writeFile(join(root, 'src/util.js'), 'export const x = 1;\n');
  git(root, 'add', 'src/util.js');
  writeFile(join(root, 'package.json'), '{ "dependencies": { "zod": "3" } }\n');
  writeFile(join(root, '.claude/worktrees/w/a.js'), 'x\n');

  const result = checkScope(runDir, { projectDir: root, taskId: 'T1' });
  assert.equal(result.code, 1);
  const scope = read().tasks[0].scope;
  assert.equal(scope.by, 'check-scope');
  assert.equal(scope.status, 'sensitive');
  assert.deepEqual(scope.changed, ['package.json', 'src/cli.js', 'src/new.js', 'src/util.js', 'test/cli.test.js']);
  assert.deepEqual(scope.outOfPlan, ['package.json', 'src/util.js']);
  assert.deepEqual(scope.outOfPlanTests, ['test/cli.test.js']);
  assert.deepEqual(scope.sensitive, [{ path: 'package.json', category: 'dependencies' }]);
  assert.equal(scope.approvedBy, null);
  assert.equal(read().log.at(-1).event, 'scope_deviation');
});

test('check-scope : changements conformes au plan → ok ; requiresHuman couvre les fichiers sensibles', () => {
  const { root, runDir, read } = setup();
  writeFile(join(root, 'src/cli.js'), 'console.log(2);\n');
  writeFile(join(root, 'src/cli.test.js'), 'test\n');
  assert.equal(checkScope(runDir, { projectDir: root, taskId: 'T1' }).code, 0);
  assert.equal(read().tasks[0].scope.status, 'ok');
  assert.equal(read().log.at(-1).event, 'scope_checked');

  const state = read();
  state.tasks[0].files.push('package.json');
  state.tasks[0].requiresHuman = true;
  writeFile(join(runDir, 'state.json'), JSON.stringify(state));
  writeFile(join(root, 'package.json'), '{ "x": 1 }\n');
  assert.equal(checkScope(runDir, { projectDir: root, taskId: 'T1' }).code, 0);
  assert.deepEqual(read().tasks[0].scope.sensitive, []);
});

test('check-scope : renommage compté à la destination ; justification conservée si l\'écart ne change pas', () => {
  const { root, runDir, read } = setup();
  git(root, 'mv', 'src/util.js', 'src/helpers.js');
  checkScope(runDir, { projectDir: root, taskId: 'T1' });
  assert.deepEqual(read().tasks[0].scope.outOfPlan, ['src/helpers.js']);
  assert.equal(read().tasks[0].scope.status, 'deviation');

  const state = read();
  state.tasks[0].scope.justification = 'Renommage demandé en relecture';
  writeFile(join(runDir, 'state.json'), JSON.stringify(state));
  checkScope(runDir, { projectDir: root, taskId: 'T1' });
  assert.equal(read().tasks[0].scope.justification, 'Renommage demandé en relecture');

  writeFile(join(root, 'src/autre.js'), 'x\n');
  checkScope(runDir, { projectDir: root, taskId: 'T1' });
  assert.equal(read().tasks[0].scope.justification, '');
});

test('check-scope : tâche ci ou pr-review (files vide) → pas de hors plan, seules les zones sensibles comptent', () => {
  for (const origin of ['ci', 'pr-review']) {
    const { root, runDir, read } = setup();
    const state = read();
    state.tasks = [{ ...state.tasks[0], id: 'CI1', origin, files: [], newFiles: [] }];
    writeFile(join(runDir, 'state.json'), JSON.stringify(state));
    writeFile(join(root, 'src/cli.js'), 'console.log(2);\n');
    assert.equal(checkScope(runDir, { projectDir: root, taskId: 'CI1' }).code, 0, origin);
    assert.equal(read().tasks[0].scope.status, 'ok', origin);
    assert.deepEqual(read().tasks[0].scope.outOfPlan, [], origin);

    writeFile(join(root, '.github/workflows/ci.yml'), 'on: push\n');
    assert.equal(checkScope(runDir, { projectDir: root, taskId: 'CI1' }).code, 1, origin);
    assert.equal(read().tasks[0].scope.status, 'sensitive', origin);
    assert.deepEqual(read().tasks[0].scope.outOfPlan, [], origin);
  }
});

test('check-scope : piste quick (sans --task) → state.scope, refusé par check-state si sensible', () => {
  const { root, runDir, read } = setup({ track: 'quick', tasks: [] });
  writeFile(join(root, 'src/cli.js'), 'console.log(2);\n');
  assert.equal(checkScope(runDir, { projectDir: root }).code, 0);
  assert.equal(read().scope.status, 'ok');
  assert.deepEqual(read().scope.outOfPlan, []);

  writeFile(join(root, '.github/workflows/ci.yml'), 'on: push\n');
  assert.equal(checkScope(runDir, { projectDir: root }).code, 1);
  assert.deepEqual(read().scope.sensitive, [{ path: '.github/workflows/ci.yml', category: 'ci' }]);
  assert.match(checkState(read()).join('\n'), /piste quick : fichiers sensibles/);
});

test('check-scope (CLI) : 0 conforme, 1 écart, 2 tâche inconnue ou hors dépôt Git', () => {
  const { root } = setup();
  assert.equal(cli(root, `.agent-runs/${RUN}`, '--task', 'T1').status, 0);
  writeFile(join(root, 'src/util.js'), 'changed\n');
  const dev = cli(root, `.agent-runs/${RUN}`, '--task', 'T1');
  assert.equal(dev.status, 1);
  assert.match(dev.stdout, /src\/util\.js/);
  assert.equal(cli(root, `.agent-runs/${RUN}`, '--task', 'T9').status, 2);
  assert.equal(cli(root).status, 2);

  const noGit = templateCopy();
  const state = JSON.parse(readFileSync(join(noGit, '.claude/skills/team/templates/state.json'), 'utf8'));
  writeFile(join(noGit, '.agent-runs', RUN, 'state.json'), JSON.stringify(state));
  assert.equal(cli(noGit, `.agent-runs/${RUN}`, '--task', 'T1').status, 2);
});
