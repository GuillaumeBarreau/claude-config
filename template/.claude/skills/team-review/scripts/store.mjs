// Magasin des revues de PR : .agent-reviews/pr-<n>/ à la racine du projet (ignoré par
// Git, comme .agent-runs/). Outils communs aux scripts de /team-review : chemins, lecture et
// contrôle de review.json, étiquettes, empreinte d'un constat, lecture d'un diff unifié.
//
//   review.json                       état de la revue (rounds, constats, décisions)
//   rounds/<k>/pr.json                métadonnées, CI, commentaires existants (données)
//   rounds/<k>/diff.patch             diff unifié de la PR
//   rounds/<k>/scope.json             fichiers par axe
//   rounds/<k>/deliverables/          livrables des agents (écrits par check-deliverable)
//   rounds/<k>/verify-input.json      constats à contre-vérifier, sans le raisonnement
//   rounds/<k>/publish-payload.json   charge utile envoyée (ou prévue en dry-run)
//   worktree/                         worktree Git jetable au commit de tête (mode worktree)
//   fixes.md, publications.jsonl      sorties de publish.mjs
//
// Chaque round porte `source` : où les agents lisent le code de la PR (source.mjs) —
// { mode: working-tree | git-show | worktree, headSha, path }.
//
// Ce module n'appelle ni gh ni git et n'a pas de ligne de commande.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { readJson, readTeam } from '../../team/scripts/gh.mjs';
import { normalizePath } from '../../team/scripts/sensitive.mjs';

export const REVIEWS_DIR = '.agent-reviews';
export const LABELS = ['MUST', 'SHOULD', 'COULD', 'ASK'];
export const DECISIONS = ['ok', 'ko', 'discuss'];
export const RATINGS = ['correct', 'incorrect'];
export const EVENTS = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];
export const MODES = ['comments', 'fixes'];
export const ROUND_STATUSES = ['fetched', 'reviewed', 'triaged', 'published'];
export const SOURCE_MODES = ['working-tree', 'git-show', 'worktree'];
export const SEVERITY_ORDER = ['critical', 'major', 'minor'];
export const DEFAULTS = { language: 'fr', event: 'COMMENT', maxInlineCould: 5, architectureMinLines: 150, axes: { frontend: [], backend: [] }, batch: { maxPrs: 3 } };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const positive = (v, fallback) => (Number.isInteger(v) && v > 0 ? v : fallback);
const patterns = (v) => (Array.isArray(v) ? v.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()) : []);

/** Section « review » de team.json, avec les valeurs par défaut. */
export function reviewConfig(team) {
  const r = isObject(team?.review) ? team.review : {};
  const axes = isObject(r.axes) ? r.axes : {};
  return {
    language: typeof r.language === 'string' && r.language.trim() ? r.language.trim() : DEFAULTS.language,
    event: EVENTS.includes(r.event) ? r.event : DEFAULTS.event,
    maxInlineCould: positive(r.maxInlineCould, DEFAULTS.maxInlineCould),
    architectureMinLines: positive(r.architectureMinLines, DEFAULTS.architectureMinLines),
    axes: { frontend: patterns(axes.frontend), backend: patterns(axes.backend) },
    batch: { maxPrs: positive(r.batch?.maxPrs, DEFAULTS.batch.maxPrs) },
  };
}

export const readReviewConfig = (claudeDir) => reviewConfig(readTeam(claudeDir));
export const reviewsRoot = (claudeDir) => join(dirname(claudeDir), REVIEWS_DIR);
export const reviewDirOf = (claudeDir, number) => join(reviewsRoot(claudeDir), `pr-${number}`);
export const roundDir = (reviewDir, n) => join(reviewDir, 'rounds', String(n));
export const worktreeDirOf = (reviewDir) => join(reviewDir, 'worktree');
/** Référence locale qui garde le commit de tête rapatrié (jamais sous refs/heads : invisible pour `git branch`). */
export const pullRef = (number) => `refs/claude-config/pr-${number}`;
export const lastRound = (review) => review.rounds.at(-1);

/** Erreurs de structure d'une source de round ([] = valide). */
export function checkSource(source, label = 'source') {
  if (!isObject(source)) return [`${label} : objet { mode, headSha, path } attendu`];
  const errors = [];
  if (!SOURCE_MODES.includes(source.mode)) errors.push(`${label}.mode : « ${source.mode} » invalide (${SOURCE_MODES.join(', ')})`);
  if (!(typeof source.headSha === 'string' && source.headSha)) errors.push(`${label}.headSha : texte non vide attendu`);
  if (!(source.path === null || (typeof source.path === 'string' && source.path))) errors.push(`${label}.path : texte non vide ou null attendu`);
  return errors;
}

/** Erreurs de structure de review.json ([] = utilisable par les scripts). */
export function checkReview(review) {
  if (!isObject(review)) return ['review.json : doit être un objet JSON'];
  const errors = [];
  if (review.version !== 1) errors.push('version : 1 attendu');
  if (!(typeof review.id === 'string' && /^pr-\d+$/.test(review.id))) errors.push('id : pr-<numéro> attendu');
  if (!isObject(review.pr) || !(Number.isInteger(review.pr.number) && review.pr.number > 0)) errors.push('pr.number : entier > 0 attendu');
  if (!MODES.includes(review.mode)) errors.push(`mode : « ${review.mode} » invalide (${MODES.join(', ')})`);
  if (!Array.isArray(review.rounds) || !review.rounds.length) errors.push('rounds : liste non vide attendue');
  else {
    review.rounds.forEach((r, i) => {
      if (!isObject(r) || r.n !== i + 1) errors.push(`rounds[${i}].n : ${i + 1} attendu`);
      else {
        if (!(typeof r.headSha === 'string' && r.headSha)) errors.push(`rounds[${i}].headSha : texte non vide attendu`);
        if (!ROUND_STATUSES.includes(r.status)) errors.push(`rounds[${i}].status : « ${r.status} » invalide (${ROUND_STATUSES.join(', ')})`);
        if (r.source !== undefined) errors.push(...checkSource(r.source, `rounds[${i}].source`));
      }
    });
  }
  if (!Array.isArray(review.findings)) errors.push('findings : liste attendue');
  else {
    review.findings.forEach((f, i) => {
      if (!isObject(f) || !(typeof f.id === 'string' && f.id)) errors.push(`findings[${i}].id : texte non vide attendu`);
    });
  }
  return errors;
}

/**
 * Lit et contrôle <reviewDir>/review.json.
 * @returns {{ review: object|null, error: string|null }}
 */
export function loadReview(reviewDir) {
  const file = join(reviewDir, 'review.json');
  if (!existsSync(file)) return { review: null, error: `${file} : absent (lance pr-fetch.mjs <numéro>)` };
  let review;
  try {
    review = readJson(file);
  } catch (err) {
    return { review: null, error: `${file} : JSON invalide — ${err.message}` };
  }
  const errors = checkReview(review);
  return errors.length ? { review: null, error: `${file} invalide : ${errors.join(' ; ')}` } : { review, error: null };
}

/** Dossiers de revue existants : [{ dir, name }] triés par numéro de PR. */
export function listReviewDirs(claudeDir) {
  const root = reviewsRoot(claudeDir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^pr-\d+$/.test(e.name) && existsSync(join(root, e.name, 'review.json')))
    .map((e) => ({ dir: join(root, e.name), name: e.name }))
    .sort((a, b) => Number(a.name.slice(3)) - Number(b.name.slice(3)));
}

/** Étiquette par défaut : question ou constat sans preuve → ASK ; sinon d'après la sévérité. */
export function defaultLabel({ kind, proof, severity }) {
  if (kind === 'question' || proof === 'none') return 'ASK';
  return { critical: 'MUST', major: 'SHOULD', minor: 'COULD' }[severity] ?? 'COULD';
}

/** Extrait normalisé : espaces compactés, lignes vides retirées. */
export function normalizeSnippet(text) {
  return String(text ?? '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Empreinte stable d'un constat : fichier, extrait normalisé, nature. Insensible aux numéros de ligne. */
export function fingerprint({ file, snippet, kind }) {
  return createHash('sha256').update([normalizePath(file), normalizeSnippet(snippet).join('\n'), kind].join('\u0000')).digest('hex');
}

const unquotePath = (p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p);

/**
 * Diff unifié → Map(chemin → [{ start, end, lines: Map(numéro côté droit → texte) }]).
 * Seules les lignes ajoutées et de contexte (côté droit) sont gardées : ce sont celles
 * qu'un commentaire de revue peut viser avec side RIGHT.
 */
export function parseDiff(patch) {
  const files = new Map();
  let hunks = null;
  let hunk = null;
  let right = 0;
  for (const line of String(patch ?? '').split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      hunks = null;
      hunk = null;
    } else if (!hunk && line.startsWith('+++ ')) {
      const target = unquotePath(line.slice(4).replace(/\t.*$/, ''));
      hunks = target === '/dev/null' ? null : [];
      if (hunks) files.set(normalizePath(target.replace(/^b\//, '')), hunks);
    } else if (line.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      hunk = null;
      if (m && hunks) {
        right = Number(m[1]);
        hunk = { start: right, end: right - 1, lines: new Map() };
        hunks.push(hunk);
      }
    } else if (hunk && (line.startsWith('+') || line.startsWith(' '))) {
      hunk.lines.set(right, line.slice(1));
      hunk.end = right;
      right++;
    } else if (hunk && !line.startsWith('-') && !line.startsWith('\\')) {
      hunk = null;
    }
  }
  return files;
}

/** Hunk du fichier qui contient la ligne (côté droit), ou null. */
export function hunkOf(diff, file, line) {
  if (!Number.isInteger(line)) return null;
  return (diff.get(normalizePath(file)) ?? []).find((h) => h.lines.has(line)) ?? null;
}

/** L'extrait normalisé apparaît-il, lignes consécutives, côté droit du diff de ce fichier ? */
export function snippetInDiff(diff, file, snippet) {
  const wanted = normalizeSnippet(snippet);
  if (!wanted.length) return false;
  return (diff.get(normalizePath(file)) ?? []).some((h) => {
    const lines = normalizeSnippet([...h.lines.values()].join('\n'));
    for (let i = 0; i + wanted.length <= lines.length; i++) {
      if (wanted.every((w, j) => lines[i + j] === w)) return true;
    }
    return false;
  });
}

/** Compteurs d'une liste de constats : par étiquette, décision, suivi et note. */
export function counters(findings) {
  const count = (keys, pick) => Object.fromEntries(keys.map((k) => [k, findings.filter((f) => pick(f) === k).length]));
  return {
    total: findings.length,
    labels: count(LABELS, (f) => f.label),
    decisions: count([...DECISIONS, 'none'], (f) => f.decision ?? 'none'),
    tracking: count(['new', 'persisting', 'fixed', 'unknown'], (f) => f.tracking),
    ratings: count([...RATINGS, 'none'], (f) => f.rating ?? 'none'),
    published: findings.filter((f) => f.publication).length,
    rejectedByVerifier: findings.filter((f) => f.verification?.verdict === 'rejected').length,
  };
}

/** Constats présents dans le dernier round (les seuls qu'on trie et qu'on publie). */
export const activeFindings = (review) => review.findings.filter((f) => f.lastRound === lastRound(review).n);

export const fileLine = (f) => (f.line ? `${f.file}:${f.line}` : f.file);
