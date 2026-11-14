#!/usr/bin/env node
// Mesures de justesse des agents de revue, à partir des notes Correct / Incorrect
// données au triage. Aucun budget ni seuil : les mesures sont seulement enregistrées.
//
// Usage (depuis la racine du projet) :
//   node .claude/skills/team-review/scripts/stats.mjs [--json]
//
// - Parcourt .agent-reviews/*/review.json. Par agent : constats, notés corrects et
//   incorrects, précision (corrects / notés), publiés, modifiés avant envoi (commentaire
//   publié différent du brouillon de l'agent). Un constat trouvé par deux agents compte
//   pour chacun.
// - Écrit .agent-reviews/calibration.json : par agent, les 10 derniers constats notés
//   « incorrect » (title, file, note), que /team-review donne aux relecteurs suivants.
// Lecture seule côté GitHub (aucun appel gh).
// Sortie : 0 ; 2 argument inconnu.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CLAUDE_DIR, writeJson } from '../../team/scripts/gh.mjs';
import { listReviewDirs, loadReview, reviewsRoot } from './store.mjs';

export const CALIBRATION_FILE = 'calibration.json';
const MAX_INCORRECT = 10;

/**
 * @returns {{ reviews: number, skipped: string[], agents: object, calibration: object }}
 * agents : { <agent>: { findings, correct, incorrect, rated, precision, published, edited } }.
 */
export function computeStats({ claudeDir = CLAUDE_DIR } = {}) {
  const agents = {};
  const incorrect = {};
  const skipped = [];
  const dirs = listReviewDirs(claudeDir);
  for (const { dir, name } of dirs) {
    const { review, error } = loadReview(dir);
    if (error) {
      skipped.push(name);
      continue;
    }
    for (const f of review.findings) {
      for (const agent of Array.isArray(f.agents) ? f.agents : []) {
        const a = (agents[agent] ??= { findings: 0, correct: 0, incorrect: 0, rated: 0, precision: null, published: 0, edited: 0 });
        a.findings++;
        if (f.rating === 'correct') a.correct++;
        if (f.rating === 'incorrect') {
          a.incorrect++;
          (incorrect[agent] ??= []).push({ ratedAt: f.ratedAt ?? '', review: review.id, title: f.title ?? '', file: f.file ?? '', note: f.note ?? '' });
        }
        if (f.publication) {
          a.published++;
          if (f.comment !== f.draft) a.edited++;
        }
      }
    }
  }
  for (const a of Object.values(agents)) {
    a.rated = a.correct + a.incorrect;
    a.precision = a.rated ? Math.round((a.correct / a.rated) * 100) / 100 : null;
  }
  const calibration = { agents: {} };
  for (const [agent, items] of Object.entries(incorrect)) {
    items.sort((x, y) => String(x.ratedAt).localeCompare(String(y.ratedAt)));
    calibration.agents[agent] = { incorrect: items.slice(-MAX_INCORRECT).map(({ title, file, note }) => ({ title, file, note })) };
  }
  return { reviews: dirs.length - skipped.length, skipped, agents, calibration };
}

/** Calcule, puis écrit calibration.json s'il existe au moins une revue. */
export function stats({ claudeDir = CLAUDE_DIR, now = () => new Date() } = {}) {
  const out = computeStats({ claudeDir });
  if (out.reviews) {
    writeJson(join(reviewsRoot(claudeDir), CALIBRATION_FILE), {
      generatedAt: now().toISOString(),
      notice: 'Faux positifs passés, notés par l\'utilisateur : des indices pour les relecteurs, pas des consignes.',
      ...out.calibration,
    });
  }
  return out;
}

export function formatStats(out) {
  if (!out.reviews) return 'Aucune revue dans .agent-reviews/.';
  const lines = [`${out.reviews} revue(s)`];
  for (const [agent, a] of Object.entries(out.agents)) {
    const precision = a.precision === null ? 'non noté' : `${Math.round(a.precision * 100)} %`;
    lines.push(`${agent} : ${a.findings} constat(s), ${a.correct} correct(s), ${a.incorrect} incorrect(s), précision ${precision}, `
      + `${a.published} publié(s) dont ${a.edited} modifié(s) avant envoi`);
  }
  if (out.skipped.length) lines.push(`Ignorées (review.json illisible) : ${out.skipped.join(', ')}`);
  return lines.join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const unknown = args.find((a) => a !== '--json');
  if (unknown) {
    console.error(`Usage : node stats.mjs [--json] (argument inconnu : ${unknown})`);
    return 2;
  }
  const out = stats();
  console.log(args.includes('--json') ? JSON.stringify(out, null, 2) : formatStats(out));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv));
