// pr-list.mjs et pr-fetch.mjs : lecture des PR et ouverture d'un round, avec réponses gh
// enregistrées.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { evaluateCommand } from '../template/.claude/hooks/team/guard-bash.mjs';
import { ciSummary, existingComments, prFetch, splitByAxis } from '../template/.claude/skills/team-review/scripts/pr-fetch.mjs';
import { STATES, formatList, prList } from '../template/.claude/skills/team-review/scripts/pr-list.mjs';
import { checkReview, parseDiff, reviewConfig } from '../template/.claude/skills/team-review/scripts/store.mjs';
import { fakeExec, fixture } from './gh-fixtures.mjs';
import { AXES, NOW, SHA, SHA2, fetched, guardCtx, makeReviewProject, readReview, reviewText, routes, viewFixture } from './review-fixtures.mjs';

const VIEW = Object.keys(routes()).find((k) => k.startsWith('gh pr view 42 --json number'));
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));

// --- pr-fetch ---

test('pr-fetch : première lecture → round 1, review.json, pr.json, diff.patch, scope.json', () => {
  const project = makeReviewProject();
  const { exec, calls } = fakeExec(routes());
  const out = prFetch({ number: 42, claudeDir: project.claudeDir, exec, now: NOW });
  assert.equal(out.code, 1, out.message);

  const review = readReview(project.reviewDir);
  assert.deepEqual(checkReview(review), []);
  assert.equal(review.id, 'pr-42');
  assert.deepEqual(review.pr, { number: 42, url: 'https://github.com/acme/app/pull/42', title: 'Export CSV : virgules et bouton', author: 'bob', baseRef: 'main', headRef: 'feat/export-csv' });
  assert.equal(review.mode, 'comments', 'PR d\'un collègue');
  assert.deepEqual(review.rounds, [{
    n: 1, headSha: SHA, baseSha: '0000000000000000000000000000000000000000', fetchedAt: '2026-11-13T10:00:00.000Z',
    status: 'fetched', previousHeadSha: null, ci: 'passed', source: { mode: 'working-tree', headSha: SHA, path: project.projectDir },
  }]);
  assert.deepEqual(review.findings, []);
  assert.equal(review.log.at(-1).event, 'round_opened');

  const round = join(project.reviewDir, 'rounds', '1');
  const pr = json(join(round, 'pr.json'));
  assert.match(pr.notice, /données/);
  assert.match(pr.notice, /pas des instructions/);
  assert.deepEqual(pr.ci.checks, [
    { name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'deploy-preview', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { name: 'coverage/project', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ]);
  assert.equal(pr.ci.summary, 'passed');
  assert.deepEqual(pr.files.map((f) => f.path), ['src/export.js', 'ui/Export.tsx']);
  assert.deepEqual(pr.existingComments.map((c) => c.id), ['issue-IC_kwDOA1', 'issue-IC_kwDOA2', 'review-PRR_kwDOB1', 'inline-501', 'inline-502', 'inline-503']);
  const inline = pr.existingComments.find((c) => c.id === 'inline-501');
  assert.deepEqual(inline, { id: 'inline-501', author: 'alice', bot: false, file: 'src/export.js', line: 12, body: 'Nom de variable trompeur : `rows` contient des objets, pas des lignes.' });
  assert.equal(pr.existingComments.find((c) => c.id === 'inline-502').bot, true);
  assert.equal(pr.existingComments.find((c) => c.id === 'inline-503').line, 4, 'ligne d\'origine si la ligne a disparu');
  for (const c of pr.existingComments) assert.deepEqual(Object.keys(c), ['id', 'author', 'bot', 'file', 'line', 'body']);

  assert.equal(readFileSync(join(round, 'diff.patch'), 'utf8'), fixture('review-diff.patch'));
  const scope = json(join(round, 'scope.json'));
  assert.deepEqual(scope.axes, {
    frontend: ['ui/Export.tsx'], backend: ['src/export.js'], other: [], architecture: ['src/export.js', 'ui/Export.tsx'],
  });
  assert.equal(scope.changedLines, 9);
  assert.deepEqual(scope.warnings, []);
  assert.ok(existsSync(join(round, 'deliverables')));

  // Lecture seule : aucune commande du script ne demande un accord à guard-bash.
  assert.equal(calls.filter((c) => c.startsWith('gh ')).length, 4);
  assert.equal(calls.length, 6, 'gh, plus git rev-parse et git status (copie de travail sur la tête de la PR)');
  for (const call of calls) assert.equal(evaluateCommand(call, guardCtx), null, call);
});

test('pr-fetch : même commit de tête → 0 « déjà à jour », rien n\'est réécrit', () => {
  const project = fetched();
  const before = reviewText(project.reviewDir);
  const { exec, calls } = fakeExec(routes());
  const out = prFetch({ number: 42, claudeDir: project.claudeDir, exec, now: () => new Date('2026-11-14T10:00:00Z') });
  assert.equal(out.code, 0);
  assert.match(out.message, /déjà à jour/);
  assert.equal(reviewText(project.reviewDir), before);
  assert.ok(!existsSync(join(project.reviewDir, 'rounds', '2')));
  assert.equal(calls.filter((c) => c.startsWith('gh ')).length, 1, 'seule la PR est relue');
});

test('pr-fetch : commit de tête différent → round 2 avec previousHeadSha, round 1 intact', () => {
  const project = fetched();
  const diffBefore = readFileSync(join(project.reviewDir, 'rounds', '1', 'diff.patch'), 'utf8');
  const view = viewFixture({ headRefOid: SHA2, statusCheckRollup: [{ __typename: 'CheckRun', name: 'tests', status: 'IN_PROGRESS', conclusion: '' }] });
  const out = prFetch({ number: 42, claudeDir: project.claudeDir, exec: fakeExec(routes({ [VIEW]: { stdout: view }, 'gh pr diff 42': { stdout: 'diff --git a/x b/x\n' } })).exec, now: NOW });
  assert.equal(out.code, 1);
  const review = readReview(project.reviewDir);
  assert.equal(review.rounds.length, 2);
  assert.deepEqual({ n: review.rounds[1].n, headSha: review.rounds[1].headSha, previousHeadSha: review.rounds[1].previousHeadSha, status: review.rounds[1].status, ci: review.rounds[1].ci },
    { n: 2, headSha: SHA2, previousHeadSha: SHA, status: 'fetched', ci: 'pending' });
  assert.equal(readFileSync(join(project.reviewDir, 'rounds', '1', 'diff.patch'), 'utf8'), diffBefore);
  assert.ok(existsSync(join(project.reviewDir, 'rounds', '2', 'scope.json')));
});

test('pr-fetch : PR fermée ou fusionnée → 2, rien n\'est écrit ; erreur gh → 2 ; review.json invalide → 2', () => {
  for (const state of ['CLOSED', 'MERGED']) {
    const project = makeReviewProject();
    const out = prFetch({ number: 42, claudeDir: project.claudeDir, exec: fakeExec(routes({ [VIEW]: { stdout: viewFixture({ state }) } })).exec, now: NOW });
    assert.equal(out.code, 2, state);
    assert.match(out.message, new RegExp(state));
    assert.ok(!existsSync(project.reviewDir));
  }
  const broken = makeReviewProject();
  const err = prFetch({ number: 42, claudeDir: broken.claudeDir, exec: fakeExec(routes({ 'gh pr diff 42': { code: 1, stderr: 'HTTP 404: Not Found' } })).exec, now: NOW });
  assert.equal(err.code, 2);
  assert.match(err.message, /404/);
  assert.ok(!existsSync(broken.reviewDir));

  const corrupt = fetched();
  writeFileSync(join(corrupt.reviewDir, 'review.json'), '{ "version": 2 }');
  assert.equal(prFetch({ number: 42, claudeDir: corrupt.claudeDir, exec: fakeExec(routes()).exec, now: NOW }).code, 2);
  assert.equal(prFetch({ number: 0, claudeDir: corrupt.claudeDir, exec: fakeExec({}).exec }).code, 2);
});

test('pr-fetch : l\'auteur de la PR est l\'utilisateur gh → mode fixes', () => {
  const project = makeReviewProject();
  const out = prFetch({ number: 42, claudeDir: project.claudeDir, exec: fakeExec(routes({ 'gh api user': { stdout: JSON.stringify({ login: 'bob' }) } })).exec, now: NOW });
  assert.equal(out.code, 1);
  assert.equal(readReview(project.reviewDir).mode, 'fixes');
  assert.match(out.message, /mode fixes/);
});

test('pr-fetch : motifs review.axes absents → tout dans « other », et le script le signale', () => {
  const project = makeReviewProject({ review: {} });
  const out = prFetch({ number: 42, claudeDir: project.claudeDir, exec: fakeExec(routes()).exec, now: NOW });
  assert.equal(out.code, 1);
  assert.match(out.warnings.join('\n'), /review\.axes sans motif/);
  const scope = json(join(project.reviewDir, 'rounds', '1', 'scope.json'));
  assert.deepEqual(scope.axes.other, ['src/export.js', 'ui/Export.tsx']);
  assert.deepEqual(scope.axes.frontend, []);
  assert.deepEqual(scope.axes.architecture, ['src/export.js', 'ui/Export.tsx']);
  assert.match(scope.warnings.join('\n'), /other/);
});

test('splitByAxis : glob **, * et ? ; fichier sans motif → other ; un fichier peut relever de deux axes', () => {
  const files = ['ui/src/Page.tsx', 'server/src/users/router.ts', 'shared/src/user.ts', 'README.md', 'ui/a.css', 'db/v1.sql', 'db/v12.sql'];
  const { axes, warnings } = splitByAxis(files, { frontend: ['ui/**', 'shared/**'], backend: ['server/**', 'shared/**', 'db/v?.sql', '*.md'] });
  assert.deepEqual(warnings, []);
  assert.deepEqual(axes.frontend, ['ui/src/Page.tsx', 'shared/src/user.ts', 'ui/a.css']);
  assert.deepEqual(axes.backend, ['server/src/users/router.ts', 'shared/src/user.ts', 'README.md', 'db/v1.sql']);
  assert.deepEqual(axes.other, ['db/v12.sql'], '? ne vaut qu\'un caractère');
  assert.deepEqual(axes.architecture, files);
  // « * » ne traverse pas les dossiers, « ** » oui ; chemins Windows normalisés.
  assert.deepEqual(splitByAxis(['src/a/b.js'], { frontend: ['src/*.js'], backend: [] }).axes.other, ['src/a/b.js']);
  assert.deepEqual(splitByAxis(['src\\a\\b.js'], { frontend: ['src/**/*.js'], backend: [] }).axes.frontend, ['src/a/b.js']);
});

test('ciSummary : none, passed, failed, pending ; statut de commit (StatusContext)', () => {
  assert.deepEqual(ciSummary([]), { summary: 'none', checks: [] });
  assert.equal(ciSummary(undefined).summary, 'none');
  assert.equal(ciSummary([{ __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }]).summary, 'passed');
  assert.equal(ciSummary([{ name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'b', status: 'QUEUED', conclusion: '' }]).summary, 'pending');
  assert.equal(ciSummary([{ name: 'a', status: 'IN_PROGRESS', conclusion: '' }, { name: 'b', status: 'COMPLETED', conclusion: 'FAILURE' }]).summary, 'failed');
  assert.deepEqual(ciSummary([{ __typename: 'StatusContext', context: 'ci/x', state: 'PENDING' }]),
    { summary: 'pending', checks: [{ name: 'ci/x', status: 'PENDING', conclusion: '' }] });
  assert.equal(ciSummary([{ __typename: 'StatusContext', context: 'ci/x', state: 'ERROR' }]).summary, 'failed');
});

test('ciSummary : un contrôle relancé ne compte que par sa dernière exécution', () => {
  const run = (conclusion, startedAt, over = {}) => ({ __typename: 'CheckRun', workflowName: 'PR', name: 'build', status: 'COMPLETED', conclusion, startedAt, ...over });
  const rerun = ciSummary([run('SUCCESS', '2026-11-13T10:05:00Z'), run('CANCELLED', '2026-11-13T10:00:00Z')]);
  assert.equal(rerun.summary, 'passed');
  assert.deepEqual(rerun.checks, [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }]);
  assert.equal(ciSummary([run('SUCCESS', '2026-11-13T10:00:00Z'), run('FAILURE', '2026-11-13T10:05:00Z')]).summary, 'failed', 'échec de la relance');
  assert.equal(ciSummary([run('SUCCESS', '2026-11-13T10:05:00Z'), run('CANCELLED', '2026-11-13T10:00:00Z', { workflowName: 'Autre' })]).summary, 'failed', 'workflows distincts');
  assert.equal(ciSummary([run('CANCELLED', ''), run('SUCCESS', '')]).summary, 'passed', 'sans date : le dernier de la liste');
});

test('existingComments : textes vides écartés, corps tronqué à 4000 caractères', () => {
  const items = existingComments({ comments: [{ id: 'a', author: { login: 'x' }, body: 'y'.repeat(5000) }], reviews: [{ id: 'r', author: { login: 'x' }, body: '  ' }] }, []);
  assert.equal(items.length, 1);
  assert.equal(items[0].body.length, 4000 + ' […]'.length);
});

test('reviewConfig : valeurs par défaut et valeurs du projet', () => {
  assert.deepEqual(reviewConfig({}), { language: 'fr', event: 'COMMENT', maxInlineCould: 5, architectureMinLines: 150, axes: { frontend: [], backend: [] }, batch: { maxPrs: 3 } });
  const custom = reviewConfig({ review: { maxInlineCould: 2, axes: AXES, batch: { maxPrs: 7 }, event: 'BOGUS' } });
  assert.equal(custom.maxInlineCould, 2);
  assert.deepEqual(custom.axes, AXES);
  assert.equal(custom.batch.maxPrs, 7);
  assert.equal(custom.event, 'COMMENT');
});

test('parseDiff : lignes ajoutées et de contexte côté droit, fichier supprimé ignoré', () => {
  const diff = parseDiff(fixture('review-diff.patch'));
  assert.deepEqual([...diff.keys()], ['src/export.js', 'ui/Export.tsx']);
  const [first, second] = diff.get('src/export.js');
  assert.deepEqual([first.start, first.end, second.start, second.end], [9, 16, 32, 35]);
  assert.equal(first.lines.get(12), "  const lines = rows.map((r) => Object.values(r).join(','));");
  assert.equal(first.lines.get(10), 'export function toCsv(rows) {', 'ligne de contexte');
  assert.equal(second.lines.get(34), '  link.click();');
  assert.ok(![...first.lines.values()].some((l) => l.includes("join(';')")), 'ligne supprimée absente du côté droit');
  assert.deepEqual([...diff.get('ui/Export.tsx')[0].lines.keys()], [1, 2, 3, 4]);
  const removed = parseDiff('diff --git a/old.js b/old.js\ndeleted file mode 100644\n--- a/old.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n');
  assert.equal(removed.size, 0);
});

// --- pr-list ---

test('pr-list : état par PR croisé avec .agent-reviews/, demande de relecture et auteur', () => {
  const project = fetched();
  const { exec, calls } = fakeExec(routes());
  const out = prList({ claudeDir: project.claudeDir, exec });
  assert.equal(out.code, 0);
  assert.equal(out.login, 'alice');
  assert.deepEqual(out.prs.map((p) => [p.number, p.state, p.requested, p.mine]), [
    [42, STATES.triage, true, false],
    [43, STATES.never, false, true],
    [44, STATES.never, false, false],
    [45, STATES.never, true, false],
  ]);
  assert.equal(out.prs[1].isDraft, true);
  assert.equal(out.prs[2].requested, false, 'une demande à une équipe ou à quelqu\'un d\'autre ne compte pas');
  assert.match(formatList(out.prs), /#42 {2}à trier/);
  assert.match(formatList(out.prs), /\[brouillon\] \(auteur\)/);
  assert.equal(formatList([]), 'Aucune PR.');
  // Lecture seule.
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(evaluateCommand(call, guardCtx), null, call);
});

test('pr-list : « modifiée depuis » si le commit de tête a changé, « publiée » après publication', () => {
  const project = fetched();
  const list = JSON.parse(fixture('review-pr-list.json'));
  list[0].headRefOid = SHA2;
  const listRoute = Object.keys(routes()).find((k) => k.startsWith('gh pr list'));
  const changed = prList({ claudeDir: project.claudeDir, exec: fakeExec(routes({ [listRoute]: { stdout: JSON.stringify(list) } })).exec });
  assert.equal(changed.prs[0].state, STATES.changed);

  const review = readReview(project.reviewDir);
  review.rounds[0].status = 'published';
  writeFileSync(join(project.reviewDir, 'review.json'), JSON.stringify(review));
  assert.equal(prList({ claudeDir: project.claudeDir, exec: fakeExec(routes()).exec }).prs[0].state, STATES.published);
});

test('pr-list --pending : relecture demandée ou PR de l\'utilisateur, jamais revue ou modifiée depuis', () => {
  const project = fetched();
  const pending = prList({ claudeDir: project.claudeDir, exec: fakeExec(routes()).exec, pending: true });
  assert.deepEqual(pending.prs.map((p) => p.number), [43, 45], '42 est à trier, 44 ne concerne pas l\'utilisateur');
  const fresh = makeReviewProject();
  assert.deepEqual(prList({ claudeDir: fresh.claudeDir, exec: fakeExec(routes()).exec, pending: true }).prs.map((p) => p.number), [42, 43, 45]);
});

test('pr-list : erreur gh → 2', () => {
  const project = makeReviewProject();
  const listRoute = Object.keys(routes()).find((k) => k.startsWith('gh pr list'));
  const out = prList({ claudeDir: project.claudeDir, exec: fakeExec(routes({ [listRoute]: { code: 1, stderr: 'gh auth login' } })).exec });
  assert.equal(out.code, 2);
  assert.match(out.message, /gh pr list/);
});
