// pr-comments.mjs : commentaires de PR → constats et tâche corrective, avec réponses
// gh enregistrées.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { evaluateCommand } from '../template/.claude/hooks/team/guard-bash.mjs';
import { checkState } from '../template/.claude/skills/team/scripts/check-state.mjs';
import { checkFinding } from '../template/.claude/skills/team/scripts/deliverable.mjs';
import { parseJsonValues } from '../template/.claude/skills/team/scripts/gh.mjs';
import { prComments } from '../template/.claude/skills/team/scripts/pr-comments.mjs';
import { deliveredState, fakeExec, fixture, makeProject, readState } from './gh-fixtures.mjs';

const PR = { number: 42, url: 'https://github.com/acme/app/pull/42' };
const doneState = (overrides = {}) => deliveredState({
  status: 'done', pr: PR, prComments: { processed: ['issue-IC_kwDOA0'], rounds: 0 }, ...overrides,
});
const pages = JSON.parse(fixture('pulls-comments-pages.json'));
const routes = (extra = {}) => ({
  'gh pr view 42 --json number,url,state,comments,reviews,headRefOid': { stdout: fixture('pr-view-comments.json') },
  // --paginate : un tableau JSON par page, bout à bout.
  'gh api repos/{owner}/{repo}/pulls/42/comments --paginate': { stdout: pages.map((p) => JSON.stringify(p)).join('') },
  ...extra,
});
const fetch = (project, exec, opts = {}) => {
  const out = prComments({ runDir: project.runDir, claudeDir: project.claudeDir, exec, ...opts });
  // Tout état écrit doit respecter check-state (schéma 2 compris).
  assert.deepEqual(out.stateErrors ?? [], [], 'état écrit invalide : ' + out.message);
  return out;
};

test('pr-comments : un passage → constats filtrés, une seule tâche PR1, run rouvert', () => {
  const project = makeProject({ state: doneState() });
  const { exec, calls } = fakeExec(routes());
  const out = fetch(project, exec, { createTask: true });
  assert.equal(out.code, 1);

  const file = JSON.parse(readFileSync(join(project.runDir, 'pr-comments-1.json'), 'utf8'));
  assert.deepEqual(file.pr, PR);
  assert.ok(file.fetchedAt);
  assert.deepEqual(file.findings.map((f) => f.id).sort(), ['inline-501', 'inline-503', 'issue-IC_kwDOA1', 'review-PRR_kwDOB1']);
  for (const f of file.findings) {
    assert.equal(f.source, 'pr-comment');
    assert.equal(f.severity, 'major');
    assert.equal(f.confidence, 'plausible');
    for (const key of ['problem', 'scenario', 'fix', 'url', 'author']) assert.equal(typeof f[key], 'string', `${f.id}.${key}`);
    assert.ok('file' in f && 'line' in f, f.id);
    const errors = [];
    checkFinding(errors, f, f.id);
    assert.deepEqual(errors, [], `constat ${f.id} conforme au format des livrables`);
  }
  const inline = file.findings.find((f) => f.id === 'inline-501');
  assert.equal(inline.file, 'src/export.js');
  assert.equal(inline.line, 12);
  assert.equal(inline.author, 'alice');
  assert.equal(file.findings.find((f) => f.id === 'inline-503').line, 4, 'ligne d\'origine si la ligne a disparu');
  assert.equal(file.findings.find((f) => f.id === 'issue-IC_kwDOA1').file, 'src/export.js', 'chemin cité dans le texte');
  assert.equal(file.findings.find((f) => f.id === 'review-PRR_kwDOB1').file, '.', 'sans chemin : la racine du projet');

  const state = readState(project.runDir);
  const created = state.tasks.filter((t) => t.origin === 'pr-review');
  assert.equal(created.length, 1, 'une seule tâche par passage');
  assert.equal(created[0].id, 'PR1');
  assert.deepEqual(created[0].files, ['src/export.js'], 'seuls les chemins cités qui existent');
  assert.equal(created[0].requiresHuman, false, 'aucune zone sensible citée');
  assert.match(created[0].description, /pr-comments-1\.json/);
  assert.equal(state.status, 'executing');
  for (const gate of ['checks', 'review', 'delivery']) assert.equal(state.gates[gate].status, 'pending');
  assert.equal(state.prComments.rounds, 1);
  for (const id of ['issue-IC_kwDOA1', 'review-PRR_kwDOB1', 'inline-501', 'inline-503']) assert.ok(state.prComments.processed.includes(id), id);
  for (const event of ['pr_comments_fetched', 'pr_task_created', 'run_reopened']) assert.ok(state.log.some((e) => e.event === event), event);
  assert.deepEqual(checkState(state), []);

  // Les lectures faites par le script ne demandent aucun accord à guard-bash.
  for (const call of calls) assert.equal(evaluateCommand(call, { baseBranch: 'main', currentBranch: () => 'team/r1' }), null, call);
});

test('pr-comments : ignore déjà traités, bots, NONE et CONTRIBUTOR, revues sans texte', () => {
  const project = makeProject({ state: doneState() });
  const { exec } = fakeExec(routes());
  fetch(project, exec);
  const ids = JSON.parse(readFileSync(join(project.runDir, 'pr-comments-1.json'), 'utf8')).findings.map((f) => f.id);
  for (const ignored of ['issue-IC_kwDOA0', 'issue-IC_kwDOA2', 'issue-IC_kwDOA3', 'issue-IC_kwDOA4', 'review-PRR_kwDOB2', 'inline-502']) {
    assert.ok(!ids.includes(ignored), ignored);
  }
});

test('pr-comments : second passage sans nouveauté → 0, rien n\'est écrit', () => {
  const project = makeProject({ state: doneState() });
  const { exec } = fakeExec(routes());
  fetch(project, exec);
  const before = readFileSync(project.statePath, 'utf8');
  const out = fetch(project, exec, { createTask: true });
  assert.equal(out.code, 0);
  assert.equal(readFileSync(project.statePath, 'utf8'), before);
  assert.ok(!existsSync(join(project.runDir, 'pr-comments-2.json')));
});

test('pr-comments : sans --create-task → fichier et ids traités, pas de tâche, statut inchangé', () => {
  const project = makeProject({ state: doneState() });
  const { exec } = fakeExec(routes());
  assert.equal(fetch(project, exec).code, 1);
  const state = readState(project.runDir);
  assert.equal(state.status, 'done');
  assert.equal(state.tasks.length, 1);
  assert.equal(state.prComments.processed.length, 5);
  assert.deepEqual(checkState(state), []);
});

test('pr-comments : --include-bots garde les commentaires de bots', () => {
  const project = makeProject({ state: doneState() });
  const { exec } = fakeExec(routes());
  fetch(project, exec, { includeBots: true });
  const ids = JSON.parse(readFileSync(join(project.runDir, 'pr-comments-1.json'), 'utf8')).findings.map((f) => f.id);
  assert.ok(ids.includes('issue-IC_kwDOA2'));
  assert.ok(ids.includes('inline-502'));
  assert.ok(!ids.includes('issue-IC_kwDOA3'), 'un humain hors association reste filtré');
});

test('pr-comments : prComments.allowedAssociations de team.json', () => {
  const project = makeProject({ state: doneState(), team: { prComments: { allowedAssociations: ['OWNER'] } } });
  const { exec } = fakeExec(routes());
  fetch(project, exec);
  const ids = JSON.parse(readFileSync(join(project.runDir, 'pr-comments-1.json'), 'utf8')).findings.map((f) => f.id);
  assert.deepEqual(ids.sort(), ['inline-501', 'issue-IC_kwDOA1']);
});

test('pr-comments : allowedAssociations vide → valeurs par défaut (OWNER, MEMBER, COLLABORATOR)', () => {
  const project = makeProject({ state: doneState(), team: { prComments: { allowedAssociations: [] } } });
  const { exec } = fakeExec(routes());
  assert.equal(fetch(project, exec).code, 1);
  const ids = JSON.parse(readFileSync(join(project.runDir, 'pr-comments-1.json'), 'utf8')).findings.map((f) => f.id);
  assert.deepEqual(ids.sort(), ['inline-501', 'inline-503', 'issue-IC_kwDOA1', 'review-PRR_kwDOB1']);
});

test('pr-comments : chemin cité en zone sensible → tâche PR requiresHuman', () => {
  const project = makeProject({ state: doneState() });
  writeFileSync(join(project.projectDir, 'package.json'), '{}\n');
  const inline = [{
    author_association: 'OWNER', body: 'Retirer cette dépendance.', html_url: 'https://github.com/acme/app/pull/42#discussion_r601',
    id: 601, line: 3, original_line: 3, path: 'package.json', user: { login: 'alice', type: 'User' },
  }];
  const { exec } = fakeExec(routes({ 'gh api repos/{owner}/{repo}/pulls/42/comments --paginate': { stdout: JSON.stringify(inline) } }));
  assert.equal(fetch(project, exec, { createTask: true }).code, 1);
  const task = readState(project.runDir).tasks.find((t) => t.id === 'PR1');
  assert.ok(task.files.includes('package.json'));
  assert.equal(task.requiresHuman, true);
});

test('pr-comments : état résultant invalide → sortie 4, rien n\'est écrit', () => {
  const state = doneState();
  state.tasks[0].status = 'bogus';
  const project = makeProject({ state });
  const before = readFileSync(project.statePath, 'utf8');
  const out = prComments({ runDir: project.runDir, claudeDir: project.claudeDir, exec: fakeExec(routes()).exec, createTask: true });
  assert.equal(out.code, 4);
  assert.ok(out.stateErrors.length);
  assert.equal(readFileSync(project.statePath, 'utf8'), before);
  assert.ok(!existsSync(join(project.runDir, 'pr-comments-1.json')));
});

test('pr-comments : PR trouvée par la branche si state.pr est absent, puis enregistrée', () => {
  const project = makeProject({ state: doneState({ pr: undefined }) });
  const { exec } = fakeExec(routes({
    'gh pr view team/r1 --json number,url,state,comments,reviews,headRefOid': { stdout: fixture('pr-view-comments.json') },
  }));
  fetch(project, exec);
  assert.deepEqual(readState(project.runDir).pr, PR);
});

test('pr-comments : --create-task sur un run en cours → 2 ; PR fermée → 0 ; erreur gh → 2', () => {
  const running = makeProject({ state: doneState({ status: 'reviewing' }) });
  const before = readFileSync(running.statePath, 'utf8');
  assert.equal(fetch(running, fakeExec(routes()).exec, { createTask: true }).code, 2);
  assert.equal(readFileSync(running.statePath, 'utf8'), before);

  const merged = makeProject({ state: doneState() });
  const view = JSON.stringify({ ...JSON.parse(fixture('pr-view-comments.json')), state: 'MERGED' });
  const out = fetch(merged, fakeExec(routes({ 'gh pr view 42 --json number,url,state,comments,reviews,headRefOid': { stdout: view } })).exec, { createTask: true });
  assert.equal(out.code, 0);
  assert.equal(readState(merged.runDir).tasks.length, 1);

  const broken = makeProject({ state: doneState() });
  const err = fetch(broken, fakeExec(routes({ 'gh api repos/{owner}/{repo}/pulls/42/comments --paginate': { code: 1, stderr: 'HTTP 404: Not Found' } })).exec);
  assert.equal(err.code, 2);
  assert.match(err.message, /404/);
  assert.ok(!existsSync(join(broken.runDir, 'pr-comments-1.json')));
});

test('parseJsonValues : pages JSON bout à bout, chaînes contenant des crochets', () => {
  assert.deepEqual(parseJsonValues('[1,"]"][{"a":"[\\"x"}]\n'), [[1, ']'], [{ a: '["x' }]]);
  assert.deepEqual(parseJsonValues('[]'), [[]]);
  assert.throws(() => parseJsonValues('[1,'), /illisible/);
});
