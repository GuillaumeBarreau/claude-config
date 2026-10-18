// next-issue.mjs (skill /team-next) : choix de la prochaine issue prête, sans vrai gh.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { main, nextIssue, renderText } from '../template/.claude/skills/team-next/scripts/next-issue.mjs';
import { templateCopy, writeFile } from './helpers.mjs';

// Corps minimal d'une issue prête : les trois rubriques du modèle d'issue.
const readyBody = (text) => `## Objectif\n${text}\n\n## Comportement attendu\nÀ préciser.\n\n## Hors périmètre\nRien d'autre.`;

const issue = (number, extra = {}) => ({
  number, title: `Issue ${number}`, body: readyBody(`Corps ${number}`), state: 'open',
  labels: [{ name: 'agent-ready' }], author_association: 'OWNER', ...extra,
});

/** Projet installé, team.json initialisé, et faux gh qui répond selon la commande. */
function setup({ issues = [], prs = [], initialized = true, backlog = {}, extraIssues = [] } = {}) {
  const root = templateCopy();
  const teamPath = join(root, '.claude/team.json');
  const team = JSON.parse(readFileSync(teamPath, 'utf8'));
  writeFileSync(teamPath, JSON.stringify({ ...team, initialized, backlog: { ...team.backlog, ...backlog } }));
  // Issues lisibles individuellement (dépendances) mais absentes de la liste « agent-ready ».
  const readable = [...issues, ...extraIssues];
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd !== 'gh') return { status: 1, stdout: '', stderr: 'inattendu' };
    if (args[0] === 'api' && /\/issues\/\d+$/.test(args[1])) {
      const n = Number(args[1].split('/').pop());
      const found = readable.find((i) => i.number === n);
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
  assert.equal(out.request, `Issue #3 : Issue 3\n\n${readyBody('Corps 3')}`);
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
  const { root, exec, calls } = setup({ issues: [issue(1, { body: readyBody('Corps 1') + 'x'.repeat(10000) })] });
  const out = nextIssue({ exec, projectDir: root });
  assert.ok(out.request.length < 4300, 'corps limité');
  assert.match(out.request, /tronqué/);
  for (const call of calls) {
    assert.doesNotMatch(call, /issue (edit|comment|close)|label (create|edit|delete)|--add-label|pr create| -X|--method| -f |--field/, call);
  }
});

test('AC7 : une issue au corps vide ou sans rubriques est écartée, la prête suivante est retenue', () => {
  const { root, exec } = setup({ issues: [
    issue(1, { body: '' }),
    issue(2, { body: 'Juste un texte, sans rubriques.' }),
    issue(3, { body: '## Objectif\nFaire X\n\n## Hors périmètre\nY' }),
    issue(4),
  ] });
  const out = nextIssue({ exec, projectDir: root });
  assert.equal(out.code, 0);
  assert.equal(out.issue.number, 4);
  const reasons = Object.fromEntries(out.skipped.map((s) => [s.number, s.reason]));
  assert.equal(reasons[1], 'issue non prête : Objectif, Comportement attendu ou critères, Hors périmètre');
  assert.match(reasons[2], /^issue non prête : Objectif/);
  assert.equal(reasons[3], 'issue non prête : Comportement attendu ou critères');
});

test('AC7 : aucune issue prête → code 3 avec les raisons ; --issue n non prête → code 3 avec la raison', () => {
  const { root, exec } = setup({ issues: [issue(1, { body: '' }), issue(2, { body: 'rien' })] });
  const out = nextIssue({ exec, projectDir: root });
  assert.equal(out.code, 3);
  assert.equal(out.skipped.length, 2);
  assert.match(out.skipped[0].reason, /issue non prête/);
  const one = nextIssue({ exec, projectDir: root, issueNumber: 2 });
  assert.equal(one.code, 3);
  assert.match(one.skipped[0].reason, /issue non prête : Objectif/);
  assert.equal(one.skipped[0].number, 2);
});

test('AC10 : la liste est demandée triée par création ; priorité d\'abord, puis la plus ancienne', () => {
  const at = (day) => `2026-10-${day}T10:00:00Z`;
  const label = (...names) => names.map((name) => ({ name }));
  const { root, exec, calls } = setup({ issues: [
    issue(1, { created_at: at('01') }),
    issue(2, { created_at: at('05'), labels: label('agent-ready', 'P1') }),
    issue(3, { created_at: at('03'), labels: label('agent-ready', 'P1') }),
    issue(4, { created_at: at('09'), labels: label('agent-ready', 'P0') }),
  ] });
  const out = nextIssue({ exec, projectDir: root });
  assert.equal(out.issue.number, 4, 'P0 récente avant P1 et avant sans label plus ancienne');
  assert.ok(calls.some((c) => /issues\?state=open.*&sort=created&direction=asc/.test(c)), calls.join('\n'));

  const noP0 = setup({ issues: [
    issue(1, { created_at: at('01') }),
    issue(2, { created_at: at('05'), labels: label('agent-ready', 'P1') }),
    issue(3, { created_at: at('03'), labels: label('agent-ready', 'P1') }),
  ] });
  assert.equal(nextIssue({ exec: noP0.exec, projectDir: noP0.root }).issue.number, 3, 'P1 la plus ancienne avant une ancienne sans label');
});

test('AC10 : priorityLabels personnalisés du team.json', () => {
  const { root, exec } = setup({
    backlog: { priorityLabels: ['urgent', 'normal'] },
    issues: [
      issue(1, { created_at: '2026-10-01T10:00:00Z' }),
      issue(2, { created_at: '2026-10-05T10:00:00Z', labels: [{ name: 'agent-ready' }, { name: 'urgent' }] }),
    ],
  });
  assert.equal(nextIssue({ exec, projectDir: root }).issue.number, 2);
});

test('AC11 : dépendance ouverte → écartée, la suivante est retenue', () => {
  const { root, exec } = setup({ issues: [
    issue(1, { body: readyBody('Corps 1\nDépend de #5') }),
    issue(5),
  ] });
  const out = nextIssue({ exec, projectDir: root });
  assert.equal(out.issue.number, 5, '#5 est ouverte et prête : elle passe avant #1');
  assert.deepEqual(out.skipped.map((s) => [s.number, s.reason]), [[1, 'dépend de #5 (ouverte)']]);
});

test('AC11 : dépendance fermée (lue en GET) → éligible ; lecture seule', () => {
  const { root, exec, calls } = setup({
    issues: [issue(1, { body: readyBody('Corps 1\nDépend de #3') })],
    extraIssues: [issue(3, { state: 'closed' })],
  });
  const out = nextIssue({ exec, projectDir: root });
  assert.equal(out.code, 0);
  assert.equal(out.issue.number, 1);
  assert.deepEqual(out.warnings, []);
  assert.ok(calls.includes('gh api repos/{owner}/{repo}/issues/3'), calls.join('\n'));
  for (const call of calls) {
    assert.doesNotMatch(call, /issue (edit|comment|close)|--add-label|pr create| -X|--method| -f |--field/, call);
  }
});

test('AC11 : dépendance illisible ou introuvable → avertissements, issue retenue', () => {
  const { root, exec } = setup({ issues: [
    issue(1, { body: readyBody('Corps 1\nDépend de o/r#3'), created_at: '2026-10-01T00:00:00Z' }),
    issue(2, { body: readyBody('Corps 2\nDépend de #99'), created_at: '2026-10-02T00:00:00Z' }),
  ] });
  const out = nextIssue({ exec, projectDir: root });
  assert.equal(out.code, 0);
  assert.equal(out.issue.number, 1);
  assert.equal(out.warnings.length, 2);
  assert.match(out.warnings.find((w) => w.number === 1).message, /illisible.*o\/r#3/);
  assert.match(out.warnings.find((w) => w.number === 2).message, /#99 inconnu/);
});

test('AC11 : le plafond de lectures de dépendances sert d\'abord les issues prioritaires (priorityLabels personnalisés)', () => {
  const older = Array.from({ length: 20 }, (_, i) => issue(10 + i, {
    body: readyBody(`Corps\nDépend de #${200 + i}`), created_at: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
  }));
  const urgent = issue(50, {
    body: readyBody('Corps\nDépend de #101'), created_at: '2026-10-15T00:00:00Z',
    labels: [{ name: 'agent-ready' }, { name: 'urgent' }],
  });
  const { root, exec, calls } = setup({
    backlog: { priorityLabels: ['urgent'] },
    issues: [...older, urgent],
    extraIssues: [issue(101, { state: 'closed' })],
  });
  const out = nextIssue({ exec, projectDir: root });
  assert.equal(out.issue.number, 50, 'la dépendance #101 est fermée : l\'issue urgente est prête et passe en premier');
  assert.ok(calls.includes('gh api repos/{owner}/{repo}/issues/101'), 'lue malgré le plafond de 20 lectures');
  assert.equal(calls.filter((c) => /issues\/\d+$/.test(c)).length, 20);
});

test('AC11 : cycle de dépendances → raison « cycle »', () => {
  const { root, exec } = setup({ issues: [
    issue(1, { body: readyBody('Corps 1\nDépend de #2') }),
    issue(2, { body: readyBody('Corps 2\nDépend de #1') }),
  ] });
  const out = nextIssue({ exec, projectDir: root });
  assert.equal(out.code, 3);
  assert.equal(out.skipped.length, 2);
  for (const s of out.skipped) assert.match(s.reason, /cycle/);
});

test('une dépendance écartée par un autre filtre (run local) reste ouverte pour l\'issue qui en dépend', () => {
  const { root, exec } = setup({ issues: [
    issue(1, { body: readyBody('Corps 1\nDépend de #2') }),
    issue(2),
  ] });
  writeFile(join(root, '.agent-runs/2026-10-18-issue-2/state.json'), JSON.stringify({ id: 'x', issue: 2, status: 'executing' }));
  const out = nextIssue({ exec, projectDir: root });
  assert.equal(out.code, 3);
  const reasons = Object.fromEntries(out.skipped.map((s) => [s.number, s.reason]));
  assert.match(reasons[2], /run local/);
  assert.equal(reasons[1], 'dépend de #2 (ouverte)');
});

test('texte : écartées et avertissements affichés, chaque avertissement avec le numéro de l\'issue visée', () => {
  const { root, exec } = setup({ issues: [
    issue(1, { body: '' }),
    issue(2, { body: readyBody('Corps 2\nDépend de o/r#3') }),
  ] });
  const out = nextIssue({ exec, projectDir: root });
  assert.equal(out.issue.number, 2);
  const text = renderText(out);
  assert.match(text, /#1 écartée : issue non prête/);
  assert.match(text, /avertissement #2 : référence de dépendance illisible/);
  assert.match(text, /issue #2 retenue/);
  assert.doesNotMatch(text, /avertissement #1/);
});

/** Lance la vraie CLI (main) avec le faux gh ; renvoie le code et les sorties. */
function runCli(env, ...args) {
  const out = [];
  const err = [];
  const code = main(['node', 'next-issue.mjs', ...args], {
    exec: env.exec, projectDir: env.root, log: (s) => out.push(s), error: (s) => err.push(s),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('CLI texte : écartées, avertissements (avec l\'issue visée) et demande affichés', () => {
  const env = setup({ issues: [
    issue(1, { body: '' }),
    issue(2, { body: readyBody('Corps 2\nDépend de o/r#3') }),
  ] });
  const { code, stdout } = runCli(env);
  assert.equal(code, 0);
  assert.match(stdout, /#1 écartée : issue non prête/);
  assert.match(stdout, /avertissement #2 : référence de dépendance illisible : « Dépend de o\/r#3 »/);
  assert.match(stdout, /issue #2 retenue/);
  assert.match(stdout, /Demande pour \/team :\nIssue #2 : Issue 2/);
});

test('CLI --json : warnings et warningsOmitted présents', () => {
  const env = setup({ issues: [issue(2, { body: readyBody('Corps 2\nDépend de o/r#3') })] });
  const { code, stdout } = runCli(env, '--json');
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.deepEqual(out.warnings, [{ number: 2, message: 'référence de dépendance illisible : « Dépend de o/r#3 »' }]);
  assert.equal(out.warningsOmitted, 0);
});

test('avertissements bornés : 5 par issue, 20 au total, ceux de l\'issue retenue d\'abord ; le reste est compté', () => {
  const refs = (k) => Array.from({ length: k }, (_, j) => `Dépend de o/r#${j}`).join('\n');
  // #1 à #5, plus anciennes, dépendent de #9 (ouverte) : écartées, 8 avertissements chacune.
  const blocked = Array.from({ length: 5 }, (_, i) => issue(i + 1, {
    body: readyBody(`Corps\nDépend de #9\n${refs(8)}`), created_at: `2026-10-0${i + 1}T00:00:00Z`,
  }));
  const chosen = issue(9, { body: readyBody(`Corps 9\n${refs(3)}`), created_at: '2026-10-09T00:00:00Z' });
  const env = setup({ issues: [...blocked, chosen] });

  const out = nextIssue({ exec: env.exec, projectDir: env.root });
  assert.equal(out.issue.number, 9);
  assert.equal(out.warnings.length, 20);
  assert.deepEqual(out.warnings.slice(0, 3).map((w) => w.number), [9, 9, 9], 'issue retenue d\'abord');
  const perIssue = {};
  for (const w of out.warnings) perIssue[w.number] = (perIssue[w.number] ?? 0) + 1;
  for (const [n, count] of Object.entries(perIssue)) assert.ok(count <= 5, `#${n} : ${count} avertissements`);
  assert.equal(out.warningsOmitted, 5 * 8 + 3 - 20);

  const { stdout } = runCli(env);
  assert.equal(stdout.match(/avertissement #/g).length, 20);
  assert.match(stdout, /… et 23 autres avertissements/);
  const json = JSON.parse(runCli(env, '--json').stdout);
  assert.equal(json.warnings.length, 20);
  assert.equal(json.warningsOmitted, 23);
});

const pick = ({ root, exec }) => ({ projectDir: root, exec });
