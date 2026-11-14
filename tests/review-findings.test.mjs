// findings.mjs (fusion des livrables, verdicts, étiquettes, ancrage, suivi entre rounds)
// et decisions.mjs (triage d'un constat).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { evaluateCommand } from '../template/.claude/hooks/team/guard-bash.mjs';
import { applyDecision, parseArgs, summary } from '../template/.claude/skills/team-review/scripts/decisions.mjs';
import { mergeFindings } from '../template/.claude/skills/team-review/scripts/findings.mjs';
import { prFetch } from '../template/.claude/skills/team-review/scripts/pr-fetch.mjs';
import { checkReview, defaultLabel, fingerprint } from '../template/.claude/skills/team-review/scripts/store.mjs';
import { fakeExec, fixture } from './gh-fixtures.mjs';
import { TEMPLATE_CLAUDE } from './helpers.mjs';
import {
  NOW, SHA, SHA2, fetched, finding, guardCtx, readReview, reviewText, reviewerDeliverable, routes, verifierDeliverable, viewFixture,
  writeDeliverable,
} from './review-fixtures.mjs';

const noGh = () => fakeExec({}).exec;
const merge = (project, exec = noGh()) => {
  const out = mergeFindings({ reviewDir: project.reviewDir, claudeDir: project.claudeDir, exec, now: NOW });
  if (out.review) assert.deepEqual(checkReview(out.review), [], 'review.json écrit invalide');
  return out;
};
const byId = (review, id) => review.findings.find((f) => f.id === id);
const VIEW = Object.keys(routes()).find((k) => k.startsWith('gh pr view 42 --json number'));
const COMPARE = `gh api repos/{owner}/{repo}/compare/${SHA}...${SHA2}`;

/** Ouvre un round 2 (nouveau commit de tête) avec le diff donné. */
function secondRound(project, diff = fixture('review-diff.patch')) {
  const out = prFetch({
    number: 42, claudeDir: project.claudeDir, now: NOW,
    exec: fakeExec(routes({ [VIEW]: { stdout: viewFixture({ headRefOid: SHA2 }) }, 'gh pr diff 42': { stdout: diff } })).exec,
  });
  assert.equal(out.code, 1, out.message);
}

// --- Empreinte, étiquettes ---

test('fingerprint : stable malgré les espaces, les lignes vides, la ligne et le chemin Windows ; sensible au fichier, à l\'extrait, à la nature', () => {
  const base = fingerprint(finding());
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(fingerprint(finding({ snippet: "\n\tconst lines   = rows.map((r) => Object.values(r).join(','));  \r\n\r\n" })), base);
  assert.equal(fingerprint(finding({ line: 99, endLine: 120, title: 'autre', severity: 'minor' })), base);
  assert.equal(fingerprint(finding({ file: '.\\src\\export.js' })), base);
  assert.notEqual(fingerprint(finding({ file: 'src/other.js' })), base);
  assert.notEqual(fingerprint(finding({ snippet: 'return 1;' })), base);
  assert.notEqual(fingerprint(finding({ kind: 'question' })), base);
});

test('defaultLabel : question ou sans preuve → ASK ; sinon critical → MUST, major → SHOULD, minor → COULD', () => {
  assert.equal(defaultLabel({ kind: 'defect', proof: 'read', severity: 'critical' }), 'MUST');
  assert.equal(defaultLabel({ kind: 'defect', proof: 'script', severity: 'major' }), 'SHOULD');
  assert.equal(defaultLabel({ kind: 'defect', proof: 'read', severity: 'minor' }), 'COULD');
  assert.equal(defaultLabel({ kind: 'question', proof: 'read', severity: 'critical' }), 'ASK');
  assert.equal(defaultLabel({ kind: 'defect', proof: 'none', severity: 'critical' }), 'ASK');
});

// --- findings.mjs ---

test('findings : premier passage → constats R1…, étiquette, ancrage, brouillon, round reviewed, verify-input sans le raisonnement', () => {
  const project = fetched();
  writeDeliverable(project.reviewDir, reviewerDeliverable('backend', [
    finding(),
    finding({ id: 'B2', severity: 'minor', line: 34, endLine: 34, snippet: '  link.click();', title: 'Clic sans nettoyage', proof: 'none', evidence: '' }),
    finding({ id: 'B3', severity: 'critical', kind: 'question', line: 11, endLine: 11, snippet: "  if (!rows) return '';", title: 'Liste vide voulue ?', scenario: '', fix: '' }),
  ]));
  const out = merge(project);
  assert.equal(out.code, 0, out.message);
  assert.equal(out.changed, true);
  const review = readReview(project.reviewDir);
  assert.deepEqual(review.findings.map((f) => [f.id, f.label, f.anchor, f.tracking]), [
    ['R1', 'SHOULD', 'line', 'new'], ['R2', 'ASK', 'line', 'new'], ['R3', 'ASK', 'line', 'new'],
  ]);
  const r1 = byId(review, 'R1');
  assert.deepEqual(r1.axes, ['backend']);
  assert.deepEqual(r1.agents, ['cc-pr-reviewer-backend']);
  assert.deepEqual([r1.firstRound, r1.lastRound], [1, 1]);
  assert.equal(r1.fingerprint, fingerprint(finding()));
  assert.equal(r1.comment, finding().comment);
  assert.equal(r1.draft, finding().comment);
  assert.deepEqual([r1.verification, r1.decision, r1.rating, r1.note, r1.publication], [null, null, null, '', null]);
  for (const key of ['severity', 'kind', 'file', 'line', 'endLine', 'snippet', 'title', 'problem', 'scenario', 'fix', 'proof', 'evidence', 'regression', 'suggestion']) {
    assert.ok(key in r1, key);
  }
  assert.equal(r1.preexisting, false, 'absent du livrable → false');
  assert.equal(review.rounds[0].status, 'reviewed');
  assert.equal(review.log.at(-1).event, 'findings_merged');

  // Le vérificateur ne reçoit que id, file, line, title, problem, scenario des critical et major.
  const input = JSON.parse(readFileSync(join(project.reviewDir, 'rounds', '1', 'verify-input.json'), 'utf8'));
  assert.deepEqual(input.findings.map((f) => f.id), ['R1', 'R3']);
  for (const f of input.findings) assert.deepEqual(Object.keys(f), ['id', 'file', 'line', 'title', 'problem', 'scenario']);
  assert.doesNotMatch(JSON.stringify(input), /evidence|sans échappement|comment/);
});

test('findings : même empreinte chez deux relecteurs → un seul constat, axes et agents réunis, sévérité la plus haute', () => {
  const project = fetched();
  writeDeliverable(project.reviewDir, reviewerDeliverable('backend', [finding({ severity: 'minor', title: 'Vu côté serveur' })]));
  writeDeliverable(project.reviewDir, reviewerDeliverable('architecture', [
    finding({ id: 'A1', severity: 'critical', title: 'Vu de bout en bout', snippet: "const lines = rows.map((r) =>   Object.values(r).join(','));" }),
    finding({ id: 'A2', file: 'ui/Export.tsx', line: 3, endLine: 3, snippet: '  return <button onClick={() => download(toCsv(rows))}>Exporter</button>;', title: 'Autre constat' }),
  ]));
  assert.equal(merge(project).code, 0);
  const review = readReview(project.reviewDir);
  assert.equal(review.findings.length, 2);
  const r1 = byId(review, 'R1');
  assert.deepEqual(r1.axes, ['backend', 'architecture']);
  assert.deepEqual(r1.agents, ['cc-pr-reviewer-backend', 'cc-pr-reviewer-architecture']);
  assert.equal(r1.severity, 'critical');
  assert.equal(r1.title, 'Vu de bout en bout', 'contenu du constat le plus sévère');
  assert.equal(r1.label, 'MUST');
});

test('findings : ancrage ligne ou corps d\'après le vrai diff ; endLine hors du hunk → ligne seule, suggestion retirée', () => {
  const project = fetched();
  const f = (id, over) => finding({ id, snippet: `extrait ${id}`, ...over });
  writeDeliverable(project.reviewDir, reviewerDeliverable('backend', [
    f('ajoutee', { line: 12, endLine: 13, suggestion: 'x' }),
    f('contexte', { line: 10, endLine: 10 }),
    f('hors-hunk', { line: 20, endLine: 20, suggestion: 'x' }),
    f('autre-hunk', { line: 13, endLine: 34, suggestion: 'x' }),
    f('sans-ligne', { line: null, endLine: null }),
    f('hors-diff', { file: 'src/routes.js', line: 3, endLine: 3 }),
    f('fichier-2', { file: 'ui/Export.tsx', line: 4, endLine: null }),
    f('supprimee', { line: 17, endLine: 17 }),
  ]));
  assert.equal(merge(project).code, 0);
  const got = Object.fromEntries(readReview(project.reviewDir).findings.map((x) => [x.snippet.slice(8), [x.anchor, x.line, x.endLine, x.suggestion]]));
  assert.deepEqual(got, {
    ajoutee: ['line', 12, 13, 'x'],
    contexte: ['line', 10, 10, null],
    'hors-hunk': ['body', 20, 20, 'x'],
    'autre-hunk': ['line', 13, null, null],
    'sans-ligne': ['body', null, null, null],
    'hors-diff': ['body', 3, 3, null],
    'fichier-2': ['line', 4, null, null],
    supprimee: ['body', 17, 17, null],
  });
});

test('findings : verdicts du vérificateur — rejected (ko + note), downgraded (sévérité et étiquette), confirmed', () => {
  const project = fetched();
  writeDeliverable(project.reviewDir, reviewerDeliverable('backend', [
    finding({ id: 'B1', severity: 'critical' }),
    finding({ id: 'B2', severity: 'major', snippet: '  link.click();', line: 34, endLine: 34 }),
    finding({ id: 'B3', severity: 'major', snippet: "  return lines.join('\\n');", line: 13, endLine: 13 }),
    finding({ id: 'B4', severity: 'major', snippet: "  if (!rows) return '';", line: 11, endLine: 11 }),
  ]));
  merge(project);
  writeDeliverable(project.reviewDir, verifierDeliverable([
    { finding: 'R1', verdict: 'rejected', reason: 'Validé en amont par src/schema.js:8.' },
    { finding: 'R2', verdict: 'downgraded', severity: 'minor', reason: 'Cas rare.' },
    { finding: 'R3', verdict: 'confirmed', reason: 'Reproduit.' },
    { finding: 'R4', verdict: 'downgraded', severity: 'major', reason: 'Pas plus bas.' },
    { finding: 'R99', verdict: 'confirmed', reason: 'Constat inconnu.' },
  ]));
  const out = merge(project);
  assert.equal(out.code, 0);
  assert.match(out.warnings.join('\n'), /R99/);
  assert.match(out.warnings.join('\n'), /R4.*n'est pas plus bas/);
  const review = readReview(project.reviewDir);

  const r1 = byId(review, 'R1');
  assert.deepEqual(r1.verification, { verdict: 'rejected', reason: 'Validé en amont par src/schema.js:8.', originalSeverity: 'critical' });
  assert.equal(r1.decision, 'ko');
  assert.equal(r1.note, 'écarté par le vérificateur : Validé en amont par src/schema.js:8.');
  assert.equal(r1.severity, 'critical', 'constat conservé tel quel');

  const r2 = byId(review, 'R2');
  assert.deepEqual(r2.verification, { verdict: 'downgraded', reason: 'Cas rare.', originalSeverity: 'major' });
  assert.equal(r2.severity, 'minor');
  assert.equal(r2.label, 'COULD');
  assert.equal(r2.decision, null);

  assert.equal(byId(review, 'R3').verification.verdict, 'confirmed');
  assert.equal(byId(review, 'R3').label, 'SHOULD');
  assert.deepEqual([byId(review, 'R4').severity, byId(review, 'R4').verification.verdict], ['major', 'confirmed']);
  assert.equal(existsSync(join(project.reviewDir, 'rounds', '1', 'verify-input.json')), false, 'plus rien à vérifier : fichier supprimé');

  // L'utilisateur repêche un constat rejeté : un nouveau passage ne l'écrase pas.
  const rescued = applyDecision(review, 'R1', { decision: 'ok', note: 'je le garde' });
  writeFileSync(join(project.reviewDir, 'review.json'), JSON.stringify(rescued.review, null, 2));
  merge(project);
  assert.deepEqual([byId(readReview(project.reviewDir), 'R1').decision, byId(readReview(project.reviewDir), 'R1').note], ['ok', 'je le garde']);
});

test('findings : idempotent — relancé sans nouveau livrable, review.json ne change pas', () => {
  const project = fetched();
  writeDeliverable(project.reviewDir, reviewerDeliverable('backend', [finding()]));
  writeDeliverable(project.reviewDir, reviewerDeliverable('frontend', [finding({ id: 'F1', file: 'ui/Export.tsx', line: 2, endLine: 2, snippet: 'export function Export({ rows }) {' })]));
  merge(project);
  writeDeliverable(project.reviewDir, verifierDeliverable([{ finding: 'R1', verdict: 'downgraded', severity: 'minor', reason: 'Cas rare.' }]));
  merge(project);
  const before = reviewText(project.reviewDir);
  for (let i = 0; i < 2; i++) {
    const out = merge(project);
    assert.equal(out.code, 0);
    assert.equal(out.changed, false);
    assert.match(out.message, /rien de nouveau/);
  }
  assert.equal(reviewText(project.reviewDir), before);
});

test('findings : suivi entre rounds — persisting garde décision, note, texte édité et publication ; fixed et unknown', () => {
  const project = fetched();
  const keep = finding({ id: 'B1' });
  const fixedOne = finding({ id: 'B2', snippet: "  if (!rows) return '';", line: 11, endLine: 11, title: 'Sera corrigé' });
  const stillThere = finding({ id: 'B3', snippet: '  link.click();', line: 34, endLine: 34, title: 'Toujours dans le diff' });
  const untouched = finding({ id: 'B4', file: 'ui/Export.tsx', snippet: 'export function Export({ rows }) {', line: 2, endLine: 2, title: 'Fichier non modifié' });
  writeDeliverable(project.reviewDir, reviewerDeliverable('backend', [keep, fixedOne, stillThere, untouched]));
  merge(project);

  let review = readReview(project.reviewDir);
  review = applyDecision(review, 'R1', { decision: 'ok', rating: 'correct', label: 'MUST', comment: 'Texte réécrit par moi.', note: 'important' }).review;
  byId(review, 'R1').publication = { round: 1, at: '2026-11-13T10:00:00.000Z', reviewId: 9001, commentId: 7001, url: 'https://x' };
  writeFileSync(join(project.reviewDir, 'review.json'), JSON.stringify(review, null, 2));

  // Round 2 : la garde « if (!rows) » a disparu du diff, le constat B1 est toujours là, décalé d'une ligne.
  const diff2 = fixture('review-diff.patch').replace("+  if (!rows) return '';\n", '+  // garde retirée\n+  const sep = \',\';\n').replace('@@ -9,6 +9,8 @@', '@@ -9,6 +9,9 @@');
  secondRound(project, diff2);
  writeDeliverable(project.reviewDir, reviewerDeliverable('backend', [finding({ id: 'X9', line: 13, endLine: 13, title: 'Titre reformulé', comment: 'Nouveau brouillon.' })], { round: 2 }));
  const { exec, calls } = fakeExec({ [COMPARE]: { stdout: fixture('review-compare.json') } });
  const out = merge(project, exec);
  assert.equal(out.code, 0, out.message);
  review = readReview(project.reviewDir);

  const r1 = byId(review, 'R1');
  assert.deepEqual([r1.tracking, r1.firstRound, r1.lastRound, r1.line], ['persisting', 1, 2, 13]);
  assert.deepEqual([r1.decision, r1.rating, r1.label, r1.comment, r1.note], ['ok', 'correct', 'MUST', 'Texte réécrit par moi.', 'important']);
  assert.equal(r1.draft, keep.comment, 'brouillon d\'origine jamais modifié');
  assert.equal(r1.publication.commentId, 7001);
  assert.equal(review.findings.length, 4, 'pas de doublon pour un constat déjà connu');

  assert.equal(byId(review, 'R2').tracking, 'fixed', 'fichier modifié et extrait absent du nouveau diff');
  assert.equal(byId(review, 'R3').tracking, 'unknown', 'fichier modifié mais extrait encore dans le diff');
  assert.equal(byId(review, 'R4').tracking, 'unknown', 'fichier non modifié entre les deux commits');
  assert.equal(byId(review, 'R2').lastRound, 1);

  // Une seule lecture gh (la comparaison), sans accord demandé ; un second passage n'en refait pas.
  assert.deepEqual(calls, [COMPARE]);
  assert.equal(evaluateCommand(COMPARE, guardCtx), null);
  const before = reviewText(project.reviewDir);
  assert.equal(merge(project, noGh()).changed, false);
  assert.equal(reviewText(project.reviewDir), before);
});

test('findings : comparaison gh impossible → constats absents « unknown », avertissement, pas d\'échec', () => {
  const project = fetched();
  writeDeliverable(project.reviewDir, reviewerDeliverable('backend', [finding()]));
  merge(project);
  secondRound(project, 'diff --git a/x b/x\n');
  writeDeliverable(project.reviewDir, reviewerDeliverable('backend', [], { round: 2 }));
  const out = merge(project, fakeExec({ [COMPARE]: { code: 1, stderr: 'HTTP 404: Not Found' } }).exec);
  assert.equal(out.code, 0);
  assert.match(out.warnings.join('\n'), /comparaison/);
  assert.equal(byId(readReview(project.reviewDir), 'R1').tracking, 'unknown');
});

test('findings : aucun livrable → 2 ; review.json invalide ou absent → 2 ; seul le dernier livrable d\'un relecteur compte', () => {
  const project = fetched();
  const before = reviewText(project.reviewDir);
  const none = merge(project);
  assert.equal(none.code, 2);
  assert.match(none.message, /aucun livrable/);
  assert.equal(reviewText(project.reviewDir), before);
  writeDeliverable(project.reviewDir, verifierDeliverable([]));
  assert.equal(merge(project).code, 2, 'un verdict sans relecteur ne suffit pas');

  writeDeliverable(project.reviewDir, reviewerDeliverable('backend', [finding({ snippet: 'premier essai' })]));
  writeDeliverable(project.reviewDir, reviewerDeliverable('backend', [finding({ snippet: 'second essai' })]));
  assert.equal(merge(project).code, 0);
  assert.deepEqual(readReview(project.reviewDir).findings.map((f) => f.snippet), ['second essai']);

  writeFileSync(join(project.reviewDir, 'review.json'), '{ cassé');
  assert.equal(merge(project).code, 2);
  assert.equal(mergeFindings({ reviewDir: join(project.projectDir, 'absent'), claudeDir: project.claudeDir, exec: noGh() }).code, 2);
});

// --- decisions.mjs ---

function triaged() {
  const project = fetched();
  writeDeliverable(project.reviewDir, reviewerDeliverable('backend', [
    finding(), finding({ id: 'B2', severity: 'minor', snippet: '  link.click();', line: 34, endLine: 34 }),
  ]));
  merge(project);
  return { project, review: readReview(project.reviewDir) };
}

test('applyDecision : fonction pure — décision, note, étiquette, commentaire ; round triaged quand tout est décidé', () => {
  const { review } = triaged();
  const frozen = JSON.stringify(review);
  const out = applyDecision(review, 'R1', { decision: 'ok', rating: 'correct', label: 'MUST', comment: 'Réécrit.', note: 'vu avec Bob' }, '2026-11-13T11:00:00.000Z');
  assert.deepEqual(out.errors, []);
  assert.equal(JSON.stringify(review), frozen, 'entrée non modifiée');
  const f = byId(out.review, 'R1');
  assert.deepEqual([f.decision, f.rating, f.label, f.comment, f.note, f.ratedAt], ['ok', 'correct', 'MUST', 'Réécrit.', 'vu avec Bob', '2026-11-13T11:00:00.000Z']);
  assert.equal(f.draft, finding().comment);
  assert.equal(out.review.rounds[0].status, 'reviewed', 'R2 n\'a pas encore de décision');

  const all = applyDecision(out.review, 'R2', { decision: 'ko' });
  assert.equal(all.review.rounds[0].status, 'triaged');
  const back = applyDecision(all.review, 'R2', { decision: null, rating: null });
  assert.equal(back.review.rounds[0].status, 'reviewed');
  assert.deepEqual([byId(back.review, 'R2').decision, byId(back.review, 'R2').rating], [null, null]);
  // Décision et note sont indépendantes.
  assert.deepEqual([byId(applyDecision(review, 'R1', { rating: 'incorrect' }).review, 'R1').decision], [null]);
});

test('applyDecision : refus — id inconnu, valeur hors liste, champ inconnu, commentaire vide pour ok, constat publié', () => {
  const { review } = triaged();
  const errs = (id, patch, r = review) => {
    const out = applyDecision(r, id, patch);
    assert.equal(out.review, r, 'rien n\'est appliqué en cas de refus');
    return out.errors.join('\n');
  };
  assert.match(errs('R99', { decision: 'ok' }), /R99.*inconnu/);
  assert.match(errs('R1', { decision: 'yes' }), /decision/);
  assert.match(errs('R1', { rating: 'bof' }), /rating/);
  assert.match(errs('R1', { label: 'NIT' }), /label/);
  assert.match(errs('R1', { label: null }), /label/);
  assert.match(errs('R1', { comment: 12 }), /comment/);
  assert.match(errs('R1', { note: null }), /note/);
  assert.match(errs('R1', { severity: 'minor' }), /severity.*non modifiable/);
  assert.match(errs('R1', { draft: 'x' }), /draft.*non modifiable/);
  assert.match(errs('R1', { publication: null }), /publication.*non modifiable/);
  assert.match(errs('R1', 'ok'), /objet/);
  assert.match(errs('R1', { decision: 'ok', comment: '   ' }), /commentaire vide/);
  const ok = applyDecision(review, 'R1', { decision: 'ok' }).review;
  assert.match(errs('R1', { comment: '' }, ok), /commentaire vide/);
  assert.deepEqual(applyDecision(review, 'R1', { decision: 'ko', comment: '' }).errors, [], 'un constat rejeté peut avoir un texte vide');

  const published = structuredClone(ok);
  byId(published, 'R1').publication = { round: 1, at: 'x', reviewId: 1, commentId: 2, url: null };
  assert.match(errs('R1', { comment: 'autre texte' }, published), /déjà publié/);
  assert.match(errs('R1', { label: 'COULD' }, published), /déjà publié/);
  assert.match(errs('R1', { decision: 'ko' }, published), /déjà publié/);
  const rated = applyDecision(published, 'R1', { rating: 'incorrect', note: 'finalement faux', comment: byId(published, 'R1').comment });
  assert.deepEqual(rated.errors, [], 'note et justesse restent modifiables après publication');
});

test('decisions.mjs (CLI) : enregistre, refuse (1), usage (2), --summary', () => {
  const { project } = triaged();
  const script = join(TEMPLATE_CLAUDE, 'skills/team-review/scripts/decisions.mjs');
  const run = (...args) => spawnSync(process.execPath, [script, project.reviewDir, ...args], { encoding: 'utf8' });
  const commentFile = join(project.projectDir, 'comment.txt');
  writeFileSync(commentFile, '﻿Texte depuis un fichier.\n');

  const ok = run('R1', '--decision', 'ok', '--rating', 'correct', '--label', 'MUST', '--comment-file', commentFile, '--note', 'ma note');
  assert.equal(ok.status, 0, ok.stderr);
  const f = byId(readReview(project.reviewDir), 'R1');
  assert.deepEqual([f.decision, f.rating, f.label, f.comment, f.note], ['ok', 'correct', 'MUST', 'Texte depuis un fichier.', 'ma note']);
  assert.equal(run('R1', '--decision', 'none').status, 0);
  assert.equal(byId(readReview(project.reviewDir), 'R1').decision, null);

  const before = reviewText(project.reviewDir);
  const ko = run('R1', '--label', 'NIT');
  assert.equal(ko.status, 1);
  assert.match(ko.stderr, /label/);
  assert.equal(run('R99', '--decision', 'ok').status, 1);
  assert.equal(reviewText(project.reviewDir), before);
  assert.equal(run('R1').status, 2, 'aucune modification demandée');
  assert.equal(run('R1', '--bogus', 'x').status, 2);
  assert.equal(spawnSync(process.execPath, [script, join(project.projectDir, 'absent'), '--summary'], { encoding: 'utf8' }).status, 2);

  const sum = run('--summary');
  assert.equal(sum.status, 0);
  assert.match(sum.stdout, /pr-42 \(mode comments\), round 1/);
  assert.match(sum.stdout, /Étiquettes : MUST 1, SHOULD 0, COULD 1, ASK 0/);
  assert.match(sum.stdout, /Décisions : ok 0, ko 0, discuss 0, none 2/);
  assert.equal(summary(readReview(project.reviewDir)), sum.stdout.trimEnd());
  assert.throws(() => parseArgs(['dir', 'R1', '--decision']), /attend une valeur/);
  assert.ok(existsSync(project.reviewDir));
});
