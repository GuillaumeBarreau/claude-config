// Lecture du code de la PR par les agents : la source du round (working-tree, git-show,
// worktree) choisie par pr-fetch, le worktree de revue, et ce qui en dépend
// (findings, review-batch, guard-bash). gh et git simulés par exec, sauf un test sur un
// vrai dépôt (git init) pour le mode worktree.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { evaluateCommand } from '../template/.claude/hooks/team/guard-bash.mjs';
import { mergeFindings } from '../template/.claude/skills/team-review/scripts/findings.mjs';
import { prFetch } from '../template/.claude/skills/team-review/scripts/pr-fetch.mjs';
import { claudeArgs, reviewBatch } from '../template/.claude/skills/team-review/scripts/review-batch.mjs';
import { removeWorktree } from '../template/.claude/skills/team-review/scripts/source.mjs';
import { SOURCE_MODES, checkReview, worktreeDirOf } from '../template/.claude/skills/team-review/scripts/store.mjs';
import { createExec } from '../template/.claude/skills/team/scripts/gh.mjs';
import { fakeExec } from './gh-fixtures.mjs';
import { tempDir, templateCopy } from './helpers.mjs';
import {
  AXES, CAT_FILE, FETCH, NOW, SHA, SHA2, fetched, gitRoutes, guardCtx, makeReviewProject, readReview, reviewText, reviewerDeliverable, routes,
  viewFixture, worktreeRoutes, writeDeliverable,
} from './review-fixtures.mjs';

const SHA3 = '7777777777777777777777777777777777777777';
const VIEW = Object.keys(routes()).find((k) => k.startsWith('gh pr view 42 --json number'));
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const prJson = (project, n = 1) => json(join(project.reviewDir, 'rounds', String(n), 'pr.json'));
const gitCalls = (calls) => calls.filter((c) => c.startsWith('git '));
// Toute commande git qui changerait la copie de travail de l'utilisateur.
const WRITES = /^git (?:-C \S+ )?(checkout|switch|reset|stash|merge|pull|rebase|restore|clean|branch|commit|push)\b/;
const silent = { log: () => {}, warn: () => {} };

// --- pr-fetch : choix de la source ---

test('source : copie de travail sur la tête de la PR → working-tree, sans fetch ni écriture, enregistrée dans review.json et pr.json', () => {
  const project = makeReviewProject();
  const { exec, calls } = fakeExec(routes());
  const out = prFetch({ number: 42, claudeDir: project.claudeDir, exec, now: NOW });
  assert.equal(out.code, 1, out.message);
  const source = { mode: 'working-tree', headSha: SHA, path: project.projectDir };
  assert.deepEqual(out.round.source, source);
  assert.deepEqual(readReview(project.reviewDir).rounds[0].source, source);
  assert.deepEqual(prJson(project).source, source);
  assert.match(out.message, /working-tree/);
  assert.deepEqual(gitCalls(calls), ['git rev-parse HEAD', 'git status --porcelain']);
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(checkReview(readReview(project.reviewDir)), []);
  assert.deepEqual(SOURCE_MODES, ['working-tree', 'git-show', 'worktree']);
});

test('source : working-tree avec des modifications non commitées → avertissement (les agents les liront)', () => {
  const project = makeReviewProject();
  const out = prFetch({ number: 42, claudeDir: project.claudeDir, exec: fakeExec(routes(gitRoutes({ dirty: ' M src/export.js\n?? notes.txt\n' }))).exec, now: NOW });
  assert.equal(out.code, 1, out.message);
  assert.equal(out.round.source.mode, 'working-tree');
  assert.match(out.warnings.join('\n'), /2 fichier\(s\) avec des modifications non commitées/);
  assert.match(out.warnings.join('\n'), /relecteurs/);
});

test('source : copie de travail ailleurs → git-show : fetch dans refs/claude-config, cat-file, rien d\'écrit dans la copie de travail', () => {
  const project = makeReviewProject();
  const { exec, calls } = fakeExec(routes(gitRoutes({ head: SHA2 })));
  const out = prFetch({ number: 42, claudeDir: project.claudeDir, exec, now: NOW });
  assert.equal(out.code, 1, out.message);
  const source = { mode: 'git-show', headSha: SHA, path: null };
  assert.deepEqual(out.round.source, source);
  assert.deepEqual(readReview(project.reviewDir).rounds[0].source, source);
  assert.deepEqual(prJson(project).source, source);
  assert.match(out.message, /git-show/);
  assert.match(out.message, /pas sur la tête de la PR/);
  assert.deepEqual(gitCalls(calls), ['git rev-parse HEAD', FETCH, CAT_FILE(SHA)]);
  assert.ok(!calls.some((c) => WRITES.test(c) || /^git worktree/.test(c)), calls.join('\n'));
  assert.ok(!existsSync(worktreeDirOf(project.reviewDir)));
  for (const call of calls) assert.equal(evaluateCommand(call, guardCtx), null, call);
});

test('source : fetch ou cat-file en échec → 2, rien n\'est écrit', () => {
  for (const [route, re] of [[FETCH, /git fetch/], [CAT_FILE(SHA), /commit .* introuvable/]]) {
    const project = makeReviewProject();
    const { exec, calls } = fakeExec(routes({ ...gitRoutes({ head: SHA2 }), [route]: { code: 128, stderr: 'fatal: boom' } }));
    const out = prFetch({ number: 42, claudeDir: project.claudeDir, exec, now: NOW });
    assert.equal(out.code, 2, route);
    assert.match(out.message, re);
    assert.match(out.message, /boom/);
    assert.ok(!existsSync(project.reviewDir), route);
    assert.ok(!calls.some((c) => WRITES.test(c) || /^git worktree/.test(c)));
  }
  const noGit = makeReviewProject();
  const out = prFetch({ number: 42, claudeDir: noGit.claudeDir, exec: fakeExec(routes({ 'git rev-parse HEAD': { code: 128, stderr: 'fatal: not a git repository' } })).exec, now: NOW });
  assert.equal(out.code, 2);
  assert.match(out.message, /dépôt Git/);
  assert.ok(!existsSync(noGit.reviewDir));
});

test('source : --worktree → worktree créé au commit de la PR sous .agent-reviews, chemin enregistré, ancien worktree retiré avant', () => {
  const project = makeReviewProject();
  const dir = worktreeDirOf(project.reviewDir);
  assert.equal(dir, join(project.reviewDir, 'worktree'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stale.txt'), 'ancien');
  const { exec, calls } = fakeExec(routes({ ...gitRoutes({ head: SHA2 }), ...worktreeRoutes(dir, { head: 'deadbeef' }) }));
  const out = prFetch({ number: 42, claudeDir: project.claudeDir, exec, now: NOW, worktree: true });
  assert.equal(out.code, 1, out.message);
  const source = { mode: 'worktree', headSha: SHA, path: dir };
  assert.deepEqual(out.round.source, source);
  assert.deepEqual(readReview(project.reviewDir).rounds[0].source, source);
  assert.deepEqual(prJson(project).source, source);
  assert.match(out.message, /worktree/);
  assert.deepEqual(gitCalls(calls), [
    'git rev-parse HEAD', FETCH, CAT_FILE(SHA), `git -C ${dir} rev-parse HEAD`,
    `git worktree remove --force ${dir}`, 'git worktree prune', `git worktree add --detach ${dir} ${SHA}`,
  ]);
  assert.ok(!existsSync(join(dir, 'stale.txt')), 'ancien worktree retiré');
  assert.ok(!calls.some((c) => WRITES.test(c)));
  for (const call of calls) assert.equal(evaluateCommand(call, guardCtx), null, call);

  // Demandé explicitement : le worktree l'emporte même si la copie de travail est sur la tête de la PR (sans fetch).
  const onHead = makeReviewProject();
  const dir2 = worktreeDirOf(onHead.reviewDir);
  const second = fakeExec(routes({ ...worktreeRoutes(dir2) }));
  const res = prFetch({ number: 42, claudeDir: onHead.claudeDir, exec: second.exec, now: NOW, worktree: true });
  assert.equal(res.code, 1, res.message);
  assert.equal(res.round.source.mode, 'worktree');
  assert.deepEqual(gitCalls(second.calls), ['git rev-parse HEAD', CAT_FILE(SHA), 'git worktree prune', `git worktree add --detach ${dir2} ${SHA}`]);
});

test('source : worktree add en échec → 2, rien n\'est écrit', () => {
  const project = makeReviewProject();
  const dir = worktreeDirOf(project.reviewDir);
  const out = prFetch({
    number: 42, claudeDir: project.claudeDir, worktree: true, now: NOW,
    exec: fakeExec(routes({ ...gitRoutes({ head: SHA2 }), ...worktreeRoutes(dir), [`git worktree add --detach ${dir}`]: { code: 128, stderr: 'fatal: boom' } })).exec,
  });
  assert.equal(out.code, 2);
  assert.match(out.message, /git worktree add/);
  assert.ok(!existsSync(join(project.reviewDir, 'review.json')));
});

test('source : nouveau round avec --worktree → worktree recréé sur le nouveau commit', () => {
  const project = makeReviewProject();
  const dir = worktreeDirOf(project.reviewDir);
  const first = prFetch({ number: 42, claudeDir: project.claudeDir, exec: fakeExec(routes({ ...gitRoutes({ head: SHA2 }), ...worktreeRoutes(dir) })).exec, now: NOW, worktree: true });
  assert.equal(first.code, 1, first.message);
  assert.ok(existsSync(dir));
  const { exec, calls } = fakeExec(routes({ [VIEW]: { stdout: viewFixture({ headRefOid: SHA3 }) }, ...gitRoutes({ head: SHA2 }), ...worktreeRoutes(dir, { head: SHA }) }));
  const second = prFetch({ number: 42, claudeDir: project.claudeDir, exec, now: NOW, worktree: true });
  assert.equal(second.code, 1, second.message);
  const review = readReview(project.reviewDir);
  assert.deepEqual(review.rounds.map((r) => r.source), [{ mode: 'worktree', headSha: SHA, path: dir }, { mode: 'worktree', headSha: SHA3, path: dir }]);
  assert.deepEqual(prJson(project, 2).source, review.rounds[1].source);
  const remove = calls.indexOf(`git worktree remove --force ${dir}`);
  const add = calls.indexOf(`git worktree add --detach ${dir} ${SHA3}`);
  assert.ok(remove >= 0 && add > remove, calls.join('\n'));
});

test('source : déjà à jour → la source est revérifiée ; inchangée, rien n\'est réécrit ; changée, review.json et pr.json suivent', () => {
  const project = fetched();
  const before = reviewText(project.reviewDir);
  const same = prFetch({ number: 42, claudeDir: project.claudeDir, exec: fakeExec(routes()).exec, now: () => new Date('2026-11-14T10:00:00Z') });
  assert.equal(same.code, 0);
  assert.match(same.message, /working-tree/);
  assert.equal(reviewText(project.reviewDir), before);

  const moved = prFetch({ number: 42, claudeDir: project.claudeDir, exec: fakeExec(routes(gitRoutes({ head: SHA2 }))).exec, now: () => new Date('2026-11-14T10:00:00Z') });
  assert.equal(moved.code, 0);
  assert.match(moved.message, /git-show/);
  const review = readReview(project.reviewDir);
  assert.equal(review.rounds.length, 1);
  assert.deepEqual(review.rounds[0].source, { mode: 'git-show', headSha: SHA, path: null });
  assert.deepEqual(prJson(project).source, review.rounds[0].source);
  assert.equal(review.log.at(-1).event, 'source_changed');
});

test('source : round à jour — worktree manquant recréé avec --worktree ; sans --worktree, un worktree présent est retiré', () => {
  const project = makeReviewProject();
  const dir = worktreeDirOf(project.reviewDir);
  const wt = () => fakeExec(routes({ ...gitRoutes({ head: SHA2 }), ...worktreeRoutes(dir, { head: SHA }) }));
  assert.equal(prFetch({ number: 42, claudeDir: project.claudeDir, exec: wt().exec, now: NOW, worktree: true }).code, 1);
  rmSync(dir, { recursive: true, force: true });
  const before = reviewText(project.reviewDir);
  const again = wt();
  const out = prFetch({ number: 42, claudeDir: project.claudeDir, exec: again.exec, now: NOW, worktree: true });
  assert.equal(out.code, 0, out.message);
  assert.ok(existsSync(dir), 'worktree recréé');
  assert.ok(again.calls.includes(`git worktree add --detach ${dir} ${SHA}`));
  assert.equal(reviewText(project.reviewDir), before, 'même source : rien n\'est réécrit');

  const kept = wt();
  assert.equal(prFetch({ number: 42, claudeDir: project.claudeDir, exec: kept.exec, now: NOW, worktree: true }).code, 0);
  assert.ok(!kept.calls.some((c) => /^git worktree (add|remove)/.test(c)), 'worktree déjà sur le commit : conservé');

  const plain = wt();
  const dropped = prFetch({ number: 42, claudeDir: project.claudeDir, exec: plain.exec, now: NOW });
  assert.equal(dropped.code, 0, dropped.message);
  assert.ok(!existsSync(dir), 'sans --worktree, le worktree est retiré');
  assert.ok(plain.calls.includes(`git worktree remove --force ${dir}`));
  assert.equal(readReview(project.reviewDir).rounds[0].source.mode, 'git-show');
});

test('checkReview : source facultative (revues 0.9), mais si présente : mode connu, headSha, path texte ou null', () => {
  const ok = readReview(fetched().reviewDir);
  assert.deepEqual(checkReview(ok), []);
  const legacy = JSON.parse(JSON.stringify(ok));
  delete legacy.rounds[0].source;
  assert.deepEqual(checkReview(legacy), []);
  for (const [source, re] of [
    [{ mode: 'checkout', headSha: SHA, path: null }, /source\.mode/],
    [{ mode: 'git-show', path: null }, /source\.headSha/],
    [{ mode: 'worktree', headSha: SHA, path: 7 }, /source\.path/],
    ['worktree', /source/],
  ]) {
    const bad = JSON.parse(JSON.stringify(ok));
    bad.rounds[0].source = source;
    assert.match(checkReview(bad).join('\n'), re, JSON.stringify(source));
  }
});

// --- removeWorktree et source.mjs ---

test('removeWorktree : ne vise qu\'un dossier sous .agent-reviews/, ne lance rien sans dossier, supprime même un dossier que git ne reconnaît plus', () => {
  const project = makeReviewProject();
  const dir = worktreeDirOf(project.reviewDir);
  const idle = fakeExec({});
  assert.deepEqual(removeWorktree({ reviewDir: project.reviewDir, claudeDir: project.claudeDir, exec: idle.exec }), { dir, removed: false });
  assert.deepEqual(idle.calls, []);

  mkdirSync(dir, { recursive: true });
  const { exec, calls } = fakeExec(worktreeRoutes(dir));
  assert.deepEqual(removeWorktree({ reviewDir: project.reviewDir, claudeDir: project.claudeDir, exec }), { dir, removed: true });
  assert.deepEqual(calls, [`git worktree remove --force ${dir}`, 'git worktree prune']);
  assert.ok(!existsSync(dir));

  mkdirSync(dir, { recursive: true });
  const stale = fakeExec({ [`git worktree remove --force ${dir}`]: { code: 128, stderr: 'fatal: not a working tree' }, 'git worktree prune': {} });
  assert.equal(removeWorktree({ reviewDir: project.reviewDir, claudeDir: project.claudeDir, exec: stale.exec }).removed, true);
  assert.ok(!existsSync(dir), 'dossier supprimé malgré l\'échec de git worktree remove');

  for (const reviewDir of [join(project.projectDir, 'src'), join(project.projectDir, '.agent-reviews', '..', 'src'), project.projectDir, join(project.projectDir, '.agent-reviews')]) {
    assert.throws(() => removeWorktree({ reviewDir, claudeDir: project.claudeDir, exec: idle.exec }), /\.agent-reviews/, reviewDir);
  }
  assert.deepEqual(idle.calls, []);
});

test('source.mjs --remove-worktree : 0 sans worktree ; 2 hors .agent-reviews ou sans option', () => {
  const root = templateCopy();
  const script = join(root, '.claude/skills/team-review/scripts/source.mjs');
  const cli = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
  const none = cli('.agent-reviews/pr-42', '--remove-worktree');
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /aucun worktree/);
  const outside = cli('src', '--remove-worktree');
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /\.agent-reviews/);
  assert.equal(cli('.agent-reviews/pr-42').status, 2);
  assert.equal(cli().status, 2);
});

// --- Vrai dépôt Git ---

const git = (cwd, ...args) => {
  const res = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')} : ${res.stderr}`);
  return res.stdout.trim();
};

/** Dépôt réel : main sur A (export v1), refs/pull/42/head sur B (export v2) chez origin, copie de travail sur main. */
function gitProject() {
  const projectDir = tempDir('claude-config-review-git-');
  const claudeDir = join(projectDir, '.claude');
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'team.json'), JSON.stringify({ initialized: true, baseBranch: 'main', review: { axes: AXES } }));
  writeFileSync(join(projectDir, '.gitignore'), '.agent-reviews/\n');
  writeFileSync(join(projectDir, 'src', 'export.js'), 'export const version = 1;\n');
  git(projectDir, 'init', '-q', '-b', 'main');
  git(projectDir, 'config', 'core.autocrlf', 'false');
  git(projectDir, 'add', '-A');
  git(projectDir, 'commit', '-q', '-m', 'A');
  const baseSha = git(projectDir, 'rev-parse', 'HEAD');
  git(projectDir, 'switch', '-q', '-c', 'feat');
  writeFileSync(join(projectDir, 'src', 'export.js'), 'export const version = 2;\n');
  git(projectDir, 'commit', '-q', '-am', 'B');
  const headSha = git(projectDir, 'rev-parse', 'HEAD');
  git(projectDir, 'switch', '-q', 'main');
  const origin = tempDir('claude-config-review-origin-');
  git(origin, 'init', '-q', '--bare');
  git(projectDir, 'remote', 'add', 'origin', origin);
  git(projectDir, 'push', '-q', 'origin', 'main', 'feat:refs/pull/42/head');
  const real = createExec(projectDir);
  const gh = fakeExec(routes({ [VIEW]: { stdout: viewFixture({ headRefOid: headSha, baseRefOid: baseSha }) } }));
  const exec = (cmd, args) => (cmd === 'git' ? real(cmd, args) : gh.exec(cmd, args));
  return { projectDir, claudeDir, reviewDir: join(projectDir, '.agent-reviews', 'pr-42'), baseSha, headSha, exec };
}

const untouched = (p) => {
  assert.equal(git(p.projectDir, 'rev-parse', 'HEAD'), p.baseSha, 'HEAD de la copie de travail inchangé');
  assert.equal(git(p.projectDir, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git(p.projectDir, 'status', '--porcelain'), '');
  assert.deepEqual(git(p.projectDir, 'branch', '--format=%(refname:short)').split(/\r?\n/).sort(), ['feat', 'main'], 'aucune branche créée');
  assert.equal(readFileSync(join(p.projectDir, 'src', 'export.js'), 'utf8'), 'export const version = 1;\n');
};
const worktrees = (p) => git(p.projectDir, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((l) => l.startsWith('worktree '));

test('vrai dépôt : --worktree crée le worktree au commit de la PR, sans toucher la copie de travail ; retiré, git worktree list est propre', () => {
  const p = gitProject();
  const dir = worktreeDirOf(p.reviewDir);
  const out = prFetch({ number: 42, claudeDir: p.claudeDir, exec: p.exec, now: NOW, worktree: true });
  assert.equal(out.code, 1, out.message);
  assert.deepEqual(out.round.source, { mode: 'worktree', headSha: p.headSha, path: dir });
  assert.equal(readFileSync(join(dir, 'src', 'export.js'), 'utf8'), 'export const version = 2;\n', 'contenu au commit de la PR');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), p.headSha);
  assert.equal(git(p.projectDir, 'rev-parse', 'refs/claude-config/pr-42'), p.headSha, 'référence de garde, hors refs/heads');
  assert.equal(worktrees(p).length, 2);
  untouched(p);

  const removed = removeWorktree({ reviewDir: p.reviewDir, claudeDir: p.claudeDir, exec: p.exec });
  assert.deepEqual(removed, { dir, removed: true });
  assert.ok(!existsSync(dir));
  assert.equal(worktrees(p).length, 1, 'seule la copie de travail principale reste');
  assert.equal(git(p.projectDir, 'worktree', 'prune', '--dry-run'), '', 'rien à élaguer');
  untouched(p);

  // Round à jour, worktree retiré à la clôture : recréé par --worktree, au même commit.
  const again = prFetch({ number: 42, claudeDir: p.claudeDir, exec: p.exec, now: NOW, worktree: true });
  assert.equal(again.code, 0, again.message);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), p.headSha);
  removeWorktree({ reviewDir: p.reviewDir, claudeDir: p.claudeDir, exec: p.exec });
  untouched(p);
});

test('vrai dépôt : sans --worktree, git-show : le commit est lisible par git show, la copie de travail reste sur main', () => {
  const p = gitProject();
  const out = prFetch({ number: 42, claudeDir: p.claudeDir, exec: p.exec, now: NOW });
  assert.equal(out.code, 1, out.message);
  assert.deepEqual(out.round.source, { mode: 'git-show', headSha: p.headSha, path: null });
  assert.equal(p.exec('git', ['show', `${p.headSha}:src/export.js`]).stdout, 'export const version = 2;\n');
  assert.match(p.exec('git', ['grep', '-n', 'version = 2', p.headSha, '--', 'src']).stdout, /src\/export\.js:1:/);
  assert.equal(worktrees(p).length, 1);
  assert.ok(!existsSync(worktreeDirOf(p.reviewDir)));
  untouched(p);
});

// --- Ce qui dépend de la source ---

test('findings : en mode git-show, le résumé rappelle que les fichiers hors PR ont été lus sur la branche courante', () => {
  const project = fetched({ routes: gitRoutes({ head: SHA2 }) });
  writeDeliverable(project.reviewDir, reviewerDeliverable('backend'));
  const out = mergeFindings({ reviewDir: project.reviewDir, claudeDir: project.claudeDir, exec: fakeExec({}).exec, now: NOW });
  assert.equal(out.code, 0, out.message);
  assert.match(out.message, /git-show : fichiers hors PR lus sur la branche courante/);
  const wt = fetched();
  writeDeliverable(wt.reviewDir, reviewerDeliverable('backend'));
  assert.doesNotMatch(mergeFindings({ reviewDir: wt.reviewDir, claudeDir: wt.claudeDir, exec: fakeExec({}).exec, now: NOW }).message, /git-show/);
});

test('review-batch : --worktree transmis à /team-review seulement s\'il est reçu', () => {
  assert.deepEqual(claudeArgs(7), ['-p', '/team-review 7 --prepare', '--output-format', 'json']);
  assert.deepEqual(claudeArgs(7, { worktree: true }), ['-p', '/team-review 7 --worktree --prepare', '--output-format', 'json']);
  const project = makeReviewProject();
  const dry = reviewBatch({ argv: [], claudeDir: project.claudeDir, exec: fakeExec(routes()).exec, env: {}, now: NOW, ...silent });
  assert.ok(dry.report.prs.length >= 1);
  assert.ok(dry.report.prs.every((p) => !p.command.includes('--worktree')), 'jamais par défaut');
  const dryWt = reviewBatch({ argv: ['--worktree'], claudeDir: project.claudeDir, exec: fakeExec(routes()).exec, env: {}, now: NOW, ...silent });
  assert.ok(dryWt.report.prs.every((p) => /\/team-review \d+ --worktree --prepare/.test(p.command)));
  const { exec, calls } = fakeExec(routes({ 'claude -p /team-review': { stdout: '{}' } }));
  const out = reviewBatch({ argv: ['--yes', '--worktree', '--max', '1'], claudeDir: project.claudeDir, exec, env: {}, now: NOW, ...silent });
  assert.equal(out.code, 0);
  assert.deepEqual(calls.filter((c) => c.startsWith('claude')), ['claude -p /team-review 42 --worktree --prepare --output-format json']);
});

test('guard-bash : les commandes git des trois modes et des agents passent sans question ; worktree remove --force hors .agent-reviews demande un accord', () => {
  const decide = (command) => evaluateCommand(command, guardCtx)?.decision ?? null;
  for (const cmd of [
    'git rev-parse HEAD', 'git status --porcelain', FETCH, CAT_FILE(SHA),
    `git show ${SHA}:src/export.js`, `git grep -n toCsv ${SHA} -- src ui`, `git show ${SHA} --stat`,
    `git worktree add --detach .agent-reviews/pr-42/worktree ${SHA}`, 'git worktree remove --force .agent-reviews/pr-42/worktree',
    'git worktree remove --force C:\\projet\\.agent-reviews\\pr-42\\worktree', 'git worktree remove --force /home/u/projet/.agent-reviews/pr-42/worktree',
    'git worktree prune', 'git worktree list --porcelain', 'git -C .agent-reviews/pr-42/worktree rev-parse HEAD',
    'node .claude/skills/team-review/scripts/pr-fetch.mjs 42 --worktree',
    'node .claude/skills/team-review/scripts/source.mjs .agent-reviews/pr-42 --remove-worktree',
    'node .claude/skills/team-review/scripts/review-batch.mjs --worktree',
  ]) {
    assert.equal(decide(cmd), null, cmd);
  }
  for (const cmd of ['git worktree remove --force ../autre-projet', 'git worktree remove -f C:\\projets\\x', 'git worktree remove --force .claude/worktrees/t1']) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
  assert.equal(decide('git worktree remove ../autre'), null, 'sans --force, git refuse lui-même un worktree modifié');
  assert.equal(decide('node .claude/skills/team-review/scripts/review-batch.mjs --worktree --yes'), 'ask');
});
