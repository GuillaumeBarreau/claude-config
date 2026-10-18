// ci-wait.mjs : attente de la CI après le push, avec réponses gh enregistrées.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkState } from '../template/.claude/skills/team/scripts/check-state.mjs';
import { ciWait } from '../template/.claude/skills/team/scripts/ci-wait.mjs';
import { reopenRun } from '../template/.claude/skills/team/scripts/gh.mjs';
import { SHA, deliveredState, fakeClock, fakeExec, fixture, makeProject, readState } from './gh-fixtures.mjs';

const routes = (runList, extra = {}) => ({
  'git rev-parse team/r1': { stdout: `${SHA}\n` },
  'gh pr view team/r1 --json number,url': { stdout: fixture('pr-view.json') },
  'gh run list': { stdout: typeof runList === 'string' ? fixture(runList) : JSON.stringify(runList) },
  'gh run view': (line) => ({ stdout: `journal de ${line.split(' ')[3]}\nError: expected 2, got 3\n` }),
  ...extra,
});

function wait(project, exec, clock, opts = {}) {
  const out = ciWait({ runDir: project.runDir, claudeDir: project.claudeDir, exec, now: clock.now, sleep: clock.sleep, ...opts });
  // Tout état écrit doit respecter check-state (règles R4/R5 du schéma 2 comprises).
  assert.deepEqual(out.stateErrors ?? [], [], 'état écrit invalide : ' + out.message);
  return out;
}

/** Structure §2.1 de l'objet ci, vérifiée ici tant que check-state ne la connaît pas. */
function assertCiShape(ci) {
  assert.ok(['pending', 'passed', 'failed', 'n/a'].includes(ci.status), `ci.status ${ci.status}`);
  assert.equal(ci.sha, SHA);
  assert.ok(!Number.isNaN(Date.parse(ci.startedAt)), 'ci.startedAt');
  assert.ok(Number.isInteger(ci.rounds) && ci.rounds >= 0, 'ci.rounds');
  assert.ok(Array.isArray(ci.runs));
  for (const r of ci.runs) {
    assert.deepEqual(Object.keys(r).sort(), ['conclusion', 'id', 'log', 'name', 'url']);
  }
}

test('ci-wait : CI verte → run done, PR enregistrée, jamais de gh run watch', () => {
  const project = makeProject();
  const { exec, calls } = fakeExec(routes('run-list-success.json'));
  const out = wait(project, exec, fakeClock());
  assert.equal(out.code, 0);
  const state = readState(project.runDir);
  assert.equal(state.status, 'done');
  assertCiShape(state.ci);
  assert.equal(state.ci.status, 'passed');
  assert.deepEqual(state.ci.runs.map((r) => r.id), [9001, 9002], 'seuls les runs du SHA poussé comptent');
  assert.deepEqual(state.pr, { number: 42, url: 'https://github.com/acme/app/pull/42' });
  assert.ok(state.log.some((e) => e.event === 'ci_passed'));
  assert.ok(calls.some((c) => c.startsWith('gh run list --branch team/r1 --json databaseId,headSha,status,conclusion,workflowName,url --limit 50')));
  assert.ok(!calls.some((c) => /run watch/.test(c)));
  assert.deepEqual(checkState(state), []);
});

test('ci-wait : CI rouge avec --create-task → tâche CI1, journaux, run rouvert', () => {
  const project = makeProject();
  const { exec } = fakeExec(routes('run-list-failure.json'));
  const out = wait(project, exec, fakeClock(), { createTask: true });
  assert.equal(out.code, 1);
  const state = readState(project.runDir);
  assertCiShape(state.ci);
  assert.equal(state.ci.status, 'failed');
  assert.equal(state.ci.rounds, 1);
  const failed = state.ci.runs.find((r) => r.id === 9101);
  assert.equal(failed.log, 'ci/9101.log');
  assert.match(readFileSync(join(project.runDir, 'ci/9101.log'), 'utf8'), /expected 2, got 3/);
  assert.equal(state.ci.runs.find((r) => r.id === 9102).log, null, 'pas de journal pour un run réussi');

  const task = state.tasks.find((t) => t.id === 'CI1');
  assert.equal(task.origin, 'ci');
  assert.deepEqual(task.files, []);
  assert.equal(task.status, 'ready');
  assert.match(task.description, /ci\/9101\.log/);
  assert.equal(state.status, 'executing');
  assert.equal(state.branch, 'team/r1');
  for (const gate of ['checks', 'review', 'delivery']) assert.equal(state.gates[gate].status, 'pending', gate);
  assert.equal(state.gates.plan.status, 'passed');
  for (const event of ['ci_failed', 'ci_task_created', 'run_reopened']) assert.ok(state.log.some((e) => e.event === event), event);
  assert.deepEqual(checkState(state), []);
});

test('ci-wait : CI rouge sans --create-task → reste awaiting_ci, sortie 1', () => {
  const project = makeProject();
  const { exec } = fakeExec(routes('run-list-failure.json'));
  assert.equal(wait(project, exec, fakeClock()).code, 1);
  const state = readState(project.runDir);
  assert.equal(state.status, 'awaiting_ci');
  assert.equal(state.ci.status, 'failed');
  assert.equal(state.tasks.length, 1);
});

test('ci-wait : tours de correction épuisés → blocked', () => {
  const previous = { status: 'failed', sha: '0'.repeat(40), startedAt: '2026-10-18T09:00:00Z', checkedAt: null, rounds: 2, runs: [] };
  const project = makeProject({ state: deliveredState({ ci: previous }) });
  const { exec } = fakeExec(routes('run-list-failure.json'));
  const out = wait(project, exec, fakeClock(), { createTask: true });
  assert.equal(out.code, 1);
  const state = readState(project.runDir);
  assert.equal(state.status, 'blocked');
  assert.match(state.blockedReason, /2 tour/);
  assert.equal(state.ci.rounds, 2, 'les tours se cumulent d\'un push à l\'autre');
  assert.ok(!state.tasks.some((t) => t.id.startsWith('CI')));
  assert.deepEqual(checkState(state), []);
});

test('ci-wait : maxFixRounds de team.json respecté (0 → blocked dès le premier échec)', () => {
  const project = makeProject({ team: { ci: { enabled: true, timeoutMinutes: 30, maxFixRounds: 0 } } });
  const { exec } = fakeExec(routes('run-list-failure.json'));
  wait(project, exec, fakeClock(), { createTask: true });
  assert.equal(readState(project.runDir).status, 'blocked');
});

test('ci-wait : aucun workflow pour le SHA après le délai de grâce → n/a, run done', () => {
  const project = makeProject();
  const { exec } = fakeExec(routes('run-list-other-sha.json'));
  const clock = fakeClock();
  const out = wait(project, exec, clock, { maxWaitS: 540, intervalS: 20 });
  assert.equal(out.code, 0);
  const state = readState(project.runDir);
  assert.equal(state.ci.status, 'n/a');
  assert.equal(state.status, 'done');
  assert.ok(clock.now() - Date.parse(state.ci.startedAt) >= 120_000, 'le délai de grâce de 120 s est respecté');
  assert.deepEqual(checkState(state), []);
});

test('ci-wait : CI en cours → sortie 3 (relancer), puis reprise jusqu\'au succès', () => {
  const project = makeProject();
  const clock = fakeClock();
  const pending = fakeExec(routes('run-list-in-progress.json'));
  assert.equal(wait(project, pending.exec, clock, { maxWaitS: 60, intervalS: 20 }).code, 3);
  const first = readState(project.runDir);
  assert.equal(first.status, 'awaiting_ci');
  assertCiShape(first.ci);
  assert.equal(first.ci.status, 'pending');
  assert.ok(first.ci.checkedAt);
  assert.ok(pending.calls.filter((c) => c.startsWith('gh run list')).length >= 3, 'interroge à chaque intervalle');

  const done = fakeExec(routes('run-list-success.json'));
  assert.equal(wait(project, done.exec, clock).code, 0);
  const second = readState(project.runDir);
  assert.equal(second.status, 'done');
  assert.equal(second.ci.startedAt, first.ci.startedAt, 'même SHA : l\'attente continue, startedAt conservé');
});

test('ci-wait : sans workflow avant la fin de la grâce → en attente (3)', () => {
  const project = makeProject();
  const { exec } = fakeExec(routes([]));
  assert.equal(wait(project, exec, fakeClock(), { maxWaitS: 60, intervalS: 20 }).code, 3);
  assert.equal(readState(project.runDir).ci.status, 'pending');
});

test('ci-wait : délai ci.timeoutMinutes dépassé → blocked', () => {
  const clock = fakeClock();
  const startedAt = new Date(clock.now() - 31 * 60_000).toISOString();
  const ci = { status: 'pending', sha: SHA, startedAt, checkedAt: startedAt, rounds: 0, runs: [] };
  const project = makeProject({ state: deliveredState({ status: 'awaiting_ci', ci }) });
  const { exec } = fakeExec(routes('run-list-in-progress.json'));
  assert.equal(wait(project, exec, clock).code, 1);
  const state = readState(project.runDir);
  assert.equal(state.status, 'blocked');
  assert.match(state.blockedReason, /30 min/);
  assert.deepEqual(checkState(state), []);
});

test('ci-wait : gh non authentifié → sortie 2, run blocked avec raison explicite', () => {
  const project = makeProject();
  const { exec } = fakeExec(routes(null, { 'gh run list': { code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' } }));
  const out = wait(project, exec, fakeClock());
  assert.equal(out.code, 2);
  assert.match(out.message, /gh auth login/);
  const state = readState(project.runDir);
  assert.equal(state.status, 'blocked', 'plus de statut actif : keep-running ne relance pas en boucle');
  assert.match(state.blockedReason, /^gh absent ou non authentifié : .*gh auth login/);
  assert.equal(state.ci.status, 'pending');
  assert.deepEqual(checkState(state), []);
});

test('ci-wait : gh introuvable → sortie 2, run blocked', () => {
  const project = makeProject();
  const { exec } = fakeExec(routes(null, {
    'gh pr view': { code: 127, stderr: 'gh : spawnSync gh ENOENT' },
    'gh run list': { code: 127, stderr: 'gh : spawnSync gh ENOENT' },
  }));
  assert.equal(wait(project, exec, fakeClock()).code, 2);
  const state = readState(project.runDir);
  assert.equal(state.status, 'blocked');
  assert.match(state.blockedReason, /^gh absent ou non authentifié : .*ENOENT/);
});

test('ci-wait : autre erreur gh (réseau) → sortie 2, le run reste awaiting_ci', () => {
  const project = makeProject();
  const { exec } = fakeExec(routes(null, { 'gh run list': { code: 1, stderr: 'error connecting to api.github.com' } }));
  assert.equal(wait(project, exec, fakeClock()).code, 2);
  assert.equal(readState(project.runDir).status, 'awaiting_ci');
});

test('ci-wait : state.json écrit avant l\'attente (processus tué pendant la boucle)', () => {
  const project = makeProject();
  const clock = fakeClock();
  let seen = null;
  const { exec } = fakeExec(routes(null, {
    'gh run list': () => {
      seen = readState(project.runDir);
      throw new Error('processus tué par le délai de l\'outil Bash');
    },
  }));
  assert.throws(() => wait(project, exec, clock), /processus tué/);
  assert.equal(seen.status, 'awaiting_ci', 'awaiting_ci écrit avant la première interrogation');
  assertCiShape(seen.ci);
  assert.equal(seen.ci.status, 'pending');
  assert.equal(seen.ci.startedAt, new Date(clock.now()).toISOString());
  assert.deepEqual(checkState(seen), []);

  // Relance 5 min plus tard : startedAt conservé, le délai de grâce compte depuis le début.
  clock.advance(5 * 60_000);
  const other = fakeExec(routes('run-list-other-sha.json'));
  assert.equal(wait(project, other.exec, clock, { maxWaitS: 30, intervalS: 20 }).code, 0);
  const state = readState(project.runDir);
  assert.equal(state.ci.startedAt, seen.ci.startedAt);
  assert.equal(state.ci.status, 'n/a');
});

test('ci-wait : --max-wait vaut 90 s par défaut (sous le délai de 120 s de l\'outil Bash)', () => {
  const project = makeProject();
  const clock = fakeClock();
  const start = clock.now();
  const { exec } = fakeExec(routes('run-list-in-progress.json'));
  assert.equal(wait(project, exec, clock).code, 3);
  assert.ok(clock.now() - start <= 90_000, `attente de ${(clock.now() - start) / 1000} s`);
});

test('ci-wait : run blocked par le délai de CI → reprise explicite (awaiting_ci, startedAt remis à maintenant)', () => {
  const clock = fakeClock();
  const old = new Date(clock.now() - 40 * 60_000).toISOString();
  const ci = { status: 'pending', sha: SHA, startedAt: old, checkedAt: old, rounds: 1, runs: [] };
  const blocked = { status: 'blocked', blockedReason: 'CI : délai de 30 min dépassé sans résultat pour 1111111', ci };
  const project = makeProject({ state: deliveredState(blocked) });
  const { exec } = fakeExec(routes('run-list-in-progress.json'));
  assert.equal(wait(project, exec, clock, { maxWaitS: 40, intervalS: 20 }).code, 3);
  const state = readState(project.runDir);
  assert.equal(state.status, 'awaiting_ci');
  assert.equal(state.blockedReason, null);
  assert.equal(state.ci.status, 'pending');
  assert.equal(state.ci.rounds, 1);
  assert.ok(Date.parse(state.ci.startedAt) > Date.parse(old), 'startedAt remis à maintenant');
  assert.ok(state.log.some((e) => e.event === 'ci_resumed'));

  const ok = makeProject({ state: deliveredState(blocked) });
  assert.equal(wait(ok, fakeExec(routes('run-list-success.json')).exec, fakeClock()).code, 0);
  assert.equal(readState(ok.runDir).status, 'done');
});

test('ci-wait : run blocked sans CI en attente (tours épuisés) → sortie 2, rien n\'est modifié', () => {
  const ci = { status: 'failed', sha: SHA, startedAt: '2026-10-18T09:00:00Z', checkedAt: null, rounds: 2, runs: [] };
  const project = makeProject({ state: deliveredState({ status: 'blocked', blockedReason: 'CI en échec après 2 tour(s)', ci }) });
  const before = readFileSync(project.statePath, 'utf8');
  const { exec, calls } = fakeExec(routes('run-list-success.json'));
  assert.equal(wait(project, exec, fakeClock()).code, 2);
  assert.equal(calls.length, 0);
  assert.equal(readFileSync(project.statePath, 'utf8'), before);
});

test('ci-wait : état résultant invalide → sortie 4, state.json non écrit', () => {
  const state = deliveredState();
  state.tasks[0].status = 'bogus';
  const project = makeProject({ state });
  const before = readFileSync(project.statePath, 'utf8');
  const { exec } = fakeExec(routes('run-list-success.json'));
  const out = ciWait({ runDir: project.runDir, claudeDir: project.claudeDir, exec, ...fakeClock() });
  assert.equal(out.code, 4);
  assert.ok(out.stateErrors.length);
  assert.equal(readFileSync(project.statePath, 'utf8'), before);
});

test('ci-wait : run pas encore livré → sortie 2 sans rien modifier', () => {
  const state = deliveredState({ status: 'reviewing' });
  const project = makeProject({ state });
  const { exec, calls } = fakeExec(routes('run-list-success.json'));
  assert.equal(wait(project, exec, fakeClock()).code, 2);
  assert.equal(calls.length, 0);
  const notDelivered = makeProject({ state: deliveredState({ gates: { ...state.gates, delivery: { status: 'pending', by: null, at: null, notes: '' } } }) });
  assert.equal(wait(notDelivered, exec, fakeClock()).code, 2);
});

test('ci-wait : ci.enabled false → sans objet (0), rien n\'est modifié', () => {
  const project = makeProject({ team: { ci: { enabled: false } } });
  const before = readFileSync(project.statePath, 'utf8');
  const { exec, calls } = fakeExec(routes('run-list-success.json'));
  assert.equal(wait(project, exec, fakeClock()).code, 0);
  assert.equal(calls.length, 0);
  assert.equal(readFileSync(project.statePath, 'utf8'), before);
});

test('ci-wait : journal d\'échec tronqué à 200 Ko en gardant la fin', () => {
  const project = makeProject();
  const big = `${'x'.repeat(300 * 1024)}\nFIN DU JOURNAL\n`;
  const { exec } = fakeExec(routes('run-list-failure.json', { 'gh run view 9101 --log-failed': { stdout: big } }));
  wait(project, exec, fakeClock());
  const log = join(project.runDir, 'ci/9101.log');
  assert.ok(existsSync(log));
  assert.ok(statSync(log).size <= 200 * 1024);
  assert.match(readFileSync(log, 'utf8'), /FIN DU JOURNAL\n$/);
});

test('reopenRun : tâches ready, portes pending avec note, executing, événement', () => {
  const state = deliveredState({ status: 'done' });
  reopenRun(state, [{ id: 'PR1', title: 't', description: 'd', status: 'draft' }], 'commentaires de PR', '2026-10-18T13:00:00Z');
  assert.equal(state.status, 'executing');
  assert.equal(state.tasks.at(-1).status, 'ready');
  for (const gate of ['checks', 'review', 'delivery']) {
    assert.equal(state.gates[gate].status, 'pending');
    assert.match(state.gates[gate].notes, /commentaires de PR/);
  }
  assert.equal(state.gates.plan.status, 'passed');
  assert.equal(state.log.at(-1).event, 'run_reopened');
  assert.throws(() => reopenRun(state, [{ id: 'PR1' }], 'x'), /déjà présente/);
});
