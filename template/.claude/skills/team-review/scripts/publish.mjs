#!/usr/bin/env node
// Publie les constats validés d'une revue de PR : UNE revue GitHub (mode comments) ou
// une liste de corrections locale (mode fixes). Seul script du module qui écrit sur
// GitHub ; aucun agent ne le lance sans accord explicite (guard-bash : ask).
//
// Usage (depuis la racine du projet) :
//   node .claude/skills/team-review/scripts/publish.mjs .agent-reviews/pr-<n> [--dry-run]
//        [--event COMMENT|APPROVE|REQUEST_CHANGES]
//
// Mode comments : prend les constats du dernier round dont la décision est « ok » et qui
// ne sont pas encore publiés. Vérifie par `gh pr view <n> --json headRefOid,state`
// (lecture) que la PR n'a pas bougé depuis le round. Écrit rounds/<k>/publish-payload.json
// puis, sans --dry-run, envoie `gh api --method POST repos/{owner}/{repo}/pulls/<n>/reviews
// --input <fichier>` (seule écriture), relit les commentaires créés (`gh api …/reviews/
// <id>/comments --paginate`), note la publication de chaque constat, ajoute une ligne par
// constat à publications.jsonl et passe le round à « published ».
// --dry-run : aperçu de ce qui partirait, aucune écriture sur GitHub ni dans review.json.
// --event : COMMENT par défaut ; APPROVE ou REQUEST_CHANGES seulement avec cette option.
// Mode fixes (PR de l'utilisateur) : aucun appel gh ; écrit fixes.md.
// Idempotent : un second lancement n'envoie rien.
// Sortie : 0 ok (ou rien à publier), 2 erreur, 3 PR modifiée depuis le round (rien
// envoyé : relance pr-fetch).

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CLAUDE_DIR, GhError, addLog, createExec, parseJsonValues, readTeam, run, runJson, writeJson } from '../../team/scripts/gh.mjs';
import { EVENTS, LABELS, SEVERITY_ORDER, activeFindings, fileLine, lastRound, loadReview, reviewConfig, roundDir } from './store.mjs';

const ACTOR = 'publish';
const order = (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  || Number(a.id.slice(1)) - Number(b.id.slice(1)) || a.id.localeCompare(b.id);

/** Corps d'un commentaire en ligne : étiquette, titre, texte, puis la suggestion éventuelle. */
export function commentBody(f) {
  const suggestion = f.suggestion !== null && f.suggestion !== undefined && f.anchor === 'line'
    ? `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\`` : '';
  return `**${f.label}** · ${f.title}\n\n${f.comment.trim()}${suggestion}`;
}

const bodyItem = (f) => `- **${f.label}** · ${f.title} (\`${fileLine(f)}\`)\n\n  ${f.comment.trim().split(/\r?\n/).join('\n  ')}`;

/**
 * Charge utile de la revue GitHub à partir des constats à publier.
 * @returns {{ payload, inline: object[], outOfDiff: object[], grouped: object[] }}
 */
export function buildPayload({ findings, headSha, event = 'COMMENT', maxInlineCould = 5 }) {
  const sorted = [...findings].sort(order);
  const inline = [];
  const outOfDiff = [];
  const grouped = [];
  let could = 0;
  for (const f of sorted) {
    if (f.anchor !== 'line') outOfDiff.push(f);
    else if (f.label === 'COULD' && ++could > maxInlineCould) grouped.push(f);
    else inline.push(f);
  }
  const counts = LABELS.map((l) => [l, sorted.filter((f) => f.label === l).length]).filter(([, n]) => n);
  const sections = [`Relecture : ${sorted.length} remarque${sorted.length > 1 ? 's' : ''} (${counts.map(([l, n]) => `${n} ${l}`).join(', ')}).`];
  if (outOfDiff.length) sections.push(`### Hors diff\n\n${outOfDiff.map(bodyItem).join('\n\n')}`);
  if (grouped.length) sections.push(`### Suggestions\n\n${grouped.map(bodyItem).join('\n\n')}`);
  const comments = inline.map((f) => {
    const range = f.endLine !== null && f.endLine !== undefined && f.endLine > f.line;
    return {
      path: f.file, line: range ? f.endLine : f.line, side: 'RIGHT',
      ...(range ? { start_line: f.line, start_side: 'RIGHT' } : {}),
      body: commentBody(f),
    };
  });
  return { payload: { commit_id: headSha, event, body: sections.join('\n\n'), comments }, inline, outOfDiff, grouped };
}

/** Aperçu lisible de ce qui partirait. */
function preview(review, built, event) {
  const lines = [`Revue de la PR #${review.pr.number} (${event}) — ${built.inline.length} commentaire(s) en ligne, `
    + `${built.outOfDiff.length} hors diff, ${built.grouped.length} suggestion(s) regroupée(s)`, '', '--- Corps de la revue ---', built.payload.body];
  for (const [i, c] of built.payload.comments.entries()) {
    const at = c.start_line ? `${c.path}:${c.start_line}-${c.line}` : `${c.path}:${c.line}`;
    lines.push('', `--- ${built.inline[i].id} → ${at} ---`, c.body);
  }
  return lines.join('\n');
}

/** Liste de corrections locale (mode fixes) : une entrée numérotée par constat validé. */
export function fixesMarkdown(review, findings) {
  const out = [`# Corrections à faire — PR #${review.pr.number}`, '', `${review.pr.title}`.trim(), ''];
  [...findings].sort(order).forEach((f, i) => {
    out.push(`## ${i + 1}. ${f.label} · ${f.title}`, '', `\`${fileLine(f)}\``, '', `**Problème.** ${f.problem}`, '', `**Correction.** ${f.fix || f.comment}`, '');
  });
  return `${out.join('\n').trimEnd()}\n`;
}

/** Rattache à chaque constat en ligne le commentaire créé : même chemin, même corps (puis ligne si connue). */
function matchComments(inline, payloadComments, created) {
  const pool = [...created];
  return inline.map((f, i) => {
    const sent = payloadComments[i];
    const same = (c) => c.path === sent.path && String(c.body ?? '').trim() === sent.body.trim();
    let at = pool.findIndex((c) => same(c) && (c.line === undefined || c.line === null || c.line === sent.line));
    if (at === -1) at = pool.findIndex((c) => c.path === sent.path && String(c.body ?? '').startsWith(sent.body.slice(0, 80)));
    const found = at > -1 ? pool.splice(at, 1)[0] : null;
    return { finding: f, commentId: found?.id ?? null, url: found?.html_url ?? null };
  });
}

/**
 * Renvoie { code, message, preview?, payload? }. exec et now sont injectables (tests).
 * event : valeur de --event, ou undefined (COMMENT).
 */
export function publish({ reviewDir, claudeDir = CLAUDE_DIR, exec, now = () => new Date(), dryRun = false, event }) {
  if (event !== undefined && !EVENTS.includes(event)) return { code: 2, message: `--event « ${event} » invalide (${EVENTS.join(', ')})` };
  const loaded = loadReview(reviewDir);
  if (loaded.error) return { code: 2, message: loaded.error };
  const review = loaded.review;
  const round = lastRound(review);
  const config = reviewConfig(readTeam(claudeDir));
  const notes = [];
  if (event === undefined && config.event !== 'COMMENT') notes.push(`review.event = ${config.event} dans team.json est ignoré sans --event : la revue part en COMMENT`);
  const kind = event ?? 'COMMENT';

  const validated = review.findings.filter((f) => f.decision === 'ok' && !f.publication);
  const todo = validated.filter((f) => f.lastRound === round.n);
  if (validated.length > todo.length) notes.push(`${validated.length - todo.length} constat(s) validé(s) absent(s) du dernier round : non publiés`);
  const withNotes = (message) => [message, ...notes].join('\n');
  if (!todo.length) return { code: 0, message: withNotes(`${review.id} : rien à publier (aucun constat validé non publié dans le round ${round.n})`) };
  const empty = todo.filter((f) => !String(f.comment ?? '').trim());
  if (empty.length) return { code: 2, message: `commentaire vide pour ${empty.map((f) => f.id).join(', ')} : complète-le ou rejette le constat` };
  const at = now().toISOString();

  if (review.mode === 'fixes') {
    const all = activeFindings(review).filter((f) => f.decision === 'ok');
    const markdown = fixesMarkdown(review, all);
    if (dryRun) return { code: 0, message: withNotes(`[simulation] ${todo.length} correction(s) iraient dans fixes.md (rien n'est écrit, rien n'est envoyé)`), preview: markdown };
    writeFileSync(join(reviewDir, 'fixes.md'), markdown);
    for (const f of todo) f.publication = { round: round.n, at, reviewId: null, commentId: null, url: null };
    round.status = 'published';
    addLog(review, at, ACTOR, 'fixes_written', `${todo.length} correction(s) → fixes.md`);
    writeJson(join(reviewDir, 'review.json'), review);
    return { code: 0, message: withNotes(`${review.id} : ${todo.length} correction(s) écrite(s) dans ${join(reviewDir, 'fixes.md')} (rien n'est envoyé sur GitHub)`), preview: markdown };
  }

  exec = exec ?? createExec(dirname(claudeDir));
  const n = review.pr.number;
  try {
    const view = runJson(exec, 'gh', ['pr', 'view', String(n), '--json', 'headRefOid,state']);
    if (view.state && view.state !== 'OPEN') return { code: 2, message: `PR #${n} ${view.state} : rien n'est envoyé` };
    if (view.headRefOid !== round.headSha) {
      return { code: 3, message: `la PR #${n} a bougé (${round.headSha.slice(0, 7)} → ${String(view.headRefOid).slice(0, 7)}) : rien n'est envoyé, relance pr-fetch` };
    }
    const built = buildPayload({ findings: todo, headSha: round.headSha, event: kind, maxInlineCould: config.maxInlineCould });
    const payloadPath = join(roundDir(reviewDir, round.n), 'publish-payload.json');
    mkdirSync(dirname(payloadPath), { recursive: true });
    writeJson(payloadPath, built.payload);
    const text = preview(review, built, kind);
    if (dryRun) return { code: 0, message: withNotes(`[simulation] rien n'est envoyé. Charge utile : ${payloadPath}`), preview: text, payload: built.payload };

    const response = run(exec, 'gh', ['api', '--method', 'POST', `repos/{owner}/{repo}/pulls/${n}/reviews`, '--input', payloadPath]);
    // La revue est partie : on note la publication AVANT toute autre lecture, pour ne
    // jamais renvoyer deux fois les mêmes commentaires si la suite échoue.
    let posted = {};
    try {
      posted = JSON.parse(response);
    } catch {
      notes.push('réponse de GitHub illisible : identifiant de la revue inconnu');
    }
    const reviewId = posted?.id ?? null;
    const reviewUrl = posted?.html_url ?? null;
    for (const f of todo) f.publication = { round: round.n, at, reviewId, commentId: null, url: reviewUrl };
    round.status = 'published';
    addLog(review, at, ACTOR, 'review_published', `revue ${reviewId ?? '?'} (${kind}) : ${todo.length} constat(s), ${built.inline.length} en ligne`);
    writeJson(join(reviewDir, 'review.json'), review);

    if (reviewId !== null && built.inline.length) {
      try {
        const created = parseJsonValues(run(exec, 'gh', ['api', `repos/{owner}/{repo}/pulls/${n}/reviews/${reviewId}/comments`, '--paginate'])).flat();
        for (const m of matchComments(built.inline, built.payload.comments, created)) {
          m.finding.publication.commentId = m.commentId;
          if (m.url) m.finding.publication.url = m.url;
        }
        writeJson(join(reviewDir, 'review.json'), review);
      } catch (err) {
        if (!(err instanceof GhError)) throw err;
        notes.push(`commentaires de la revue non relus (${err.message}) : commentId absent`);
      }
    }
    const journal = todo.map((f) => JSON.stringify({
      at, finding: f.id, label: f.label, draft: f.draft, final: f.comment, headSha: round.headSha, reviewId, commentId: f.publication.commentId,
    }));
    appendFileSync(join(reviewDir, 'publications.jsonl'), `${journal.join('\n')}\n`);
    return { code: 0, message: withNotes(`PR #${n} : revue publiée (${kind}), ${todo.length} constat(s)${reviewUrl ? ` — ${reviewUrl}` : ''}`), preview: text, payload: built.payload };
  } catch (err) {
    if (err instanceof GhError) return { code: 2, message: err.message };
    throw err;
  }
}

function main(argv) {
  const args = argv.slice(2);
  const eventAt = args.indexOf('--event');
  const event = eventAt > -1 ? args[eventAt + 1] : undefined;
  const rest = args.filter((a, i) => a !== '--dry-run' && i !== eventAt && (eventAt === -1 || i !== eventAt + 1));
  if (rest.length !== 1 || rest[0].startsWith('--') || (eventAt > -1 && event === undefined)) {
    console.error('Usage : node publish.mjs .agent-reviews/pr-<n> [--dry-run] [--event COMMENT|APPROVE|REQUEST_CHANGES]');
    return 2;
  }
  let out;
  try {
    out = publish({ reviewDir: resolve(rest[0]), dryRun: args.includes('--dry-run'), event });
  } catch (err) {
    console.error(`erreur : ${err.message}`);
    return 2;
  }
  if (out.preview && args.includes('--dry-run')) console.log(out.preview);
  (out.code === 0 ? console.log : console.error)(out.code === 0 ? out.message : `erreur : ${out.message}`);
  return out.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv));
