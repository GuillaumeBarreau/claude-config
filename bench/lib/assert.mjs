// Lecture du résultat d'un run du banc (collectRun) et comparaison aux attentes d'un
// scénario (evaluate). evaluate est une fonction pure : elle ne lit que l'objet run.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { checkState } from '../../template/.claude/skills/team/scripts/check-state.mjs';

/** Métadonnées écrites par prepare dans .git/ (hors de l'arbre de travail). */
export const META_FILE = 'claude-bench.json';
/** Sortie JSON de claude, enregistrée par run (dossier ignoré par Git). */
export const CLAUDE_RESULT = join('.agent-runs', 'bench-claude.json');

// --- Motifs de chemin : *, ** et ? (chemins en /). ---

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}
const matches = (path, glob) => globToRegExp(glob).test(path);

// --- evaluate ---

const KNOWN = {
  root: ['status', 'track', 'tasks', 'requiresHuman', 'checks', 'gates', 'git', 'files', 'questions', 'checkState', 'maxCostUsd'],
  git: ['baseUnchanged', 'pushed', 'commitsOnBranch', 'commitPerTask', 'changedFiles', 'noChanges'],
};
const STATE_KEYS = ['status', 'track', 'tasks', 'requiresHuman', 'checks', 'gates', 'questions', 'checkState'];
const NO_RUN = 'aucun run trouvé dans .agent-runs/';

const show = (v) => (Array.isArray(v) ? v.map((x) => `« ${x} »`).join(' ou ') : `« ${v} »`);
const oneOf = (value, expected) => (Array.isArray(expected) ? expected.includes(value) : value === expected);

function range(failures, label, count, { min, max } = {}, unit) {
  if (min !== undefined && count < min) failures.push(`${label} : ${count} ${unit}, minimum ${min}`);
  if (max !== undefined && count > max) failures.push(`${label} : ${count} ${unit}, maximum ${max}`);
}

function evaluateGit(run, expect, failures) {
  const git = run.git ?? {};
  const commits = git.commits ?? [];
  const changed = git.changedFiles ?? [];
  for (const key of Object.keys(expect)) {
    if (!KNOWN.git.includes(key)) failures.push(`attente inconnue : « git.${key} »`);
  }
  if (expect.baseUnchanged === true && git.baseHead !== git.initialBaseHead) {
    failures.push(`git.baseUnchanged : la branche de base « ${git.baseBranch} » a bougé (${git.initialBaseHead} → ${git.baseHead})`);
  }
  if (expect.pushed !== undefined && Boolean(git.pushed) !== expect.pushed) {
    failures.push(`git.pushed : attendu ${expect.pushed}, obtenu ${Boolean(git.pushed)}`);
  }
  if (expect.commitsOnBranch) {
    range(failures, 'git.commitsOnBranch', commits.length, expect.commitsOnBranch, `commit(s) sur ${git.runBranch}`);
  }
  if (expect.commitPerTask === true) {
    for (const task of (run.state?.tasks ?? []).filter((t) => t && t.status === 'done')) {
      if (!commits.some((c) => c.subject.includes(`(${task.id})`))) {
        failures.push(`git.commitPerTask : aucun commit « (${task.id}) » pour la tâche ${task.id}`);
      }
    }
  }
  if (expect.changedFiles) {
    for (const glob of expect.changedFiles.include ?? []) {
      if (!changed.some((f) => matches(f, glob))) {
        failures.push(`git.changedFiles : aucun fichier modifié ne correspond à « ${glob} » (modifiés : ${changed.join(', ') || 'aucun'})`);
      }
    }
    for (const glob of expect.changedFiles.exclude ?? []) {
      for (const f of changed.filter((p) => matches(p, glob))) {
        failures.push(`git.changedFiles : « ${f} » modifié alors qu'il est exclu (« ${glob} »)`);
      }
    }
  }
  if (expect.noChanges === true && (changed.length || commits.length)) {
    failures.push(`git.noChanges : ${changed.length} fichier(s) modifié(s) (${changed.join(', ') || 'aucun'}) et ${commits.length} commit(s)`);
  }
}

/**
 * Compare un run collecté aux attentes d'un scénario.
 * @returns {{ pass: boolean, failures: string[] }}
 */
export function evaluate(run, expect = {}) {
  const failures = [];
  const state = run.state;
  for (const key of Object.keys(expect)) {
    if (!KNOWN.root.includes(key)) failures.push(`attente inconnue : « ${key} »`);
  }
  if (!state) {
    for (const key of STATE_KEYS.filter((k) => k in expect)) failures.push(`${key} : ${NO_RUN}`);
  } else {
    const tasks = Array.isArray(state.tasks) ? state.tasks.filter(Boolean) : [];
    if ('status' in expect && !oneOf(state.status, expect.status)) {
      failures.push(`status : attendu ${show(expect.status)}, obtenu « ${state.status} »`);
    }
    if ('track' in expect && !oneOf(state.track, expect.track)) {
      failures.push(`track : attendu ${show(expect.track)}, obtenu « ${state.track} »`);
    }
    if (expect.tasks) {
      range(failures, 'tasks', tasks.length, expect.tasks, 'tâche(s)');
      if (expect.tasks.allStatus) {
        for (const t of tasks.filter((x) => !oneOf(x.status, expect.tasks.allStatus))) {
          failures.push(`tasks : ${t.id} est « ${t.status} », attendu ${show(expect.tasks.allStatus)}`);
        }
      }
    }
    if ('requiresHuman' in expect) {
      const flagged = tasks.filter((t) => t.requiresHuman === true).map((t) => t.id);
      if (expect.requiresHuman && !flagged.length) failures.push('requiresHuman : attendu au moins une tâche requiresHuman, aucune trouvée');
      if (!expect.requiresHuman && flagged.length) failures.push(`requiresHuman : attendu aucune tâche requiresHuman, trouvé ${flagged.join(', ')}`);
    }
    for (const [name, expected] of Object.entries(expect.checks ?? {})) {
      const check = (Array.isArray(state.checks) ? state.checks : []).find((c) => c && c.name === name);
      const actual = check ? check.status : 'absent';
      if (!oneOf(actual, expected)) failures.push(`checks.${name} : attendu ${show(expected)}, obtenu « ${actual} »`);
    }
    for (const [name, expected] of Object.entries(expect.gates ?? {})) {
      const actual = state.gates?.[name]?.status ?? 'absente';
      if (!oneOf(actual, expected)) failures.push(`gates.${name} : attendu ${show(expected)}, obtenu « ${actual} »`);
    }
    if (expect.questions) {
      const count = Array.isArray(state.openQuestions) ? state.openQuestions.length : 0;
      range(failures, 'questions', count, expect.questions, 'question(s) ouverte(s)');
    }
    if (expect.checkState === true) {
      for (const error of checkState(state, run.team ?? null)) failures.push(`checkState : ${error}`);
    }
  }
  for (const glob of expect.files ?? []) {
    if (!(run.runFiles ?? []).some((f) => matches(f, glob))) {
      failures.push(`files : aucun fichier du run ne correspond à « ${glob} »`);
    }
  }
  if (expect.git) evaluateGit(run, expect.git, failures);
  if (expect.maxCostUsd !== undefined) {
    const cost = run.claude?.total_cost_usd;
    if (typeof cost !== 'number') failures.push('maxCostUsd : coût inconnu (pas de résultat claude avec total_cost_usd)');
    else if (cost > expect.maxCostUsd) failures.push(`maxCostUsd : coût ${cost} $ > ${expect.maxCostUsd} $`);
  }
  return { pass: failures.length === 0, failures };
}

// --- collectRun ---

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
const tryJson = (file) => {
  try {
    return existsSync(file) ? readJson(file) : null;
  } catch {
    return null;
  }
};

/** Exécuteur git par défaut : renvoie stdout, ou null si la commande échoue. */
export function gitRunner(dir) {
  return (...args) => {
    try {
      return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
}

function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full, base);
    return [relative(base, full).split(sep).join('/')];
  });
}

/** Le run le plus récent de .agent-runs/ (createdAt, sinon date de state.json). */
function latestRun(dir) {
  const root = join(dir, '.agent-runs');
  if (!existsSync(root)) return null;
  const runs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'state.json')))
    .map((e) => {
      const file = join(root, e.name, 'state.json');
      const state = tryJson(file);
      const created = Date.parse(state?.createdAt ?? '');
      return { id: e.name, dir: join(root, e.name), state, at: Number.isNaN(created) ? statSync(file).mtimeMs : created };
    })
    .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
  return runs[0] ?? null;
}

/** Résumé de metrics.jsonl (lot B) ; null si le fichier n'existe pas. */
export function summarizeMetrics(file) {
  if (!existsSync(file)) return null;
  const summary = { agents: {}, turns: 0, rejected: 0, lines: 0 };
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    summary.lines++;
    if (entry.kind === 'turn') summary.turns++;
    else if (entry.kind === 'deliverable_rejected') summary.rejected++;
    else if (entry.kind === 'agent' && entry.agent) {
      const a = (summary.agents[entry.agent] ??= { calls: 0, durationMs: 0, tokens: 0 });
      a.calls++;
      a.durationMs += Number(entry.durationMs) || 0;
      a.tokens += Number(entry.tokens) || 0;
    }
  }
  return summary;
}

const lines = (text) => (text ? text.split(/\r?\n/).filter(Boolean) : []);

/**
 * Rassemble ce qu'un run a produit dans le projet d'essai : état du run le plus
 * récent, Git (branche, base, commits, fichiers modifiés, push), fichiers du run,
 * résultat de claude et mesures. Tolère les champs absents (anciens schémas).
 */
export function collectRun(dir, { git = gitRunner(dir) } = {}) {
  const meta = tryJson(join(dir, '.git', META_FILE)) ?? {};
  const latest = latestRun(dir);
  const state = latest?.state ?? null;
  const team = tryJson(join(dir, '.claude', 'team.json'));

  const baseBranch = (typeof state?.baseBranch === 'string' && state.baseBranch) || meta.baseBranch || team?.baseBranch || 'main';
  const currentBranch = git('branch', '--show-current') || null;
  const baseHead = git('rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}`);
  const initialBaseHead = meta.baseHead ?? baseHead;
  const branchExists = (b) => typeof b === 'string' && b && git('rev-parse', '--verify', '--quiet', `refs/heads/${b}`) !== null;
  const runBranch = branchExists(state?.branch) ? state.branch : currentBranch;

  let commits = [];
  if (initialBaseHead && branchExists(runBranch)) {
    commits = lines(git('log', '--format=%H%x09%s', `${initialBaseHead}..refs/heads/${runBranch}`))
      .map((l) => {
        const [sha, ...subject] = l.split('\t');
        return { sha, subject: subject.join('\t') };
      });
  }
  const changed = new Set();
  if (initialBaseHead && branchExists(runBranch)) {
    for (const f of lines(git('diff', '--name-only', initialBaseHead, `refs/heads/${runBranch}`))) changed.add(f);
  }
  for (const f of lines(git('diff', '--name-only', 'HEAD'))) changed.add(f);
  for (const f of lines(git('ls-files', '--others', '--exclude-standard'))) changed.add(f);
  const changedFiles = [...changed].filter((f) => !f.startsWith('.agent-runs/')).sort();

  const remoteBranches = lines(git('branch', '-r', '--format=%(refname:short)'));
  const pushed = remoteBranches.length > 0;

  return {
    dir,
    scenario: meta.scenario ?? null,
    runId: latest?.id ?? null,
    runDir: latest?.dir ?? null,
    state,
    team,
    runFiles: latest ? listFiles(latest.dir) : [],
    git: { currentBranch, baseBranch, initialBaseHead, baseHead, runBranch, commits, changedFiles, pushed, remoteBranches },
    claude: tryJson(join(dir, CLAUDE_RESULT)),
    metrics: latest ? summarizeMetrics(join(latest.dir, 'metrics.jsonl')) : null,
  };
}
