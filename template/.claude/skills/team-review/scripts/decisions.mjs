#!/usr/bin/env node
// Triage d'un constat de revue : décision, note de justesse, étiquette, texte du
// commentaire, note libre. Même fonction (applyDecision) que le rapport local serve.mjs.
//
// Usage (depuis la racine du projet) :
//   node .claude/skills/team-review/scripts/decisions.mjs .agent-reviews/pr-<n> <id>
//        [--decision ok|ko|discuss|none] [--rating correct|incorrect|none]
//        [--label MUST|SHOULD|COULD|ASK] [--comment-file <fichier>] [--note <texte>]
//   node .claude/skills/team-review/scripts/decisions.mjs .agent-reviews/pr-<n> --summary
//
// Refuse : un identifiant inconnu, une valeur hors liste, un commentaire vide pour une
// décision « ok », et toute modification du texte publié (commentaire, étiquette,
// décision) d'un constat déjà publié. Écriture locale seulement (review.json).
// Sortie : 0 ok, 1 modification refusée (erreurs sur stderr), 2 usage ou review.json
// illisible.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeJson } from '../../team/scripts/gh.mjs';
import { DECISIONS, LABELS, RATINGS, activeFindings, counters, lastRound, loadReview } from './store.mjs';

export const PATCH_KEYS = ['decision', 'rating', 'label', 'comment', 'note'];

/**
 * Applique un triage à un constat. Fonction pure : `review` n'est pas modifié.
 * patch : { decision?: ok|ko|discuss|null, rating?: correct|incorrect|null, label?,
 * comment?, note? } ; une clé absente ne change rien.
 * @returns {{ review: object, finding: object|null, errors: string[] }} review inchangé si erreurs.
 */
export function applyDecision(review, id, patch, now = new Date().toISOString()) {
  const errors = [];
  const fail = () => ({ review, finding: null, errors });
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    errors.push('modification : objet attendu');
    return fail();
  }
  for (const key of Object.keys(patch).filter((k) => !PATCH_KEYS.includes(k))) errors.push(`champ « ${key} » non modifiable (${PATCH_KEYS.join(', ')})`);
  const next = structuredClone(review);
  const f = next.findings.find((x) => x.id === id);
  if (!f) {
    errors.push(`constat « ${id} » inconnu`);
    return fail();
  }
  const has = (key) => patch[key] !== undefined;
  if (has('decision') && patch.decision !== null && !DECISIONS.includes(patch.decision)) errors.push(`decision : « ${patch.decision} » invalide (${DECISIONS.join(', ')}, none)`);
  if (has('rating') && patch.rating !== null && !RATINGS.includes(patch.rating)) errors.push(`rating : « ${patch.rating} » invalide (${RATINGS.join(', ')}, none)`);
  if (has('label') && !LABELS.includes(patch.label)) errors.push(`label : « ${patch.label} » invalide (${LABELS.join(', ')})`);
  for (const key of ['comment', 'note']) if (has(key) && typeof patch[key] !== 'string') errors.push(`${key} : texte attendu`);
  if (errors.length) return fail();

  if (f.publication) {
    for (const key of ['comment', 'label', 'decision']) {
      if (has(key) && patch[key] !== f[key]) errors.push(`${id} est déjà publié : ${key} ne se modifie plus`);
    }
  }
  const decision = has('decision') ? patch.decision : f.decision;
  const comment = has('comment') ? patch.comment : f.comment;
  if (decision === 'ok' && !String(comment ?? '').trim()) errors.push(`${id} : commentaire vide, impossible de valider (decision ok)`);
  if (errors.length) return fail();

  for (const key of PATCH_KEYS) if (has(key)) f[key] = patch[key];
  if (has('rating')) f.ratedAt = patch.rating === null ? null : now;

  // Le round passe à « triaged » quand chaque constat du round a une décision, et en revient sinon.
  const round = lastRound(next);
  const done = activeFindings(next).every((x) => x.decision !== null);
  if (round.status === 'reviewed' && done) round.status = 'triaged';
  else if (round.status === 'triaged' && !done) round.status = 'reviewed';
  return { review: next, finding: f, errors };
}

/** Compteurs lisibles du dernier round. */
export function summary(review) {
  const c = counters(activeFindings(review));
  const line = (obj) => Object.entries(obj).map(([k, n]) => `${k} ${n}`).join(', ');
  return [
    `${review.id} (mode ${review.mode}), round ${lastRound(review).n} (${lastRound(review).status}) : ${c.total} constat(s)`,
    `Étiquettes : ${line(c.labels)}`,
    `Décisions : ${line(c.decisions)}`,
    `Notes : ${line(c.ratings)}`,
    `Suivi : ${line(c.tracking)}`,
    `Publiés : ${c.published} ; écartés par le vérificateur : ${c.rejectedByVerifier}`,
  ].join('\n');
}

const USAGE = 'Usage : node decisions.mjs .agent-reviews/pr-<n> <id> [--decision ok|ko|discuss|none] [--rating correct|incorrect|none] '
  + '[--label MUST|SHOULD|COULD|ASK] [--comment-file <fichier>] [--note <texte>]\n        node decisions.mjs .agent-reviews/pr-<n> --summary';

/** Arguments → { reviewDir, id, patch, summary } ; lève une erreur d'usage. */
export function parseArgs(args, readFile = (f) => readFileSync(f, 'utf8')) {
  const out = { reviewDir: null, id: null, patch: {}, summary: false };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--summary') out.summary = true;
    else if (['--decision', '--rating', '--label', '--comment-file', '--note'].includes(a)) {
      const value = args[++i];
      if (value === undefined) throw new Error(`${a} attend une valeur`);
      if (a === '--decision' || a === '--rating') out.patch[a.slice(2)] = value === 'none' ? null : value;
      else if (a === '--label') out.patch.label = value;
      else if (a === '--note') out.patch.note = value;
      else out.patch.comment = readFile(value).replace(/^﻿/, '').trim();
    } else if (a.startsWith('--')) throw new Error(`argument inconnu : ${a}`);
    else positional.push(a);
  }
  [out.reviewDir, out.id] = positional;
  if (!out.reviewDir || positional.length > 2) throw new Error('dossier de revue attendu');
  if (!out.summary && (!out.id || !Object.keys(out.patch).length)) throw new Error('identifiant de constat et au moins une modification attendus');
  return out;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv.slice(2));
  } catch (err) {
    console.error(`erreur : ${err.message}\n${USAGE}`);
    return 2;
  }
  const reviewDir = resolve(args.reviewDir);
  const loaded = loadReview(reviewDir);
  if (loaded.error) {
    console.error(`erreur : ${loaded.error}`);
    return 2;
  }
  if (args.summary) {
    console.log(summary(loaded.review));
    return 0;
  }
  const out = applyDecision(loaded.review, args.id, args.patch);
  if (out.errors.length) {
    for (const e of out.errors) console.error(`erreur : ${e}`);
    return 1;
  }
  writeJson(join(reviewDir, 'review.json'), out.review);
  const f = out.finding;
  console.log(`${f.id} : ${f.label}, décision ${f.decision ?? 'none'}, note ${f.rating ?? 'none'}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv));
