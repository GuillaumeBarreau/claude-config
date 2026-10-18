// next-issue.mjs (skill /team-next) : choix de la prochaine issue prête, sans vrai gh.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { nextIssue } from '../template/.claude/skills/team-next/scripts/next-issue.mjs';
import { templateCopy, writeFile } from './helpers.mjs';

const issue = (number, extra = {}) => ({
  number, title: `Issue ${number}`, body: `Corps ${number}`, state: 'open',
  labels: [{ name: 'agent-ready' }], author_association: 'OWNER', ...extra,
});

/** Projet installé, team.json initialisé, et faux gh qui répond selon la commande. */
function setup({ issues = [], prs = [], initialized = true } = {}) {
  const root = templateCopy();
  const teamPath = join(root, '.claude/team.json');
  writeFileSync(teamPath, JSON.stringify({ ...JSON.parse(readFileSync(teamPath, 'utf8')), initialized }));
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd !== 'gh') return { status: 1, stdout: '', stderr: 'inattendu' };
    if (args[0] === 'api' && /\/issues\/\d+$/.test(args[1])) {
      const n = Number(args[1].split('/').pop());
      const found = issues.find((i) => i.number === n);
      return found ? { status: 0, stdout: JSON.stringify(found), stderr: '' } : { status: 1, stdout: '', stderr: 'HTTP 404' };
    }
    if (args[0] === 'api') return { status: 0, stdout: JSON.stringify(issues), stderr: '' };
    if (args[0] === 'pr' && args[1] === 'list') return { status: 0, stdout: JSON.stringify(prs), stderr: '' };
    return { status: 1, stdout: '', stderr: 'inattendu' };
  };
  return { root, exec, calls };
}

test('prend la plus ancienne issue prête et rend la demande pour /team', () => {
  const { root, exec } = setup({ issues: [issue(3), issue(5)] });
  const out = nextIssue({ exec, projectDir: root });
  assert.equal(out.code, 0);
  assert.equal(out.issue.number, 3);
  assert.equal(out.request, 'Issue #3 : Issue 3\n\nCorps 3');
});

test('écarte les issues déjà prises : run local, PR ouverte qui la ferme, label agent-working, auteur non autorisé', () => {
  const { root, exec } = setup({
    issues: [
      issue(1),
      issue(2),
      issue(3, { labels: [{ name: 'agent-ready' }, { name: 'agent-working' }] }),
      issue(4, { author_association: 'NONE' }),
      issue(6, { pull_request: {} }),
      issue(7),
    ],
    prs: [{ number: 40, body: 'Résumé…\n\nCloses #2', headRefName: 'team/x' }],
  });
  writeFile(join(root, '.agent-runs/2026-10-18-issue-1/state.json'), JSON.stringify({ id: '2026-10-18-issue-1', issue: 1, status: 'blocked' }));
  writeFile(join(root, '.agent-runs/2026-10-18-ancien/state.json'), JSON.stringify({ id: 'ancien', issue: 7, status: 'cancelled' }));
  const out = nextIssue({ exec, projectDir: root });
  assert.equal(out.code, 0);
  assert.equal(out.issue.number, 7, 'un run annulé ne bloque pas l\'issue');
  const reasons = Object.fromEntries(out.skipped.map((s) => [s.number, s.reason]));
  assert.match(reasons[1], /run local 2026-10-18-issue-1 \(blocked\)/);
  assert.match(reasons[2], /PR #40/);
  assert.match(reasons[3], /agent-working/);
  assert.match(reasons[4], /auteur NONE/);
  assert.match(reasons[6], /pull request/);
});

test('rien à faire : code 3 ; team.json non initialisé ou gh en erreur : code 2', () => {
  assert.equal(nextIssue({ ...pick(setup({ issues: [] })) }).code, 3);
  assert.equal(nextIssue({ ...pick(setup({ issues: [issue(1)], initialized: false })) }).code, 2);
  const { root } = setup();
  assert.equal(nextIssue({ exec: () => ({ status: 1, stdout: '', stderr: 'gh auth login' }), projectDir: root }).code, 2);
});

test('--issue n : cette issue seulement, sans exiger le label ; toujours filtrée', () => {
  const { root, exec } = setup({ issues: [issue(9, { labels: [] }), issue(10, { author_association: 'NONE' })] });
  assert.equal(nextIssue({ exec, projectDir: root, issueNumber: 9 }).issue.number, 9);
  assert.equal(nextIssue({ exec, projectDir: root, issueNumber: 10 }).code, 3);
});

test('corps tronqué et lecture seule : aucun appel gh qui modifie quoi que ce soit', () => {
  const { root, exec, calls } = setup({ issues: [issue(1, { body: 'x'.repeat(10000) })] });
  const out = nextIssue({ exec, projectDir: root });
  assert.ok(out.request.length < 4300, 'corps limité');
  assert.match(out.request, /tronqué/);
  for (const call of calls) {
    assert.doesNotMatch(call, /issue (edit|comment|close)|label (create|edit|delete)|--add-label|pr create| -X|--method| -f |--field/, call);
  }
});

const pick = ({ root, exec }) => ({ projectDir: root, exec });
