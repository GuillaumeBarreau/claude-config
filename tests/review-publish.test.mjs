// publish.mjs (revue GitHub ou liste de corrections), serve.mjs (rapport de triage local),
// stats.mjs et review-batch.mjs. Le vrai gh et le vrai claude ne sont jamais appelés.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { evaluateCommand } from '../template/.claude/hooks/team/guard-bash.mjs';
import { applyDecision } from '../template/.claude/skills/team-review/scripts/decisions.mjs';
import { mergeFindings } from '../template/.claude/skills/team-review/scripts/findings.mjs';
import { buildPayload, commentBody, publish } from '../template/.claude/skills/team-review/scripts/publish.mjs';
import { claudeArgs, reviewBatch } from '../template/.claude/skills/team-review/scripts/review-batch.mjs';
import { MAX_BODY_BYTES, createHandler, serve } from '../template/.claude/skills/team-review/scripts/serve.mjs';
import { computeStats, formatStats, stats } from '../template/.claude/skills/team-review/scripts/stats.mjs';
import { fakeExec, fixture } from './gh-fixtures.mjs';
import { TEMPLATE_CLAUDE } from './helpers.mjs';
import {
  NOW, SHA, SHA2, fetched, finding, guardCtx, makeReviewProject, readReview, reviewText, reviewerDeliverable, routes, writeDeliverable,
} from './review-fixtures.mjs';

const byId = (review, id) => review.findings.find((f) => f.id === id);
const POST = 'gh api --method POST repos/{owner}/{repo}/pulls/42/reviews --input';
const CREATED = 'gh api repos/{owner}/{repo}/pulls/42/reviews/9001/comments --paginate';
const AI = /\b(IA|AI|Claude|Anthropic|assistant|agent|LLM|généré|generated)\b/i;

/** Round 1 relu : R1 SHOULD en ligne (12), R2 MUST multi-lignes avec suggestion (11-13), R3 hors diff, R4 COULD en ligne (34). */
function reviewed(opts = {}) {
  const project = fetched(opts);
  writeDeliverable(project.reviewDir, reviewerDeliverable('backend', [
    finding(),
    finding({ id: 'B2', severity: 'critical', line: 11, endLine: 13, snippet: "  if (!rows) return '';", title: 'Garde incomplète', suggestion: "  if (!Array.isArray(rows)) return '';", comment: 'La garde laisse passer un objet.' }),
    finding({ id: 'B3', file: 'src/routes.js', line: 30, endLine: 30, snippet: 'router.get("/export")', title: 'Appelant non mis à jour', comment: 'Cet appelant attend encore des points-virgules.' }),
    finding({ id: 'B4', severity: 'minor', line: 34, endLine: 34, snippet: '  link.click();', title: 'Lien jamais retiré', comment: 'Le lien reste dans le DOM.' }),
  ]));
  const out = mergeFindings({ reviewDir: project.reviewDir, claudeDir: project.claudeDir, exec: fakeExec({}).exec, now: NOW });
  assert.equal(out.code, 0, out.message);
  return project;
}

function decide(project, decisions) {
  let review = readReview(project.reviewDir);
  for (const [id, patch] of Object.entries(decisions)) {
    const out = applyDecision(review, id, typeof patch === 'string' ? { decision: patch } : patch);
    assert.deepEqual(out.errors, [], id);
    review = out.review;
  }
  writeFileSync(join(project.reviewDir, 'review.json'), `${JSON.stringify(review, null, 2)}\n`);
}

/** Commentaires créés par GitHub pour une charge utile : forme de …/reviews/<id>/comments (pas de champ line). */
const createdFrom = (payload) => payload.comments.map((c, i) => ({
  id: 7001 + i, node_id: `PRRC_${i}`, pull_request_review_id: 9001, path: c.path, position: 3 + i, original_position: 3 + i, commit_id: SHA,
  body: c.body, html_url: `https://github.com/acme/app/pull/42#discussion_r${7001 + i}`, user: { login: 'alice', type: 'User' },
}));

function publishRoutes(project, extra = {}) {
  const payloadPath = join(project.reviewDir, 'rounds', '1', 'publish-payload.json');
  return routes({
    [POST]: { stdout: fixture('review-post-review.json') },
    // Dans l'ordre inverse : le rattachement ne dépend pas de l'ordre de la réponse.
    [CREATED]: () => ({ stdout: JSON.stringify(createdFrom(JSON.parse(readFileSync(payloadPath, 'utf8'))).reverse()) }),
    ...extra,
  });
}
const run = (project, exec, opts = {}) => publish({ reviewDir: project.reviewDir, claudeDir: project.claudeDir, exec, now: NOW, ...opts });

// --- publish : mode comments ---

test('publish : charge utile exacte — seuls les constats ok, en ligne, hors diff, suggestion, plage de lignes', () => {
  const project = reviewed();
  decide(project, { R1: 'ok', R2: 'ok', R3: 'ok', R4: 'ko' });
  const { exec, calls } = fakeExec(publishRoutes(project));
  const out = run(project, exec);
  assert.equal(out.code, 0, out.message);

  const payload = JSON.parse(readFileSync(join(project.reviewDir, 'rounds', '1', 'publish-payload.json'), 'utf8'));
  assert.deepEqual(payload, {
    commit_id: SHA,
    event: 'COMMENT',
    body: 'Relecture : 3 remarques (1 MUST, 2 SHOULD).\n\n### Hors diff\n\n'
      + '- **SHOULD** · Appelant non mis à jour (`src/routes.js:30`)\n\n  Cet appelant attend encore des points-virgules.',
    comments: [
      {
        path: 'src/export.js', line: 13, side: 'RIGHT', start_line: 11, start_side: 'RIGHT',
        body: "**MUST** · Garde incomplète\n\nLa garde laisse passer un objet.\n\n```suggestion\n  if (!Array.isArray(rows)) return '';\n```",
      },
      {
        path: 'src/export.js', line: 12, side: 'RIGHT',
        body: `**SHOULD** · Les virgules dans un champ ne sont pas échappées\n\n${finding().comment}`,
      },
    ],
  });
  assert.deepEqual(Object.keys(payload.comments[0]), ['path', 'line', 'side', 'start_line', 'start_side', 'body']);
  assert.doesNotMatch(JSON.stringify(payload), AI, 'aucune mention d\'IA dans ce qui est publié');
  assert.doesNotMatch(JSON.stringify(payload), /Lien jamais retiré/, 'un constat rejeté ne part pas');

  // Une seule écriture : le POST de la revue. Toutes les autres commandes sont des lectures libres.
  const writes = calls.filter((c) => evaluateCommand(c, guardCtx) !== null);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].startsWith(`${POST} `), writes[0]);
  assert.ok(writes[0].endsWith('publish-payload.json'));
  assert.equal(evaluateCommand(writes[0], guardCtx).decision, 'ask');
  assert.deepEqual(calls.map((c) => c.split(' ').slice(0, 3).join(' ')), ['gh pr view', 'gh api --method', 'gh api repos/{owner}/{repo}/pulls/42/reviews/9001/comments']);

  const review = readReview(project.reviewDir);
  assert.deepEqual(byId(review, 'R2').publication, {
    round: 1, at: '2026-11-13T10:00:00.000Z', reviewId: 9001, commentId: 7001, url: 'https://github.com/acme/app/pull/42#discussion_r7001',
  });
  assert.equal(byId(review, 'R1').publication.commentId, 7002);
  assert.deepEqual(byId(review, 'R3').publication, {
    round: 1, at: '2026-11-13T10:00:00.000Z', reviewId: 9001, commentId: null, url: 'https://github.com/acme/app/pull/42#pullrequestreview-9001',
  });
  assert.equal(byId(review, 'R4').publication, null);
  assert.equal(review.rounds[0].status, 'published');
  assert.equal(review.log.at(-1).event, 'review_published');

  const journal = readFileSync(join(project.reviewDir, 'publications.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(journal.map((l) => l.finding).sort(), ['R1', 'R2', 'R3']);
  const line = journal.find((l) => l.finding === 'R2');
  assert.deepEqual(Object.keys(line), ['at', 'finding', 'label', 'draft', 'final', 'headSha', 'reviewId', 'commentId']);
  assert.deepEqual([line.label, line.draft, line.final, line.headSha, line.reviewId, line.commentId], ['MUST', 'La garde laisse passer un objet.', 'La garde laisse passer un objet.', SHA, 9001, 7001]);
});

test('publish : idempotent — un second lancement n\'envoie rien et n\'appelle pas gh', () => {
  const project = reviewed();
  decide(project, { R1: 'ok' });
  assert.equal(run(project, fakeExec(publishRoutes(project)).exec).code, 0);
  const before = reviewText(project.reviewDir);
  const journal = readFileSync(join(project.reviewDir, 'publications.jsonl'), 'utf8');
  const { exec, calls } = fakeExec({});
  const again = run(project, exec);
  assert.equal(again.code, 0);
  assert.match(again.message, /rien à publier/);
  assert.deepEqual(calls, []);
  assert.equal(reviewText(project.reviewDir), before);
  assert.equal(readFileSync(join(project.reviewDir, 'publications.jsonl'), 'utf8'), journal);
});

test('publish : aucun constat validé → 0 avec message, sans appel gh', () => {
  const project = reviewed();
  decide(project, { R1: 'ko', R2: 'discuss' });
  const { exec, calls } = fakeExec({});
  const out = run(project, exec);
  assert.equal(out.code, 0);
  assert.match(out.message, /rien à publier/);
  assert.deepEqual(calls, []);
  assert.ok(!existsSync(join(project.reviewDir, 'publications.jsonl')));
});

test('publish --dry-run : aperçu lisible, charge utile écrite, aucune écriture sur GitHub ni dans review.json', () => {
  const project = reviewed();
  decide(project, { R1: 'ok', R2: 'ok', R3: 'ok' });
  const before = reviewText(project.reviewDir);
  const { exec, calls } = fakeExec(routes());
  const out = run(project, exec, { dryRun: true });
  assert.equal(out.code, 0, out.message);
  assert.match(out.message, /simulation/);
  assert.deepEqual(calls, ['gh pr view 42 --json headRefOid,state']);
  for (const call of calls) assert.equal(evaluateCommand(call, guardCtx), null, call);
  assert.equal(reviewText(project.reviewDir), before);
  assert.ok(!existsSync(join(project.reviewDir, 'publications.jsonl')));
  assert.ok(existsSync(join(project.reviewDir, 'rounds', '1', 'publish-payload.json')));
  assert.match(out.preview, /PR #42 \(COMMENT\) — 2 commentaire\(s\) en ligne, 1 hors diff, 0 suggestion\(s\) regroupée\(s\)/);
  assert.match(out.preview, /--- R2 → src\/export\.js:11-13 ---/);
  assert.match(out.preview, /--- R1 → src\/export\.js:12 ---/);
  assert.match(out.preview, /### Hors diff/);
  // Après la simulation, l'envoi réel reste possible.
  assert.equal(run(project, fakeExec(publishRoutes(project)).exec).code, 0);
});

test('publish : la PR a bougé → 3, rien n\'est envoyé ; PR fermée → 2', () => {
  const project = reviewed();
  decide(project, { R1: 'ok' });
  const before = reviewText(project.reviewDir);
  for (const dryRun of [false, true]) {
    const { exec, calls } = fakeExec(routes({ 'gh pr view 42 --json headRefOid,state': { stdout: JSON.stringify({ headRefOid: SHA2, state: 'OPEN' }) } }));
    const out = run(project, exec, { dryRun });
    assert.equal(out.code, 3);
    assert.match(out.message, /a bougé.*relance pr-fetch/);
    assert.deepEqual(calls, ['gh pr view 42 --json headRefOid,state']);
  }
  const closed = run(project, fakeExec(routes({ 'gh pr view 42 --json headRefOid,state': { stdout: JSON.stringify({ headRefOid: SHA, state: 'MERGED' }) } })).exec);
  assert.equal(closed.code, 2);
  assert.equal(reviewText(project.reviewDir), before);
  assert.ok(!existsSync(join(project.reviewDir, 'rounds', '1', 'publish-payload.json')));
});

test('publish : --event — COMMENT par défaut même si team.json dit autre chose, option explicite exigée, valeur hors liste refusée', () => {
  const project = reviewed({ review: { axes: { frontend: ['ui/**'], backend: ['src/**'] }, event: 'APPROVE' } });
  decide(project, { R1: 'ok' });
  const dry = run(project, fakeExec(routes()).exec, { dryRun: true });
  assert.equal(dry.payload.event, 'COMMENT');
  assert.match(dry.message, /review\.event = APPROVE.*ignoré sans --event/);
  assert.equal(run(project, fakeExec(routes()).exec, { dryRun: true, event: 'REQUEST_CHANGES' }).payload.event, 'REQUEST_CHANGES');
  assert.equal(run(project, fakeExec(routes()).exec, { dryRun: true, event: 'APPROVE' }).payload.event, 'APPROVE');
  const bad = run(project, fakeExec({}).exec, { event: 'MERGE' });
  assert.equal(bad.code, 2);
  assert.match(bad.message, /--event/);
});

test('buildPayload : COULD au-delà de maxInlineCould regroupés sous « Suggestions » ; jamais de corps vide', () => {
  const could = (n) => ({ ...finding({ title: `Détail ${n}`, comment: `Remarque ${n}.`, line: 10 + n, endLine: 10 + n }), id: `R${n}`, severity: 'minor', label: 'COULD', anchor: 'line' });
  const must = { ...finding({ title: 'Grave', comment: 'À corriger.' }), id: 'R9', severity: 'critical', label: 'MUST', anchor: 'line' };
  const built = buildPayload({ findings: [could(1), could(2), could(3), must], headSha: SHA, maxInlineCould: 2 });
  assert.deepEqual(built.inline.map((f) => f.id), ['R9', 'R1', 'R2']);
  assert.deepEqual(built.grouped.map((f) => f.id), ['R3']);
  assert.equal(built.payload.comments.length, 3);
  assert.equal(built.payload.body, 'Relecture : 4 remarques (1 MUST, 3 COULD).\n\n### Suggestions\n\n- **COULD** · Détail 3 (`src/export.js:13`)\n\n  Remarque 3.');
  assert.equal(buildPayload({ findings: [could(1), could(2), could(3)], headSha: SHA }).grouped.length, 0, 'défaut : 5 en ligne');

  const only = buildPayload({ findings: [must], headSha: SHA });
  assert.equal(only.payload.body, 'Relecture : 1 remarque (1 MUST).', 'revue faite seulement de commentaires en ligne : synthèse, pas de corps vide');
  assert.equal(only.payload.event, 'COMMENT');
  // La suggestion n'est jointe que pour un ancrage en ligne.
  assert.doesNotMatch(commentBody({ ...must, suggestion: 'x', anchor: 'body' }), /suggestion/);
  assert.match(commentBody({ ...must, suggestion: 'x', anchor: 'line' }), /\n\n```suggestion\nx\n```$/);
});

test('publish : team.json review.maxInlineCould appliqué ; constat validé d\'un ancien round non publié', () => {
  const project = reviewed({ review: { axes: { frontend: [], backend: ['src/**'] }, maxInlineCould: 1 } });
  decide(project, { R1: { decision: 'ok', label: 'COULD' }, R4: 'ok' });
  const review = readReview(project.reviewDir);
  // R2 validé mais absent du dernier round (lastRound antérieur) : jamais envoyé.
  review.rounds.push({ ...review.rounds[0], n: 2, headSha: SHA2, previousHeadSha: SHA, status: 'reviewed' });
  for (const f of review.findings) f.lastRound = f.id === 'R2' ? 1 : 2;
  byId(review, 'R2').decision = 'ok';
  writeFileSync(join(project.reviewDir, 'review.json'), JSON.stringify(review));
  const out = run(project, fakeExec(routes({ 'gh pr view 42 --json headRefOid,state': { stdout: JSON.stringify({ headRefOid: SHA2, state: 'OPEN' }) } })).exec, { dryRun: true });
  assert.equal(out.code, 0, out.message);
  assert.match(out.message, /1 constat\(s\) validé\(s\) absent\(s\) du dernier round/);
  assert.equal(out.payload.comments.length, 1);
  assert.match(out.payload.body, /### Suggestions/);
  assert.doesNotMatch(JSON.stringify(out.payload), /Garde incomplète/);
  assert.equal(out.payload.commit_id, SHA2);
});

test('publish : la revue est partie mais la relecture des commentaires échoue → publication notée, pas de second envoi', () => {
  const project = reviewed();
  decide(project, { R1: 'ok' });
  const out = run(project, fakeExec(publishRoutes(project, { [CREATED]: { code: 1, stderr: 'HTTP 502' } })).exec);
  assert.equal(out.code, 0);
  assert.match(out.message, /commentaires de la revue non relus/);
  const f = byId(readReview(project.reviewDir), 'R1');
  assert.deepEqual([f.publication.reviewId, f.publication.commentId], [9001, null]);
  const { exec, calls } = fakeExec({});
  assert.match(run(project, exec).message, /rien à publier/);
  assert.deepEqual(calls, []);

  const failed = reviewed();
  decide(failed, { R1: 'ok' });
  const before = reviewText(failed.reviewDir);
  const ko = run(failed, fakeExec(publishRoutes(failed, { [POST]: { code: 1, stderr: 'HTTP 422: Unprocessable Entity' } })).exec);
  assert.equal(ko.code, 2);
  assert.match(ko.message, /422/);
  assert.equal(reviewText(failed.reviewDir), before, 'envoi refusé : rien n\'est noté comme publié');
});

// --- publish : mode fixes ---

test('publish : mode fixes → fixes.md, aucun appel gh, publication sans reviewId', () => {
  const project = reviewed({ routes: { 'gh api user': { stdout: JSON.stringify({ login: 'bob' }) } } });
  assert.equal(readReview(project.reviewDir).mode, 'fixes');
  decide(project, { R1: 'ok', R2: 'ok', R4: 'ko' });
  const before = reviewText(project.reviewDir);

  const dry = fakeExec({});
  const preview = run(project, dry.exec, { dryRun: true });
  assert.equal(preview.code, 0);
  assert.deepEqual(dry.calls, []);
  assert.ok(!existsSync(join(project.reviewDir, 'fixes.md')));
  assert.equal(reviewText(project.reviewDir), before);

  const { exec, calls } = fakeExec({});
  const out = run(project, exec);
  assert.equal(out.code, 0, out.message);
  assert.deepEqual(calls, [], 'aucune commande gh, ni lecture ni écriture');
  const md = readFileSync(join(project.reviewDir, 'fixes.md'), 'utf8');
  assert.equal(md, [
    '# Corrections à faire — PR #42', '', 'Export CSV : virgules et bouton', '',
    '## 1. MUST · Garde incomplète', '', '`src/export.js:11`', '', '**Problème.** Un champ contenant une virgule est coupé en deux colonnes.', '',
    '**Correction.** Entourer de guillemets les champs contenant une virgule.', '',
    '## 2. SHOULD · Les virgules dans un champ ne sont pas échappées', '', '`src/export.js:12`', '', '**Problème.** Un champ contenant une virgule est coupé en deux colonnes.', '',
    '**Correction.** Entourer de guillemets les champs contenant une virgule.', '',
  ].join('\n'));
  const review = readReview(project.reviewDir);
  assert.deepEqual(byId(review, 'R1').publication, { round: 1, at: '2026-11-13T10:00:00.000Z', reviewId: null, commentId: null, url: null });
  assert.equal(byId(review, 'R4').publication, null);
  assert.equal(review.rounds[0].status, 'published');
  assert.ok(!existsSync(join(project.reviewDir, 'publications.jsonl')));
  assert.ok(!existsSync(join(project.reviewDir, 'rounds', '1', 'publish-payload.json')));
  assert.match(run(project, fakeExec({}).exec).message, /rien à publier/);
  assert.equal(readFileSync(join(project.reviewDir, 'fixes.md'), 'utf8'), md);
});

// --- serve ---

const TOKEN = 'jeton-de-test-0123456789';
function call(handler, { method = 'GET', url, body, remote = '127.0.0.1', host = '127.0.0.1:4173' }) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  Object.assign(req, { method, url, headers: { host }, socket: { remoteAddress: remote } });
  return new Promise((resolve) => {
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(text) { resolve({ status: this.status, headers: this.headers, text, json: () => JSON.parse(text) }); },
    };
    handler(req, res);
  });
}
function served() {
  const project = reviewed();
  return { project, handler: createHandler({ reviewDir: project.reviewDir, token: TOKEN, now: NOW }) };
}

test('serve : sans jeton, mauvais jeton, hors 127.0.0.1 → 403 ; avec jeton → page et review.json', async () => {
  const { project, handler } = served();
  for (const url of ['/', '/?t=', '/?t=mauvais', `/?t=${TOKEN}x`, '/api/review', '/api/review?t=nope']) {
    assert.equal((await call(handler, { url })).status, 403, url);
  }
  assert.equal((await call(handler, { url: `/?t=${TOKEN}`, remote: '192.168.1.20' })).status, 403);
  assert.equal((await call(handler, { url: `/?t=${TOKEN}`, host: 'evil.example:4173' })).status, 403, 'rebond DNS');
  assert.equal((await call(handler, { method: 'POST', url: '/api/findings/R1', body: '{"decision":"ok"}' })).status, 403);

  const page = await call(handler, { url: `/?t=${TOKEN}` });
  assert.equal(page.status, 200);
  assert.match(page.headers['Content-Type'], /text\/html/);
  assert.equal(page.text, readFileSync(join(TEMPLATE_CLAUDE, 'skills/team-review/report/index.html'), 'utf8'), 'fichier statique servi tel quel');
  assert.match(page.headers['Content-Security-Policy'], /default-src 'none'/);
  assert.equal(page.headers['Cache-Control'], 'no-store');

  const review = await call(handler, { url: `/api/review?t=${TOKEN}` });
  assert.equal(review.status, 200);
  assert.deepEqual(review.json(), readReview(project.reviewDir));
  assert.equal((await call(handler, { url: `/api/review?t=${TOKEN}`, remote: '::ffff:127.0.0.1' })).status, 200);
  assert.equal((await call(handler, { url: `/inconnu?t=${TOKEN}` })).status, 404);
  assert.throws(() => createHandler({ reviewDir: project.reviewDir, token: '' }), /jeton/);
});

test('serve : POST valide → applyDecision puis écriture ; POST invalide → 400, rien n\'est écrit ; corps trop gros → 413', async () => {
  const { project, handler } = served();
  const post = (id, body) => call(handler, { method: 'POST', url: `/api/findings/${id}?t=${TOKEN}`, body: typeof body === 'string' ? body : JSON.stringify(body) });

  const ok = await post('R1', { decision: 'ok', rating: 'correct', label: 'MUST', comment: 'Texte édité dans le rapport.', note: 'à voir' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json().finding.comment, 'Texte édité dans le rapport.');
  const f = byId(readReview(project.reviewDir), 'R1');
  assert.deepEqual([f.decision, f.rating, f.label, f.comment, f.note, f.ratedAt], ['ok', 'correct', 'MUST', 'Texte édité dans le rapport.', 'à voir', '2026-11-13T10:00:00.000Z']);

  const before = reviewText(project.reviewDir);
  for (const [id, body, re] of [
    ['R1', { label: 'NIT' }, /label/], ['R99', { decision: 'ok' }, /inconnu/], ['R1', { comment: '' }, /commentaire vide/],
    ['R1', { publication: { reviewId: 1 } }, /non modifiable/], ['R1', '{ pas du json', /JSON invalide/], ['R1', '[]', /objet/],
  ]) {
    const res = await post(id, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.json().errors.join('\n'), re);
  }
  const big = await post('R1', { note: 'x'.repeat(MAX_BODY_BYTES) });
  assert.equal(big.status, 413);
  assert.equal((await call(handler, { url: `/api/findings/R1?t=${TOKEN}` })).status, 405);
  assert.equal(reviewText(project.reviewDir), before);
});

test('serve : aucune route de publication, aucun accès à gh dans le serveur ni dans la page', async () => {
  const { handler } = served();
  for (const url of ['/api/publish', '/publish', '/api/review/publish', '/api/findings/R1/publish']) {
    for (const method of ['GET', 'POST', 'PUT']) {
      assert.equal((await call(handler, { method, url: `${url}?t=${TOKEN}`, body: '{}' })).status, 404, `${method} ${url}`);
    }
  }
  const source = readFileSync(join(TEMPLATE_CLAUDE, 'skills/team-review/scripts/serve.mjs'), 'utf8');
  assert.doesNotMatch(source, /child_process|publish\.mjs'|createExec|spawn/);
  const page = readFileSync(join(TEMPLATE_CLAUDE, 'skills/team-review/report/index.html'), 'utf8');
  // Données de la PR : textContent seulement ; page autonome (ni CDN, ni ressource externe).
  assert.doesNotMatch(page, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/);
  assert.doesNotMatch(page, /https?:\/\//);
  assert.doesNotMatch(page, /<script[^>]+src=|<link[^>]+href=/);
  assert.match(page, /prefers-color-scheme: dark/);
  assert.match(page, /<html lang="fr">/);
});

test('serve : écoute sur 127.0.0.1 seulement, jeton aléatoire dans l\'URL', async () => {
  const project = reviewed();
  const { server, url } = await serve({ reviewDir: project.reviewDir });
  try {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{48}$/);
    assert.equal(server.address().address, '127.0.0.1');
    const res = await fetch(url.replace('/?t=', '/api/review?t='));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).id, 'pr-42');
    assert.equal((await fetch(url.replace(/\?t=.*/, ''))).status, 403);
  } finally {
    server.close();
  }
});

// --- stats ---

test('stats : par agent — constats, corrects, incorrects, précision, publiés, modifiés avant envoi ; calibration.json', () => {
  const project = reviewed();
  writeDeliverable(project.reviewDir, reviewerDeliverable('architecture', [finding({ id: 'A1' })]));
  mergeFindings({ reviewDir: project.reviewDir, claudeDir: project.claudeDir, exec: fakeExec({}).exec, now: NOW });
  let review = readReview(project.reviewDir);
  const at = (n) => `2026-11-13T10:${String(n).padStart(2, '0')}:00.000Z`;
  review = applyDecision(review, 'R1', { decision: 'ok', rating: 'correct', comment: 'Réécrit avant envoi.' }, at(1)).review;
  review = applyDecision(review, 'R2', { decision: 'ok', rating: 'correct' }, at(2)).review;
  review = applyDecision(review, 'R3', { rating: 'incorrect', note: 'appelant déjà migré' }, at(3)).review;
  review = applyDecision(review, 'R4', { rating: 'incorrect', note: 'voulu' }, at(4)).review;
  for (const id of ['R1', 'R2']) byId(review, id).publication = { round: 1, at: at(5), reviewId: 9001, commentId: 1, url: null };
  writeFileSync(join(project.reviewDir, 'review.json'), JSON.stringify(review));

  const out = stats({ claudeDir: project.claudeDir, now: NOW });
  assert.equal(out.reviews, 1);
  assert.deepEqual(out.agents['cc-pr-reviewer-backend'], { findings: 4, correct: 2, incorrect: 2, rated: 4, precision: 0.5, published: 2, edited: 1 });
  assert.deepEqual(out.agents['cc-pr-reviewer-architecture'], { findings: 1, correct: 1, incorrect: 0, rated: 1, precision: 1, published: 1, edited: 1 });
  assert.match(formatStats(out), /cc-pr-reviewer-backend : 4 constat\(s\), 2 correct\(s\), 2 incorrect\(s\), précision 50 %, 2 publié\(s\) dont 1 modifié\(s\) avant envoi/);

  const calibration = JSON.parse(readFileSync(join(project.projectDir, '.agent-reviews', 'calibration.json'), 'utf8'));
  assert.equal(calibration.generatedAt, '2026-11-13T10:00:00.000Z');
  assert.deepEqual(calibration.agents, {
    'cc-pr-reviewer-backend': { incorrect: [
      { title: 'Appelant non mis à jour', file: 'src/routes.js', note: 'appelant déjà migré' },
      { title: 'Lien jamais retiré', file: 'src/export.js', note: 'voulu' },
    ] },
  });
  // calibration.json et batch/ ne sont pas des revues.
  assert.equal(computeStats({ claudeDir: project.claudeDir }).reviews, 1);
});

test('stats : les 10 derniers faux positifs seulement ; aucune revue → rien n\'est écrit', () => {
  const project = fetched();
  const many = Array.from({ length: 12 }, (_, i) => finding({ id: `B${i}`, snippet: `ligne ${i}`, title: `Constat ${i}` }));
  writeDeliverable(project.reviewDir, reviewerDeliverable('backend', many));
  mergeFindings({ reviewDir: project.reviewDir, claudeDir: project.claudeDir, exec: fakeExec({}).exec, now: NOW });
  let review = readReview(project.reviewDir);
  // Notés dans l'ordre inverse : le plus récent est R1.
  for (let i = 12; i >= 1; i--) review = applyDecision(review, `R${i}`, { rating: 'incorrect' }, `2026-11-13T11:${String(30 - i).padStart(2, '0')}:00.000Z`).review;
  writeFileSync(join(project.reviewDir, 'review.json'), JSON.stringify(review));
  const titles = stats({ claudeDir: project.claudeDir, now: NOW }).calibration.agents['cc-pr-reviewer-backend'].incorrect.map((x) => x.title);
  assert.equal(titles.length, 10);
  assert.equal(titles.at(-1), 'Constat 0', 'le dernier noté en dernier');
  assert.ok(!titles.includes('Constat 11') && !titles.includes('Constat 10'), 'les deux plus anciens sont écartés');

  const empty = makeReviewProject();
  const none = stats({ claudeDir: empty.claudeDir, now: NOW });
  assert.equal(none.reviews, 0);
  assert.equal(formatStats(none), 'Aucune revue dans .agent-reviews/.');
  assert.ok(!existsSync(join(empty.projectDir, '.agent-reviews')));
});

// --- review-batch ---

const silent = { log: () => {}, warn: () => {} };

test('review-batch : simulation par défaut — liste les PR en attente et la commande, ne lance pas claude, n\'écrit rien', () => {
  const project = fetched();
  const lines = [];
  const { exec, calls } = fakeExec(routes());
  const out = reviewBatch({ argv: [], claudeDir: project.claudeDir, exec, env: { CLAUDECODE: '1' }, now: NOW, log: (l) => lines.push(l), warn: () => {} });
  assert.equal(out.code, 0);
  assert.equal(out.report.dryRun, true);
  assert.deepEqual(out.report.prs.map((p) => [p.number, p.outcome, p.command]), [
    [43, 'dry-run', 'claude -p "/team-review 43 --prepare" --output-format json'],
    [45, 'dry-run', 'claude -p "/team-review 45 --prepare" --output-format json'],
  ]);
  assert.ok(!calls.some((c) => c.startsWith('claude')), 'claude jamais lancé en simulation');
  for (const call of calls) assert.equal(evaluateCommand(call, guardCtx), null, call);
  assert.ok(!existsSync(join(project.projectDir, '.agent-reviews', 'batch')));
  assert.match(lines.join('\n'), /simulation : relance avec --yes/);
  assert.match(lines.join('\n'), /#43 .*claude -p "\/team-review 43 --prepare"/);
});

test('review-batch --yes : lance claude en série, au plus --max, rapport écrit ; ne publie jamais', () => {
  const project = makeReviewProject();
  const { exec, calls } = fakeExec(routes({
    'claude -p /team-review 42 --prepare': { stdout: JSON.stringify({ total_cost_usd: 0.42, num_turns: 12 }) },
    'claude -p /team-review 43 --prepare': { code: 1, stderr: 'boom' },
  }));
  const out = reviewBatch({ argv: ['--yes', '--max', '2'], claudeDir: project.claudeDir, exec, env: {}, now: NOW, ...silent });
  assert.equal(out.code, 1, 'une préparation a échoué');
  assert.deepEqual(calls.filter((c) => c.startsWith('claude')), [
    'claude -p /team-review 42 --prepare --output-format json', 'claude -p /team-review 43 --prepare --output-format json',
  ]);
  assert.deepEqual(out.report.prs.map((p) => [p.number, p.outcome, p.costUsd ?? null]), [[42, 'prepared', 0.42], [43, 'error', null]]);
  assert.deepEqual(out.report.skipped, [{ number: 45, reason: 'au-delà de la limite (2)' }]);
  assert.ok(!calls.some((c) => /publish|--method|POST/.test(c)));
  const [file] = readdirSync(join(project.projectDir, '.agent-reviews', 'batch'));
  assert.equal(file, '2026-11-13T10-00-00-000Z.json');
  assert.deepEqual(claudeArgs(7), ['-p', '/team-review 7 --prepare', '--output-format', 'json']);
});

test('review-batch : --max par défaut depuis team.json ; refus dans une session Claude Code ; arguments invalides ; erreur gh', () => {
  const project = makeReviewProject({ review: { batch: { maxPrs: 1 } } });
  const out = reviewBatch({ argv: [], claudeDir: project.claudeDir, exec: fakeExec(routes()).exec, env: {}, now: NOW, ...silent });
  assert.equal(out.report.max, 1);
  assert.deepEqual(out.report.prs.map((p) => p.number), [42]);
  assert.equal(out.report.skipped.length, 2);

  const warnings = [];
  const refused = reviewBatch({ argv: ['--yes'], claudeDir: project.claudeDir, exec: fakeExec({}).exec, env: { CLAUDECODE: '1' }, log: () => {}, warn: (w) => warnings.push(w) });
  assert.equal(refused.code, 2);
  assert.match(warnings.join('\n'), /CLAUDECODE/);
  for (const argv of [['--max', '0'], ['--max'], ['--publish'], ['--dry-run']]) {
    assert.equal(reviewBatch({ argv, claudeDir: project.claudeDir, exec: fakeExec({}).exec, env: {}, ...silent }).code, 2, argv.join(' '));
  }
  const listRoute = Object.keys(routes()).find((k) => k.startsWith('gh pr list'));
  assert.equal(reviewBatch({ argv: [], claudeDir: project.claudeDir, exec: fakeExec(routes({ [listRoute]: { code: 1, stderr: 'gh auth login' } })).exec, env: {}, ...silent }).code, 2);
});
