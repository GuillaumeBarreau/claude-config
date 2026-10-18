#!/usr/bin/env node
// Traite les issues GitHub prêtes pour l'équipe d'agents : une issue = un run /team
// lancé par `claude -p` dans un worktree jetable, hors du dépôt. À lancer depuis un
// terminal ou un planificateur (cron, Planificateur de tâches, GitHub Actions), jamais
// depuis une session Claude Code.
//
// Usage (depuis la racine du projet) :
//   node .claude/skills/team-backlog/scripts/backlog.mjs --dry-run [--limit N] [--issue n]
//   node .claude/skills/team-backlog/scripts/backlog.mjs --yes [--limit N] [--issue n]
//
// --dry-run : liste ce qui serait fait. Seulement des lectures gh (repo view, api GET).
// --yes     : mode réel (coûte des appels API) ; refusé si CLAUDECODE est défini.
//
// Issues lues par ordre d'ancienneté (sort=created&direction=asc, 50 au plus). Retenues :
// ouvertes, portant backlog.label (défaut agent-ready), sans agent-working, créées par un
// auteur autorisé (prComments.allowedAssociations), prêtes (trois rubriques du modèle
// d'issue) et débloquées (aucune « Dépend de #n » ouverte, pas de cycle), dans l'ordre de
// next-issue.mjs (orderIssues : backlog.priorityLabels, puis ancienneté), jusqu'à la limite.
// Écartées avec leur raison dans report.skipped. Dépendances lues par gh api GET (20 au
// plus) ; avertissements (dépendance inconnue ou illisible) dans report.warnings, bornés
// comme next-issue.mjs (5 par issue, 20 au total, report.warningsOmitted).
// --yes, issue non prête : commentaire fait de constantes (rubriques manquantes, marche à
// suivre), agent-needs-info à la place du label, outcome not_ready ; hors limite, ni
// git fetch, ni worktree, ni claude. Dépendance ouverte ou cycle : aucune écriture.
// Pour chaque issue retenue :
//   label agent-working → git worktree add --detach <tmp>/claude-backlog/<repo>-<n>
//   origin/<base> → claude -p "/team Issue #n : <titre>…" (texte par stdin) → lecture
//   du state.json → décision (decideOutcome) → commentaire et label de résultat.
// Push et PR brouillon seulement si backlog.draftPr vaut true (défaut false) ET run
// prêt (contrôles et relecture validés, tâches done, aucune requiresHuman).
// Rapport : .agent-runs/backlog/<horodatage>.json.
// Avant tout appel gh : baseBranch doit respecter [A-Za-z0-9][A-Za-z0-9._/-]*, puis
// .claude/team.json doit exister et être initialisé sur origin/<base> (git show). En
// --yes, git fetch origin <base> le précède ; en --dry-run, pas de fetch : la référence
// locale origin/<base> est lue telle quelle.
// Sortie : 0 ; 1 si une issue a échoué en cours de traitement ; 2 refus ou erreur de
// configuration (CLAUDECODE, team.json local ou sur origin/<base>, baseBranch, gh
// indisponible, arguments).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkState } from '../../team/scripts/check-state.mjs';
import {
  DEFAULT_PRIORITY_LABELS, MAX_BODY, orderIssues, READY_SECTIONS, resolveDependencyStates, retainedBody,
} from './issue-queue.mjs';

export { MAX_BODY };

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MAX_TITLE = 200;
const MAX_QUESTIONS = 10;
const MAX_WARNINGS_PER_ISSUE = 5;
const MAX_WARNINGS = 20;
const CLAUDE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_TURNS = 300;
export const DEFAULTS = { label: 'agent-ready', draftPr: false, maxIssues: 3, maxBudgetUsd: 5 };
const DEFAULT_BRANCH_PREFIX = 'team/';
const DEFAULT_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];
export const LABELS = {
  working: 'agent-working',
  pr: 'agent-pr',
  needsInfo: 'agent-needs-info',
  needsApproval: 'agent-needs-approval',
  blocked: 'agent-blocked',
};
const LABEL_DESCRIPTIONS = {
  [LABELS.working]: ['fbca04', 'Run /team en cours'],
  [LABELS.pr]: ['0e8a16', 'PR brouillon ouverte par l\'équipe d\'agents'],
  [LABELS.needsInfo]: ['d876e3', 'L\'équipe d\'agents attend des réponses'],
  [LABELS.needsApproval]: ['1d76db', 'Plan ou livraison à valider par un humain'],
  [LABELS.blocked]: ['b60205', 'Run /team bloqué'],
};

/** Labels de priorité valides (liste non vide de textes non vides, sans doublon), espaces retirées ; sinon null. */
function validPriorityLabels(value) {
  if (!Array.isArray(value) || !value.length || !value.every((l) => typeof l === 'string' && l.trim())) return null;
  const labels = value.map((l) => l.trim());
  return new Set(labels).size === labels.length ? labels : null;
}

/** Clés backlog de team.json, avec les valeurs par défaut. */
export function backlogConfig(team) {
  const b = team?.backlog ?? {};
  const assoc = team?.prComments?.allowedAssociations;
  return {
    label: typeof b.label === 'string' && b.label.trim() ? b.label.trim() : DEFAULTS.label,
    draftPr: b.draftPr === true,
    maxIssues: Number.isInteger(b.maxIssues) && b.maxIssues > 0 ? b.maxIssues : DEFAULTS.maxIssues,
    maxBudgetUsd: typeof b.maxBudgetUsd === 'number' && b.maxBudgetUsd > 0 ? b.maxBudgetUsd : DEFAULTS.maxBudgetUsd,
    allowedAssociations: Array.isArray(assoc) && assoc.length ? assoc.map(String) : DEFAULT_ASSOCIATIONS,
    priorityLabels: validPriorityLabels(b.priorityLabels) ?? [...DEFAULT_PRIORITY_LABELS],
    baseBranch: typeof team?.baseBranch === 'string' && team.baseBranch ? team.baseBranch : 'main',
    branchPrefix: typeof team?.branchPrefix === 'string' && team.branchPrefix ? team.branchPrefix : DEFAULT_BRANCH_PREFIX,
  };
}

const CLEARED_CHECKS = ['passed', 'n/a'];
const BASE_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Pré-contrôle : le run part de origin/<base>, qui doit porter un team.json initialisé.
 * baseBranch est validée avant tout appel git (jamais une option). En mode réel, git fetch
 * met origin/<base> à jour ; en simulation, la référence locale est lue telle quelle.
 * @returns {string|null} cause du refus, ou null
 */
function remoteTeamProblem({ exec, config, projectDir, fetch }) {
  const base = config.baseBranch;
  if (!BASE_BRANCH_PATTERN.test(base)) {
    return `baseBranch « ${flat(base, 100)} » invalide dans .claude/team.json (attendu : ${BASE_BRANCH_PATTERN.source})`;
  }
  if (fetch) {
    const res = exec('git', ['fetch', 'origin', base], { cwd: projectDir });
    if (res.status !== 0) return `git fetch origin ${base} impossible — ${flat(res.stderr || `code ${res.status}`, 300)}`;
  }
  const show = exec('git', ['show', `origin/${base}:.claude/team.json`], { cwd: projectDir });
  if (show.status !== 0) {
    return `.claude/team.json absent de origin/${base} : commite et pousse un team.json initialisé (/team-init)${fetch ? '' : ' (référence locale, sans git fetch)'}`;
  }
  let remote;
  try {
    remote = JSON.parse(String(show.stdout ?? '').replace(/^﻿/, ''));
  } catch (err) {
    return `.claude/team.json illisible sur origin/${base} — ${flat(err.message, 200)}`;
  }
  if (remote?.initialized !== true) {
    return `.claude/team.json non initialisé sur origin/${base} : lance /team-init, commite et pousse`;
  }
  return null;
}

/**
 * Branche poussable ? state.branch est écrit par le modèle (influencé par l'issue) et
 * poussé hors de Claude Code, donc sans hook : motif conservateur, préfixe imposé.
 * @returns {string|null} raison du refus, ou null
 */
export function branchProblem(branch, prefix = DEFAULT_BRANCH_PREFIX) {
  if (typeof branch !== 'string' || !branch) return 'branche absente';
  const b = flat(branch, 200);
  if (/^[+-]/.test(branch) || branch.startsWith('refs/')) return `branche « ${b} » refusée (commence par +, - ou refs/)`;
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) return `branche « ${b} » refusée (caractères hors de [A-Za-z0-9._/-])`;
  if (branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.lock')
    || branch.endsWith('.') || /(^|\/)\./.test(branch)) return `branche « ${b} » refusée (nom de branche Git invalide)`;
  if (!branch.startsWith(prefix) || branch.length === prefix.length) return `branche « ${b} » refusée (préfixe attendu : ${prefix})`;
  return null;
}
const flat = (text, max) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/**
 * Borne les avertissements (ils viennent du texte des issues) : ceux de l'issue retenue
 * d'abord, au plus MAX_WARNINGS_PER_ISSUE par issue et MAX_WARNINGS au total. Même règle que
 * next-issue.mjs.
 * @returns {{ warnings: { number, message }[], warningsOmitted: number }}
 */
function limitWarnings(all, chosenNumber) {
  const ordered = [...all.filter((w) => w.number === chosenNumber), ...all.filter((w) => w.number !== chosenNumber)];
  const perIssue = new Map();
  const warnings = [];
  for (const w of ordered) {
    const count = perIssue.get(w.number) ?? 0;
    if (count >= MAX_WARNINGS_PER_ISSUE || warnings.length >= MAX_WARNINGS) continue;
    perIssue.set(w.number, count + 1);
    warnings.push(w);
  }
  return { warnings, warningsOmitted: all.length - warnings.length };
}

/**
 * Décision pure à partir du state.json du run.
 * @returns {{ outcome: 'pr'|'needs_info'|'needs_approval'|'blocked', label, reason, questions? }}
 */
export function decideOutcome(state, config) {
  const blocked = (reason) => ({ outcome: 'blocked', label: LABELS.blocked, reason });
  if (!state || typeof state !== 'object') return blocked('aucun run /team trouvé après l\'exécution');
  if (state.status === 'awaiting_input') {
    const questions = (Array.isArray(state.openQuestions) ? state.openQuestions : [])
      .map((q) => flat(typeof q === 'string' ? q : q?.text ?? q?.question ?? '', 500)).filter(Boolean).slice(0, MAX_QUESTIONS);
    return { outcome: 'needs_info', label: LABELS.needsInfo, reason: 'le run attend des réponses', questions };
  }
  if (state.status === 'awaiting_plan_approval') {
    return { outcome: 'needs_approval', label: LABELS.needsApproval, reason: 'le plan attend une validation humaine (porte 1)' };
  }
  if (state.status !== 'awaiting_delivery_approval') {
    return blocked(state.status === 'blocked' && state.blockedReason
      ? flat(state.blockedReason, 500) : `run arrêté au statut « ${state.status} »`);
  }

  // Prêt à livrer ? Chaque condition est vérifiée ici, pas déduite du statut.
  const problems = [];
  const tasks = Array.isArray(state.tasks) ? state.tasks.filter(Boolean) : [];
  const checks = Array.isArray(state.checks) ? state.checks.filter(Boolean) : [];
  if (state.gates?.checks?.status !== 'passed' || state.gates.checks.by !== 'run-checks') problems.push('contrôles non validés par run-checks');
  for (const c of checks.filter((c) => c.required && !CLEARED_CHECKS.includes(c.status))) problems.push(`contrôle ${c.name} : ${c.status}`);
  if (!checks.length) problems.push('aucun contrôle enregistré');
  if (state.gates?.review?.status !== 'passed') problems.push('relecture non validée');
  if (state.track !== 'quick' && !tasks.length) problems.push('aucune tâche');
  for (const t of tasks.filter((t) => t.status !== 'done')) problems.push(`tâche ${t.id} : ${t.status}`);
  for (const t of tasks.filter((t) => t.requiresHuman)) problems.push(`tâche ${t.id} requiresHuman`);
  if (!state.branch || state.branch === (state.baseBranch ?? config.baseBranch) || state.branch === config.baseBranch) {
    problems.push('pas de branche de travail distincte de la branche de base');
  }
  if (state.branch) {
    const bad = branchProblem(state.branch, config.branchPrefix ?? DEFAULT_BRANCH_PREFIX);
    if (bad) problems.push(bad);
  }
  const errors = checkState(state);
  if (errors.length) problems.push(`state.json invalide (${flat(errors[0], 200)})`);
  if (problems.length) return blocked(`livraison impossible : ${problems.join(' ; ')}`);
  if (config.draftPr !== true) {
    return {
      outcome: 'needs_approval',
      label: LABELS.needsApproval,
      reason: `run prêt, mais backlog.draftPr vaut false : la branche ${state.branch} reste locale, livraison à faire par un humain`,
    };
  }
  return { outcome: 'pr', label: LABELS.pr, reason: 'run prêt : PR brouillon ouverte' };
}

/** Prompt du run : le texte de l'issue est une donnée, limitée en taille. */
export function buildPrompt(issue) {
  const title = flat(issue.title, MAX_TITLE);
  let body = retainedBody(issue.body);
  if (String(issue.body ?? '').replace(/\r\n/g, '\n').trim().length > MAX_BODY) body += '\n[…corps de l\'issue tronqué]';
  return `/team Issue #${issue.number} : ${title}${body ? `\n\n${body}` : ''}`;
}

/** Sous Windows, `claude` installé par npm est un .cmd que spawn ne lance qu'avec le shell. */
export function resolveCommand(cmd, { platform = process.platform, where } = {}) {
  if (platform !== 'win32') return { file: cmd, shell: false };
  const res = (where ?? ((c) => spawnSync('where', [c], { encoding: 'utf8' })))(cmd);
  const found = String(res?.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const exe = found.find((f) => /\.exe$/i.test(f));
  if (exe) return { file: exe, shell: false };
  const script = found.find((f) => /\.(cmd|bat)$/i.test(f));
  return script ? { file: script, shell: true } : { file: cmd, shell: false };
}

const quoteForCmd = (arg) => (/^[\w./:=,-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`);
const resolved = new Map();

/** Exécuteur réel. Les arguments viennent du script ou de team.json, jamais d'une issue. */
export function defaultExec(cmd, args, opts = {}) {
  if (!resolved.has(cmd)) resolved.set(cmd, resolveCommand(cmd));
  const { file, shell } = resolved.get(cmd);
  const res = spawnSync(shell ? `"${file}"` : file, shell ? args.map(quoteForCmd) : args, {
    cwd: opts.cwd, input: opts.input, env: opts.env, timeout: opts.timeout, shell,
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  return { status: res.error ? null : res.status, stdout: res.stdout ?? '', stderr: `${res.stderr ?? ''}${res.error ? res.error.message : ''}` };
}

export function parseArgs(argv) {
  const args = { dryRun: false, yes: false, limit: null, issue: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--yes') args.yes = true;
    else if (a === '--limit' || a === '--issue') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`${a} attend un entier > 0`);
      args[a.slice(2)] = n;
    } else throw new Error(`argument inconnu : ${a}`);
  }
  if (args.dryRun && args.yes) throw new Error('--dry-run et --yes sont exclusifs');
  return args;
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));

/** Run le plus récent d'un projet (createdAt, puis nom). */
export function latestRun(dir) {
  const runsDir = join(dir, '.agent-runs');
  if (!existsSync(runsDir)) return null;
  const runs = readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'backlog')
    .flatMap((e) => {
      try {
        return [{ dir: join(runsDir, e.name), name: e.name, state: readJson(join(runsDir, e.name, 'state.json')) }];
      } catch {
        return [];
      }
    });
  runs.sort((a, b) => String(b.state.createdAt ?? '').localeCompare(String(a.state.createdAt ?? '')) || b.name.localeCompare(a.name));
  return runs[0] ?? null;
}

export function eligibility(issue, config, { requireLabel }) {
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name));
  if (issue.pull_request) return 'pull request, pas une issue';
  if (issue.state !== 'open') return `issue ${issue.state}`;
  if (labels.includes(LABELS.working)) return `déjà ${LABELS.working}`;
  if (requireLabel && !labels.includes(config.label)) return `sans le label ${config.label}`;
  if (!config.allowedAssociations.includes(issue.author_association)) {
    return `auteur ${issue.author_association} hors de ${config.allowedAssociations.join(', ')}`;
  }
  return null;
}

function claudeArgs(config, team) {
  const checks = (Array.isArray(team.checks) ? team.checks : []).map((c) => c?.command).filter((c) => typeof c === 'string' && c);
  const tools = [
    'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent', 'Skill', 'TodoWrite',
    'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git switch *)', 'Bash(git add *)',
    'Bash(git commit *)', 'Bash(git rev-parse *)', 'Bash(node .claude/skills/team/scripts/*)',
    ...checks.map((c) => `Bash(${c})`),
  ];
  return ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits',
    '--max-budget-usd', String(config.maxBudgetUsd), '--max-turns', String(MAX_TURNS), '--allowedTools', ...tools];
}

/**
 * Point d'entrée testable.
 * @param exec (cmd, args, { cwd, input, env, timeout }) → { status, stdout, stderr }
 * @returns {{ code, report }}
 */
export function runBacklog({ argv, exec = defaultExec, env = process.env, projectDir = PROJECT_DIR, tmpRoot = tmpdir(), now = () => new Date(), log = console.log, warn = console.error }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    warn(`erreur : ${err.message}`);
    return { code: 2, report: null };
  }
  if (!args.dryRun && !args.yes) {
    warn('Précise --dry-run (simulation) ou --yes (mode réel : lance claude et modifie les issues).');
    return { code: 2, report: null };
  }
  if (!args.dryRun && env.CLAUDECODE !== undefined) {
    warn('Refus : CLAUDECODE est défini (session Claude Code). Lance le mode réel depuis un terminal ou un planificateur.');
    return { code: 2, report: null };
  }
  let team;
  try {
    team = readJson(join(projectDir, '.claude', 'team.json'));
  } catch (err) {
    warn(`erreur : .claude/team.json illisible — ${err.message}`);
    return { code: 2, report: null };
  }
  if (team.initialized !== true) {
    warn('team.json non initialisé : lance /team-init d\'abord.');
    return { code: 2, report: null };
  }
  const config = backlogConfig(team);
  const limit = Math.min(args.limit ?? config.maxIssues, config.maxIssues);
  const gh = (ghArgs, opts = {}) => exec('gh', ghArgs, { cwd: projectDir, ...opts });

  const remoteProblem = remoteTeamProblem({ exec, config, projectDir, fetch: args.yes });
  if (remoteProblem) {
    warn(`erreur : ${remoteProblem}`);
    return { code: 2, report: null };
  }

  const repoRes = gh(['repo', 'view', '--json', 'name,nameWithOwner']);
  let repo;
  try {
    if (repoRes.status !== 0) throw new Error(repoRes.stderr || `code ${repoRes.status}`);
    repo = JSON.parse(repoRes.stdout);
  } catch (err) {
    warn(`erreur : gh indisponible ou non authentifié — ${flat(err.message, 300)}`);
    return { code: 2, report: null };
  }

  let candidates;
  try {
    const path = args.issue
      ? `repos/{owner}/{repo}/issues/${args.issue}`
      : `repos/{owner}/{repo}/issues?state=open&labels=${encodeURIComponent(config.label)}&sort=created&direction=asc&per_page=50`;
    const res = gh(['api', path]);
    if (res.status !== 0) throw new Error(res.stderr || `code ${res.status}`);
    const data = JSON.parse(res.stdout);
    candidates = Array.isArray(data) ? data : [data];
  } catch (err) {
    warn(`erreur : lecture des issues impossible — ${flat(err.message, 300)}`);
    return { code: 2, report: null };
  }

  const startedAt = now();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const reportDir = join(projectDir, '.agent-runs', 'backlog');
  const report = {
    startedAt: startedAt.toISOString(), dryRun: args.dryRun, repo: repo.nameWithOwner, label: config.label,
    draftPr: config.draftPr, maxBudgetUsd: config.maxBudgetUsd, issues: [], skipped: [],
  };
  const eligible = [];
  for (const issue of candidates) {
    const reason = eligibility(issue, config, { requireLabel: !args.issue });
    if (reason) report.skipped.push({ number: issue.number, reason });
    else eligible.push(issue);
  }

  // Prêtes, ordonnées, débloquées : même fonction que next-issue.mjs. Dépendances lues en GET.
  const fetchIssue = (n) => {
    const res = gh(['api', `repos/{owner}/{repo}/issues/${n}`]);
    if (res.status !== 0) return null;
    try {
      return JSON.parse(res.stdout);
    } catch {
      return null;
    }
  };
  const depStates = resolveDependencyStates(eligible, fetchIssue, { priorityLabels: config.priorityLabels });
  const { ready, skipped: held, warnings } = orderIssues(eligible, { priorityLabels: config.priorityLabels, depStates });
  const selected = [];
  for (const issue of ready) {
    if (selected.length < limit) selected.push(issue);
    else report.skipped.push({ number: issue.number, reason: `au-delà de la limite (${limit})` });
  }
  // En mode réel, seules les issues non prêtes reçoivent une réponse ; dépendances et cycles : rien.
  const notReady = args.yes ? held.filter((h) => h.kind === 'not_ready') : [];
  report.skipped.push(...held.filter((h) => !notReady.includes(h)).map(({ number, reason }) => ({ number, reason })));
  Object.assign(report, limitWarnings(warnings, selected[0]?.number ?? null));

  mkdirSync(reportDir, { recursive: true });
  const ctx = { exec, gh, env, config, team, repo, reportDir, stamp, tmpRoot, projectDir, labelsReady: false };
  let failed = false;
  for (const item of notReady) {
    const issue = eligible.find((i) => i.number === item.number);
    const entry = { number: issue.number, title: flat(issue.title, MAX_TITLE), url: issue.html_url ?? null };
    try {
      answerNotReady(issue, item, entry, ctx);
    } catch (err) {
      failed = true;
      entry.outcome = 'error';
      entry.reason = flat(err.message, 500);
    }
    report.issues.push(entry);
    log(`#${entry.number} ${entry.title} → ${entry.outcome}${entry.reason ? ` (${entry.reason})` : ''}`);
  }
  for (const issue of selected) {
    const entry = {
      number: issue.number,
      title: flat(issue.title, MAX_TITLE),
      url: issue.html_url ?? null,
      worktree: join(tmpRoot, 'claude-backlog', `${repo.name}-${issue.number}`),
    };
    if (args.dryRun) {
      entry.outcome = 'dry-run';
      entry.promptChars = buildPrompt(issue).length;
      entry.plan = [`label ${LABELS.working}`, `git worktree add --detach ${entry.worktree} origin/${config.baseBranch}`,
        `claude -p (budget ${config.maxBudgetUsd} $)`, config.draftPr ? 'PR brouillon si le run est prêt' : 'pas de PR (draftPr false)'];
    } else {
      try {
        processIssue(issue, entry, ctx);
      } catch (err) {
        failed = true;
        entry.outcome = 'error';
        entry.reason = flat(err.message, 500);
        safeLabel(ctx, issue.number, LABELS.blocked);
      }
    }
    report.issues.push(entry);
    log(`#${entry.number} ${entry.title} → ${entry.outcome}${entry.reason ? ` (${entry.reason})` : ''}`);
  }
  report.finishedAt = now().toISOString();
  const reportPath = join(reportDir, `${stamp}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  log(`${report.issues.length} issue(s) ${args.dryRun ? 'à traiter (simulation)' : 'traitée(s)'}, ${report.skipped.length} ignorée(s). Rapport : ${reportPath}`);
  return { code: failed ? 1 : 0, report };
}

const must = (res, what) => {
  if (res.status !== 0) throw new Error(`${what} : ${flat(res.stderr || `code ${res.status}`, 300)}`);
  return res;
};

function ensureLabels(ctx) {
  if (ctx.labelsReady) return;
  for (const [name, [color, description]] of Object.entries(LABEL_DESCRIPTIONS)) {
    ctx.gh(['label', 'create', name, '--color', color, '--description', description, '--force']);
  }
  ctx.labelsReady = true;
}

function safeLabel(ctx, number, label) {
  try {
    ctx.gh(['issue', 'edit', String(number), '--add-label', label, '--remove-label', LABELS.working]);
  } catch {
    // le rapport garde la trace de l'échec
  }
}

function comment(ctx, number, text) {
  const file = join(ctx.reportDir, `${ctx.stamp}-issue-${number}-comment.md`);
  writeFileSync(file, `${text}\n`);
  must(ctx.gh(['issue', 'comment', String(number), '--body-file', file]), 'commentaire');
}

/**
 * Issue non prête (mode réel) : commentaire fait de constantes (libellés des rubriques
 * manquantes et marche à suivre, jamais le texte de l'issue), puis agent-needs-info à la place
 * du label de déclenchement. Ni git fetch, ni worktree, ni claude.
 */
function answerNotReady(issue, item, entry, ctx) {
  const n = String(issue.number);
  const missing = READY_SECTIONS.map((s) => s.label).filter((label) => item.missing?.includes(label));
  entry.outcome = 'not_ready';
  entry.reason = `issue non prête : ${missing.join(', ')}`;
  ensureLabels(ctx);
  comment(ctx, n, [
    'Run automatique `/team` (claude-config) : **not_ready**. Cette issue n\'est pas prête, elle sera traitée une fois complétée.',
    '',
    'Rubriques manquantes ou vides (titres Markdown `##`) :',
    ...missing.map((label) => `- ${label}`),
    '',
    `Pour relancer : complète l'issue avec ces rubriques (modèle d'issue proposé par \`/team-init\`, \`.github/ISSUE_TEMPLATE/agent-ready.md\`), puis remets le label \`${ctx.config.label}\`.`,
  ].join('\n'));
  must(ctx.gh(['issue', 'edit', n, '--add-label', LABELS.needsInfo, '--remove-label', ctx.config.label]), 'labels de résultat');
}

/** Contrôles Git avant le push réel, en plus de branchProblem. */
function localBranchProblem(exec, branch, cwd) {
  if (exec('git', ['check-ref-format', '--branch', branch], { cwd }).status !== 0) {
    return `branche « ${flat(branch, 200)} » rejetée par git check-ref-format`;
  }
  if (exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd }).status !== 0) {
    return `branche « ${flat(branch, 200)} » absente du worktree (refs/heads)`;
  }
  return null;
}

function processIssue(issue, entry, ctx) {
  const { exec, gh, config, team } = ctx;
  const n = String(issue.number);
  if (existsSync(entry.worktree)) {
    entry.outcome = 'skipped';
    entry.reason = `worktree déjà présent (${entry.worktree}) : inspecte-le puis supprime-le avec git worktree remove`;
    return;
  }
  ensureLabels(ctx);
  must(gh(['issue', 'edit', n, '--add-label', LABELS.working]), `label ${LABELS.working}`);
  must(exec('git', ['fetch', 'origin', config.baseBranch], { cwd: ctx.projectDir }), 'git fetch');
  mkdirSync(dirname(entry.worktree), { recursive: true });
  must(exec('git', ['worktree', 'add', '--detach', entry.worktree, `origin/${config.baseBranch}`], { cwd: ctx.projectDir }), 'git worktree add');

  let decision;
  let wtTeam = null;
  try {
    wtTeam = readJson(join(entry.worktree, '.claude', 'team.json'));
  } catch {
    wtTeam = null;
  }
  if (wtTeam?.initialized !== true) {
    decision = { outcome: 'blocked', label: LABELS.blocked, reason: `.claude/team.json absent ou non initialisé sur origin/${config.baseBranch}` };
  } else {
    const res = exec('claude', claudeArgs(config, wtTeam ?? team), {
      cwd: entry.worktree, input: buildPrompt(issue), env: ctx.env, timeout: CLAUDE_TIMEOUT_MS,
    });
    writeFileSync(join(ctx.reportDir, `${ctx.stamp}-issue-${n}-claude.json`), res.stdout ?? '');
    try {
      const out = JSON.parse(res.stdout);
      entry.costUsd = out.total_cost_usd ?? null;
      entry.turns = out.num_turns ?? null;
    } catch {
      entry.costUsd = null;
    }
    entry.claudeExit = res.status;
    const run = latestRun(entry.worktree);
    entry.runId = run?.state?.id ?? null;
    entry.branch = run?.state?.branch ?? null;
    decision = decideOutcome(run?.state ?? null, config);
    if (decision.outcome === 'pr') {
      const bodyFile = join(run.dir, 'pr-body.md');
      if (!existsSync(bodyFile)) {
        decision = { outcome: 'needs_approval', label: LABELS.needsApproval, reason: 'run prêt mais pr-body.md absent : PR à ouvrir à la main' };
      } else {
        let title = `Issue #${n} : ${entry.title}`;
        try {
          const heading = readFileSync(join(run.dir, 'pr.md'), 'utf8').split(/\r?\n/).find((l) => /^# \S/.test(l));
          if (heading) title = flat(heading.slice(2), MAX_TITLE);
        } catch {
          // titre par défaut
        }
        const branch = run.state.branch;
        const refusal = localBranchProblem(exec, branch, entry.worktree);
        if (refusal) {
          decision = { outcome: 'blocked', label: LABELS.blocked, reason: `push refusé : ${refusal}` };
        } else {
          // Refspec explicite, sans + : ni force, ni autre branche distante que la sienne.
          must(exec('git', ['push', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { cwd: entry.worktree }), 'git push');
          const pr = must(gh(['pr', 'create', '--draft', '--base', config.baseBranch, '--head', branch,
            '--title', title, '--body-file', bodyFile], { cwd: entry.worktree }), 'gh pr create');
          entry.pr = flat(pr.stdout, 300).split(' ').pop();
        }
      }
    }
  }

  entry.outcome = decision.outcome;
  entry.reason = decision.reason;
  const lines = [`Run automatique \`/team\` (claude-config) : **${decision.outcome}**.`, '', decision.reason];
  if (entry.pr) lines.push('', `PR brouillon : ${entry.pr}`);
  if (decision.questions?.length) lines.push('', 'Questions :', ...decision.questions.map((q) => `- ${q}`));
  lines.push('', `Pour relancer : remettre le label \`${config.label}\`.`);
  comment(ctx, n, lines.join('\n'));
  must(gh(['issue', 'edit', n, '--add-label', decision.label, '--remove-label', LABELS.working,
    '--remove-label', config.label]), 'labels de résultat');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runBacklog({ argv: process.argv.slice(2) }).code);
}
