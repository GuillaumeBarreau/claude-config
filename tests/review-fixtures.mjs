// Outils des tests du module de revue de PR (/team-review) : projet temporaire, réponses gh
// enregistrées (tests/fixtures/gh/review-*), fabriques de livrables. Aucun test n'appelle
// le vrai gh ni le réseau.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VIEW_FIELDS, prFetch } from '../template/.claude/skills/team-review/scripts/pr-fetch.mjs';
import { LIST_FIELDS } from '../template/.claude/skills/team-review/scripts/pr-list.mjs';
import { SHA, fakeExec, fixture } from './gh-fixtures.mjs';

export { SHA };
export const SHA2 = '5555555555555555555555555555555555555555';
export const NOW = () => new Date('2026-11-13T10:00:00Z');
export const AXES = { frontend: ['ui/**'], backend: ['src/**'] };
export const guardCtx = { baseBranch: 'main', currentBranch: () => 'team/x' };

/** Commandes git de pr-fetch quand la copie de travail n'est pas sur la tête de la PR 42. */
export const FETCH = 'git fetch --no-tags --quiet origin +refs/pull/42/head:refs/claude-config/pr-42';
export const CAT_FILE = (sha) => `git cat-file -e ${sha}^{commit}`;

/** Routes git d'une copie de travail dont HEAD est `head` (working-tree si c'est la tête de la PR). */
export const gitRoutes = ({ head = SHA, dirty = '' } = {}) => ({
  'git rev-parse HEAD': { stdout: `${head}\n` },
  'git status --porcelain': { stdout: dirty },
  [FETCH]: {},
  'git cat-file -e': {},
});

/** Routes git du worktree de revue `dir` : `head` = commit du worktree présent (null : dossier pas un worktree). */
export const worktreeRoutes = (dir, { head = null } = {}) => ({
  [`git -C ${dir} rev-parse HEAD`]: head ? { stdout: `${head}\n` } : { code: 128, stderr: 'fatal: not a git repository' },
  [`git worktree remove --force ${dir}`]: () => {
    rmSync(dir, { recursive: true, force: true });
    return {};
  },
  'git worktree prune': {},
  [`git worktree add --detach ${dir}`]: () => {
    mkdirSync(dir, { recursive: true });
    return {};
  },
});

/** Projet temporaire avec .claude/team.json (section review). */
export function makeReviewProject({ review = { axes: AXES } } = {}) {
  const projectDir = mkdtempSync(join(tmpdir(), 'claude-config-review-'));
  const claudeDir = join(projectDir, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'team.json'), JSON.stringify({ initialized: true, baseBranch: 'main', review }));
  return { projectDir, claudeDir, reviewDir: join(projectDir, '.agent-reviews', 'pr-42') };
}

export const viewFixture = (over = {}) => JSON.stringify({ ...JSON.parse(fixture('review-pr-view.json')), ...over });

/** Routes gh (et git : copie de travail sur la tête de la PR) d'une revue de la PR 42 ; `extra` remplace ou ajoute. */
export const routes = (extra = {}) => ({
  ...gitRoutes(),
  [`gh pr view 42 --json ${VIEW_FIELDS}`]: { stdout: fixture('review-pr-view.json') },
  'gh api repos/{owner}/{repo}/pulls/42/comments --paginate': { stdout: JSON.parse(fixture('pulls-comments-pages.json')).map((p) => JSON.stringify(p)).join('') },
  'gh pr diff 42': { stdout: fixture('review-diff.patch') },
  'gh api user': { stdout: fixture('review-user.json') },
  [`gh pr list --json ${LIST_FIELDS}`]: { stdout: fixture('review-pr-list.json') },
  'gh pr view 42 --json headRefOid,state': { stdout: JSON.stringify({ headRefOid: SHA, state: 'OPEN' }) },
  ...extra,
});

/** Projet avec un round 1 relevé (pr.json, diff.patch, scope.json, review.json). */
export function fetched(opts = {}) {
  const project = makeReviewProject(opts);
  const out = prFetch({ number: 42, claudeDir: project.claudeDir, exec: fakeExec(routes(opts.routes)).exec, now: NOW });
  if (out.code !== 1) throw new Error(`pr-fetch : ${out.message}`);
  return project;
}

/** Constat d'un relecteur, ancré sur une ligne ajoutée de src/export.js (fixture review-diff.patch). */
export const finding = (over = {}) => ({
  id: 'B1', severity: 'major', kind: 'defect', file: 'src/export.js', line: 12, endLine: 12,
  snippet: "  const lines = rows.map((r) => Object.values(r).join(','));",
  title: 'Les virgules dans un champ ne sont pas échappées',
  problem: 'Un champ contenant une virgule est coupé en deux colonnes.',
  scenario: "toCsv([{ nom: 'Dupont, Jean' }]) produit trois colonnes.",
  fix: 'Entourer de guillemets les champs contenant une virgule.',
  proof: 'read', evidence: "src/export.js:12 : join(',') sans échappement.", regression: false,
  comment: 'Un champ qui contient une virgule est coupé en deux colonnes. Il faudrait l\'entourer de guillemets.',
  suggestion: null, ...over,
});

export const reviewerDeliverable = (axis = 'backend', findings = [finding()], over = {}) => ({
  agent: `cc-pr-reviewer-${axis}`, run: null, status: 'ready', questions: [], review: 'pr-42', round: 1, axis,
  findings, checked: ['En-tête du CSV vérifié.'], notReviewed: [], ...over,
});

export const verifierDeliverable = (verdicts, over = {}) => ({
  agent: 'cc-pr-verifier', run: null, status: 'ready', questions: [], review: 'pr-42', round: 1, verdicts, ...over,
});

/** Écrit un livrable dans rounds/<round>/deliverables/ comme le fait le hook check-deliverable. */
export function writeDeliverable(reviewDir, data) {
  const dir = join(reviewDir, 'rounds', String(data.round), 'deliverables');
  mkdirSync(dir, { recursive: true });
  const n = String(readdirSync(dir).length + 1).padStart(3, '0');
  writeFileSync(join(dir, `${n}-${data.agent}.json`), `${JSON.stringify(data, null, 2)}\n`);
}

export const readReview = (reviewDir) => JSON.parse(readFileSync(join(reviewDir, 'review.json'), 'utf8'));
export const reviewText = (reviewDir) => readFileSync(join(reviewDir, 'review.json'), 'utf8');
